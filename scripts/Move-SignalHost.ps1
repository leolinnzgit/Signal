[CmdletBinding()]
param([switch]$Elevated, [switch]$RetryIncompleteCopy)

$ErrorActionPreference = "Stop"
$sourcePath = [IO.Path]::GetFullPath("C:\inetpub\Signal")
$targetPath = [IO.Path]::GetFullPath("C:\sites\SignalHost")
$repositoryPath = Split-Path $PSScriptRoot -Parent
$resultPath = Join-Path $repositoryPath "work\host-migration-result.json"
$siteName = "Signal"
$appPoolName = "SignalAppPool"
$keepaliveName = "Signal IIS Keepalive"
$healthUrl = "https://localhost:8443/"
$changedPath = $false
$runtimeStopped = $false
$keepaliveDisabled = $false
$iisBackupName = $null
$verifiedFiles = 0
$phase = "Preflight"
$previousResult = if (Test-Path -LiteralPath $resultPath) {
    Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
} else { $null }

function Write-MigrationResult {
    param([bool]$Succeeded, [string]$Message, [string]$State)
    [pscustomobject]@{
        Succeeded = $Succeeded
        State = $State
        Phase = $phase
        Message = $Message
        Source = $sourcePath
        Destination = $targetPath
        SourceCode = $repositoryPath
        OriginalRuntimeRetained = Test-Path -LiteralPath $sourcePath
        VerifiedFiles = $verifiedFiles
        IisConfigurationBackup = $iisBackupName
        CompletedAt = [DateTimeOffset]::Now.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}

$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator -and -not $Elevated) {
    if (-not $RetryIncompleteCopy) { Write-MigrationResult $false "Waiting for Windows administrator access." "AwaitingAdministrator" }
    try {
        $windowsPowerShell = Join-Path $env:windir "System32\WindowsPowerShell\v1.0\powershell.exe"
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Elevated'
        if ($RetryIncompleteCopy) { $arguments += " -RetryIncompleteCopy" }
        $process = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        exit $process.ExitCode
    } catch {
        Write-MigrationResult $false $_.Exception.Message "Failed"
        throw
    }
}
if (-not $isAdministrator) {
    Write-MigrationResult $false "Windows administrator access is required to relocate the IIS application." "Failed"
    throw "Windows administrator access is required."
}

Add-Type -Path (Join-Path $env:windir "System32\inetsrv\Microsoft.Web.Administration.dll")

function Get-IisRuntime {
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $site = $manager.Sites[$siteName]
        if (-not $site) { throw "The Signal IIS website is missing." }
        $application = $site.Applications["/"]
        if (-not $application) { throw "The Signal IIS root application is missing." }
        $pool = $manager.ApplicationPools[$appPoolName]
        if (-not $pool) { throw "The Signal IIS application pool is missing." }
        [pscustomobject]@{
            PhysicalPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables(
                $application.VirtualDirectories["/"].PhysicalPath))
            SiteState = $site.State.ToString()
            PoolState = $pool.State.ToString()
        }
    } finally { $manager.Dispose() }
}

function Set-IisRuntimePath {
    param([string]$Path)
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $manager.Sites[$siteName].Applications["/"].VirtualDirectories["/"].PhysicalPath = $Path
        $manager.CommitChanges()
    } finally { $manager.Dispose() }
}

function Stop-SignalRuntime {
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        if ($manager.Sites[$siteName].State.ToString() -ne "Stopped") {
            $null = $manager.Sites[$siteName].Stop()
        }
        if ($manager.ApplicationPools[$appPoolName].State.ToString() -ne "Stopped") {
            $null = $manager.ApplicationPools[$appPoolName].Stop()
        }
    } finally { $manager.Dispose() }
    $deadline = (Get-Date).AddSeconds(45)
    do {
        $runtime = Get-IisRuntime
        if ($runtime.SiteState -eq "Stopped" -and $runtime.PoolState -eq "Stopped") {
            $released = $true
            foreach ($file in @("Signal.Server.dll", "App_Data\signal.db")) {
                $stream = $null
                try {
                    $stream = [IO.File]::Open((Join-Path $sourcePath $file), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
                } catch { $released = $false }
                finally { if ($stream) { $stream.Dispose() } }
            }
            if ($released) { return }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Signal did not stop cleanly within 45 seconds."
}

function Start-SignalRuntime {
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        if ($manager.ApplicationPools[$appPoolName].State.ToString() -eq "Stopped") {
            $null = $manager.ApplicationPools[$appPoolName].Start()
        }
        if ($manager.Sites[$siteName].State.ToString() -eq "Stopped") {
            $null = $manager.Sites[$siteName].Start()
        }
    } finally { $manager.Dispose() }
}

function Get-AccessRuleSignature {
    param([string]$Path)
    $rights = @{}
    foreach ($rule in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $key = "{0}|{1}|{2}|{3}" -f $rule.IdentityReference.Value, $rule.AccessControlType, $rule.InheritanceFlags, $rule.PropagationFlags
        if (-not $rights.ContainsKey($key)) { $rights[$key] = [long]0 }
        $rights[$key] = $rights[$key] -bor [long]$rule.FileSystemRights
    }
    return (($rights.Keys | Sort-Object | ForEach-Object { "{0}|{1}" -f $_, $rights[$_] }) -join ";")
}

function Test-SignalHealth {
    & (Join-Path $env:windir "System32\curl.exe") --ssl-no-revoke --insecure --fail --silent --output NUL --max-time 10 $healthUrl 2>$null
    return $LASTEXITCODE -eq 0
}

try {
    if (-not $targetPath.Equals("C:\sites\SignalHost", [StringComparison]::OrdinalIgnoreCase) -or
        -not $sourcePath.Equals("C:\inetpub\Signal", [StringComparison]::OrdinalIgnoreCase)) {
        throw "The migration paths do not match the intended Signal directories."
    }
    $runtime = Get-IisRuntime
    if ($runtime.PhysicalPath.Equals($targetPath, [StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-SignalHealth)) { throw "Signal already uses the target path but is unhealthy." }
        Write-MigrationResult $true "Signal already runs from the requested directory." "Completed"
        exit 0
    }
    if (-not $runtime.PhysicalPath.Equals($sourcePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "IIS does not point at the expected original Signal runtime."
    }
    if ($runtime.SiteState -ne "Started" -or $runtime.PoolState -ne "Started") {
        throw "The original Signal website and pool must be running before migration."
    }
    if (Test-Path -LiteralPath $targetPath) {
        if (-not $RetryIncompleteCopy -or -not $previousResult -or $previousResult.Succeeded -or
            $previousResult.Phase -ne "VerifyingRuntime" -or $previousResult.VerifiedFiles -lt 1 -or
            $previousResult.Source -ne $sourcePath -or $previousResult.Destination -ne $targetPath) {
            throw "The destination already exists; migration stopped without overwriting it."
        }
        if ((Get-Item -LiteralPath $targetPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "The incomplete copy is a reparse point."
        }
        if (Get-ChildItem -LiteralPath $targetPath -Recurse -Force | Where-Object {
            $_.Attributes -band [IO.FileAttributes]::ReparsePoint
        }) { throw "The incomplete copy contains a reparse point." }
        # Only remove this script's failed, verified copy at the explicitly selected target.
        if (-not [IO.Path]::GetFullPath($targetPath).Equals("C:\sites\SignalHost", [StringComparison]::OrdinalIgnoreCase)) {
            throw "The incomplete-copy cleanup target is invalid."
        }
        Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
    foreach ($path in @($sourcePath, (Split-Path $targetPath -Parent))) {
        if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "A migration directory is a reparse point."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "Signal.Server.dll")) -or
        -not (Test-Path -LiteralPath (Join-Path $sourcePath "App_Data\signal.db"))) {
        throw "The original Signal runtime or database is missing."
    }
    if (Test-Path -LiteralPath (Join-Path $sourcePath "app_offline.htm")) {
        throw "Signal is already in maintenance mode."
    }
    $entries = @(Get-ChildItem -LiteralPath $sourcePath -Recurse -Force)
    if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw "The runtime contains a reparse point; migration stopped."
    }
    $totalBytes = ($entries | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum
    if ((Get-PSDrive C).Free -lt ($totalBytes + 256MB)) { throw "There is insufficient free space on C:." }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $python) { throw "Python is required to verify the relocated SQLite database." }
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $site = $manager.Sites[$siteName]
        if ($site.Applications.Count -ne 1 -or $site.Applications["/"].VirtualDirectories.Count -ne 1 -or $site.Applications["/"].ApplicationPoolName -ne $appPoolName) {
            throw "Signal has additional IIS applications or virtual directories; migration stopped."
        }
        $otherApplications = @($manager.Sites | ForEach-Object {
            $currentSite = $_
            $_.Applications | Where-Object {
                $_.ApplicationPoolName -eq $appPoolName -and $currentSite.Name -ne $siteName
            }
        })
        if ($otherApplications.Count -gt 0) { throw "The Signal application pool is shared with another site." }
        foreach ($variable in $manager.ApplicationPools[$appPoolName].EnvironmentVariables) {
            if ($variable.Value.IndexOf($sourcePath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                throw "An IIS pool environment variable contains the original absolute runtime path."
            }
        }
    } finally { $manager.Dispose() }
    if (-not (Test-SignalHealth)) { throw "Signal is unhealthy before migration." }

    $iisBackupName = "SignalHost-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    & (Join-Path $env:windir "System32\inetsrv\appcmd.exe") add backup $iisBackupName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The IIS configuration backup failed." }

    $keepalive = Get-ScheduledTask -TaskName $keepaliveName -ErrorAction SilentlyContinue
    if ($keepalive) {
        if ($keepalive.Settings.Enabled) {
            Disable-ScheduledTask -TaskName $keepaliveName | Out-Null
            $keepaliveDisabled = $true
        }
        if ($keepalive.State.ToString() -eq "Running") {
            Stop-ScheduledTask -TaskName $keepaliveName
        }
    }
    $phase = "StoppingSignal"
    Write-MigrationResult $false "Stopping Signal for a consistent runtime copy." "InProgress"
    $runtimeStopped = $true
    Stop-SignalRuntime

    $phase = "CopyingRuntime"
    Write-MigrationResult $false "Copying runtime, private data, and access permissions." "InProgress"
    New-Item -ItemType Directory -Path $targetPath | Out-Null
    $rootAcl = Get-Acl -LiteralPath $sourcePath
    $rootAcl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $targetPath -AclObject $rootAcl
    & robocopy.exe $sourcePath $targetPath /E /COPY:DATS /DCOPY:DAT /SECFIX /B /XJ /R:2 /W:1 /NFL /NDL /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "The runtime copy failed with robocopy exit code $LASTEXITCODE." }
    Set-Acl -LiteralPath $targetPath -AclObject $rootAcl

    # Freeze the original key-folder rules so inheritance at the new parent cannot broaden them.
    $keyFolder = Join-Path $sourcePath "App_Data\DataProtectionKeys"
    if (Test-Path -LiteralPath $keyFolder) {
        $keyAcl = Get-Acl -LiteralPath $keyFolder
        $keyAcl.SetAccessRuleProtection($true, $true)
        Set-Acl -LiteralPath (Join-Path $targetPath "App_Data\DataProtectionKeys") -AclObject $keyAcl
    }

    $phase = "VerifyingRuntime"
    Write-MigrationResult $false "Verifying every copied file and private data permissions." "InProgress"
    $copyCheck = @"
import hashlib, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:3])
source_files = {p.relative_to(source): p for p in source.rglob('*') if p.is_file()}
target_files = {p.relative_to(target): p for p in target.rglob('*') if p.is_file()}
if source_files.keys() != target_files.keys():
    sys.exit(1)
for relative, original in source_files.items():
    with original.open('rb') as a, target_files[relative].open('rb') as b:
        if hashlib.file_digest(a, 'sha256').digest() != hashlib.file_digest(b, 'sha256').digest():
            sys.exit(1)
print(len(source_files))
"@
    $verification = @(& $python.Source -c $copyCheck $sourcePath $targetPath)
    if ($LASTEXITCODE -ne 0 -or $verification.Count -ne 1) {
        throw "The copied runtime failed file-count or SHA-256 verification."
    }
    $verifiedFiles = [int]$verification[0]

    foreach ($relativePath in @("App_Data", "App_Data\backups", "App_Data\DataProtectionKeys")) {
        $original = Join-Path $sourcePath $relativePath
        if (Test-Path -LiteralPath $original) {
            $copied = Join-Path $targetPath $relativePath
            $originalAcl = Get-AccessRuleSignature $original
            $copiedAcl = Get-AccessRuleSignature $copied
            if ($originalAcl -ne $copiedAcl) { throw "Private runtime data permissions were not preserved." }
        }
    }
    $databaseCheck = "import sqlite3,sys,pathlib; db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); rows=db.execute('PRAGMA quick_check').fetchall(); db.close(); sys.exit(0 if rows==[('ok',)] else 1)"
    & $python.Source -c $databaseCheck (Join-Path $targetPath "App_Data\signal.db")
    if ($LASTEXITCODE -ne 0) { throw "The copied SQLite database failed PRAGMA quick_check." }

    $phase = "SwitchingIis"
    Write-MigrationResult $false "Switching the Signal IIS physical path." "InProgress"
    $changedPath = $true
    Set-IisRuntimePath $targetPath
    Start-SignalRuntime
    $deadline = (Get-Date).AddSeconds(60)
    $healthy = $false
    do {
        if (Test-SignalHealth) { $healthy = $true; break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (-not $healthy) { throw "Signal failed its health check after relocation." }
    if (-not (Get-IisRuntime).PhysicalPath.Equals($targetPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "IIS did not retain the new physical path."
    }
    $phase = "Completed"
    Write-MigrationResult $true "Signal is healthy at the new runtime path. The original runtime remains as a rollback copy." "Completed"
} catch {
    $failure = $_.Exception.Message
    try {
        if ($changedPath) {
            Stop-SignalRuntime
            Set-IisRuntimePath $sourcePath
        }
        if ($runtimeStopped) { Start-SignalRuntime }
        if ($changedPath -and -not (Test-SignalHealth)) {
            $failure += " The original runtime was restored but its health check failed."
        }
    } catch { $failure += " Rollback error: " + $_.Exception.Message }
    Write-MigrationResult $false $failure "Failed"
    throw $failure
} finally {
    if ($keepaliveDisabled) { Enable-ScheduledTask -TaskName $keepaliveName | Out-Null }
}
