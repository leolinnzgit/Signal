[CmdletBinding()]
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$resultPath = Join-Path $repository 'work\weekly-cleanup-install-result.json'
$isAdministrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
    if ($Elevated) { throw 'Administrator rights are required to install the weekly cleanup task.' }
    $process = Start-Process -FilePath "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Verb RunAs -WindowStyle Hidden -PassThru -Wait `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"
    if ($process.ExitCode -ne 0) { throw "Weekly cleanup installation failed with exit code $($process.ExitCode)." }
    return
}

try {
    # Codex/PowerShell 7 can pass a module search path without Windows modules.
    Import-Module (Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1') -ErrorAction Stop
    $destination = Join-Path $env:ProgramData 'SignalWeeklyCleanup'
    $runner = Join-Path $PSScriptRoot 'Invoke-SignalWeeklyCleanup.ps1'
    $git = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf) -or -not (Test-Path -LiteralPath $git -PathType Leaf)) {
        throw 'The cleanup runner and installed Git executable are required.'
    }
    foreach ($path in @($destination, $repository, $git)) {
        if ($path -match '["\r\n]') { throw 'Installation paths must not contain quotes or newlines.' }
        $ancestor = $path
        while ($ancestor) {
            if ((Test-Path -LiteralPath $ancestor) -and
                ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "Installation cannot follow a redirected path: $ancestor"
            }
            $ancestor = [IO.Path]::GetDirectoryName($ancestor)
        }
    }
    if (Test-Path -LiteralPath $destination) {
        foreach ($item in Get-ChildItem -LiteralPath $destination -Force -Recurse) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The cleanup installation contains a link.' }
        }
    } else { New-Item -ItemType Directory -Path $destination | Out-Null }
    # SYSTEM executes an administrator-owned copy, never scripts from a writable checkout.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $identity = New-Object Security.Principal.SecurityIdentifier($entry[0])
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $identity, $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $destination -AclObject $acl
    $installed = Join-Path $destination 'Invoke-SignalWeeklyCleanup.ps1'
    Copy-Item -LiteralPath $runner -Destination $installed -Force
    $fileAcl = New-Object Security.AccessControl.FileSecurity
    $fileAcl.SetAccessRuleProtection($false, $false)
    $fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $installed -AclObject $fileAcl

    $taskName = 'Signal Weekly Cleanup'
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $backup = Join-Path $destination 'task-before-install.xml'
    if ($existing -and -not (Test-Path -LiteralPath $backup)) {
        Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $backup -Encoding UTF8
    }
    $firstRun = (Get-Date).Date.AddDays((7 - [int](Get-Date).DayOfWeek) % 7).AddHours(3)
    if ($firstRun -le (Get-Date)) { $firstRun = $firstRun.AddDays(7) }
    $action = New-ScheduledTaskAction -Execute "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $installed +
            '" -Repository "' + $repository + '" -StateDirectory "' + $destination + '" -GitPath "' + $git + '"')
    $trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At $firstRun
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
        -User 'SYSTEM' -RunLevel Highest -Force `
        -Description 'Weekly removal of old Signal/SignalWatch build output and caches; preserves data, source, releases, dependencies and the current IIS package.' | Out-Null
    [pscustomobject]@{ Succeeded = $true; Task = $taskName; FirstRun = $firstRun.ToString('o');
        TimeZone = (Get-TimeZone).Id; InstalledDirectory = $destination; CompletedAt = [DateTimeOffset]::Now.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    [pscustomobject]@{ Succeeded = $false; Error = $_.Exception.Message; CompletedAt = [DateTimeOffset]::Now.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
