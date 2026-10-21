[CmdletBinding()]
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$resultPath = Join-Path $repository 'work\public-watchdog-install-result.json'
$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
    if ($Elevated) { throw 'Administrator rights are required to install Signal recovery tasks.' }
    $installProcess = Start-Process -FilePath "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Verb RunAs -WindowStyle Hidden -PassThru -Wait `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"
    exit $installProcess.ExitCode
}

try {
    Import-Module ScheduledTasks
    $destination = Join-Path $env:ProgramData 'SignalPublicWatchdog'
    $scriptNames = @('Invoke-SignalPublicWatchdog.ps1', 'Invoke-SignalIisKeepalive.ps1')
    foreach ($name in $scriptNames) {
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "Missing $name." }
    }
    if (Test-Path -LiteralPath $destination) {
        if ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'The watchdog installation directory must not be redirected.'
        }
        foreach ($item in Get-ChildItem -LiteralPath $destination -Force -Recurse) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The watchdog directory contains a redirected item.' }
        }
    } else { New-Item -ItemType Directory -Path $destination | Out-Null }
    # SYSTEM must execute an administrator-owned copy, never a user-writable checkout.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $identity = New-Object Security.Principal.SecurityIdentifier($entry[0])
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $destination -AclObject $acl
    foreach ($name in $scriptNames) {
        $installedPath = Join-Path $destination $name
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $installedPath -Force
        $fileAcl = New-Object Security.AccessControl.FileSecurity
        $fileAcl.SetAccessRuleProtection($false, $false)
        $fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
        Set-Acl -LiteralPath $installedPath -AclObject $fileAcl
    }
    $tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe"
    & $tailscale set --unattended=true
    if ($LASTEXITCODE -ne 0) { throw 'Could not enable unattended Tailscale operation.' }
    Set-Service -Name Tailscale -StartupType Automatic

    $powerShell = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
    foreach ($definition in @(
        @{ Name = 'Signal IIS Keepalive'; Script = 'Invoke-SignalIisKeepalive.ps1'; Minutes = 5 },
        @{ Name = 'Signal Public Watchdog'; Script = 'Invoke-SignalPublicWatchdog.ps1'; Minutes = 1 }
    )) {
        $existing = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
        $backupPath = Join-Path $destination ($definition.Name.Replace(' ', '-') + '-before-install.xml')
        if ($existing -and -not (Test-Path -LiteralPath $backupPath)) {
            Export-ScheduledTask -TaskName $definition.Name | Set-Content -LiteralPath $backupPath -Encoding UTF8
        }
        $action = New-ScheduledTaskAction -Execute $powerShell -Argument (
            '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $destination $definition.Script) + '"')
        $periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes $definition.Minutes)
        $startup = New-ScheduledTaskTrigger -AtStartup
        $startup.Delay = 'PT1M'
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
        Register-ScheduledTask -TaskName $definition.Name -Action $action -Trigger @($periodic, $startup) `
            -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force `
            -Description 'Checks Signal availability and performs bounded recovery independently of user login and battery state.' | Out-Null
    }
    Start-ScheduledTask -TaskName 'Signal IIS Keepalive'
    Start-ScheduledTask -TaskName 'Signal Public Watchdog'
    [pscustomobject]@{
        Succeeded = $true; InstalledDirectory = $destination
        Tasks = @('Signal IIS Keepalive', 'Signal Public Watchdog')
        CompletedAt = [DateTimeOffset]::Now.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    [pscustomobject]@{ Succeeded = $false; Error = $_.Exception.Message; CompletedAt = [DateTimeOffset]::Now.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
