[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repository,
    [string]$StateDirectory = "$env:ProgramData\SignalWeeklyCleanup",
    [string]$GitPath = "$env:ProgramFiles\Git\cmd\git.exe",
    [ValidateRange(24, 8760)][int]$MinimumAgeHours = 48,
    [ValidateRange(2, 52)][int]$KeepLogs = 12
)

$ErrorActionPreference = 'Stop'
if (-not $Repository) { $Repository = Split-Path -Parent $PSScriptRoot }
$repositoryRoot = [IO.Path]::GetFullPath($Repository).TrimEnd('\')
$watchRoot = $repositoryRoot + 'Watch'
$stateRoot = [IO.Path]::GetFullPath($StateDirectory).TrimEnd('\')
$cutoff = [datetime]::UtcNow.AddHours(-$MinimumAgeHours)
$protectedName = '\.(?:(?:db|db3|sqlite|sqlite3)(?:-wal|-shm|-journal)?|bundle|patch|p12|pfx|jks|keystore|dpapi|pem|key)$'
$tracked = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$roots = [Collections.Generic.List[string]]::new()
$candidates = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$plan = [Collections.Generic.List[object]]::new()
$skipped = [Collections.Generic.List[object]]::new()
$removed = [Collections.Generic.List[object]]::new()

function Assert-NotRedirected([string]$Path) {
    $ancestor = [IO.Path]::GetFullPath($Path)
    while ($ancestor) {
        $attributes = 0
        try { $attributes = [IO.File]::GetAttributes($ancestor) }
        catch [IO.FileNotFoundException] { }
        catch [IO.DirectoryNotFoundException] { }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Redirected path is not eligible for cleanup: $ancestor"
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}
function Get-BusyReason {
    if ([IO.File]::Exists('C:\sites\SignalHost\app_offline.htm')) { return 'IIS publication is in progress.' }
    if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) {
        Import-Module (Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
    }
    # Fail closed if process inspection is unavailable. The IIS worker itself is allowed.
    foreach ($process in Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) {
        if ($process.Name -match '^(?:dotnet|MSBuild|java|javaw|javac)\.exe$' -or
            ($process.Name -match '^node\.exe$' -and $process.CommandLine -match '(?:npm-cli|npx-cli|vite|vinext|webpack|tsc|playwright.*test)') -or
            ($process.Name -match '^(?:powershell|pwsh|cmd)\.exe$' -and $process.CommandLine -match '(?:Deploy-Signal|Build-Signal|Publish-SignalWatch|Build-Release\.ps1|deploy-signal|gradlew)')) {
            return "Build or deployment process detected: $($process.Name) ($($process.ProcessId))."
        }
    }
}
function Add-TrackedFiles([string]$Root) {
    # Set safe.directory for this command only: the task runs as SYSTEM.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $GitPath
    $start.Arguments = '-c "safe.directory=' + $Root + '" -C "' + $Root + '" ls-files -z'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::Start($start)
    try {
        $output = $process.StandardOutput.ReadToEnd()
        $errorText = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Git inventory failed for ${Root}: $errorText" }
        foreach ($relative in $output.Split([char]0)) {
            if ($relative) { [void]$tracked.Add([IO.Path]::GetFullPath((Join-Path $Root $relative))) }
        }
    } finally { $process.Dispose() }
}
function Add-Candidate([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped the project.' }
    if ([IO.Directory]::Exists($full) -or [IO.File]::Exists($full)) { [void]$candidates.Add($full) }
}
function Find-BuildOutput([string]$Root) {
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    $excluded = @('.git', '.agents', '.codex', '.aws', '.wrangler', '.codex-remote-attachments', '.signing', 'App_Data', 'node_modules', 'outputs', 'iis-publish', 'public', 'db', 'drizzle',
        'sdk', 'gradle-home', 'android', 'android-home', 'bin', 'obj', 'build', '.gradle', '.kotlin', '.playwright')
    while ($pending.Count) {
        $directory = $pending.Pop()
        if ($directory -ne $Root -and ([IO.Directory]::Exists((Join-Path $directory '.git')) -or
            [IO.File]::Exists((Join-Path $directory '.git')))) { continue } # Keep independent repositories intact.
        if (@([IO.Directory]::GetFiles($directory, '*.csproj')).Count) {
            foreach ($name in @('bin', 'obj')) { Add-Candidate (Join-Path $directory $name) $Root }
        }
        if ([IO.File]::Exists((Join-Path $directory 'build.gradle.kts')) -or [IO.File]::Exists((Join-Path $directory 'build.gradle'))) {
            Add-Candidate (Join-Path $directory 'build') $Root
        }
        if ([IO.File]::Exists((Join-Path $directory 'settings.gradle.kts')) -or [IO.File]::Exists((Join-Path $directory 'settings.gradle'))) {
            foreach ($name in @('.gradle', '.kotlin')) { Add-Candidate (Join-Path $directory $name) $Root }
        }
        foreach ($child in [IO.Directory]::EnumerateDirectories($directory)) {
            $name = [IO.Path]::GetFileName($child)
            if ($name -in $excluded -or $name -match '^gradle-\d' -or
                ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint)) { continue }
            $pending.Push($child)
        }
    }
}
function Inspect-Candidate([string]$Path) {
    Assert-NotRedirected $Path
    $blocked = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    $bytes = 0L
    $newest = [datetime]::MinValue
    while ($pending.Count) {
        $entry = $pending.Pop()
        $attributes = [IO.File]::GetAttributes($entry)
        $isDirectory = [bool]($attributes -band [IO.FileAttributes]::Directory)
        $name = [IO.Path]::GetFileName($entry)
        # Gradle uses this empty directory as a Java package name, not a database.
        $emptyPackage = $isDirectory -and $name -eq 'androidx.sqlite.db' -and
            $entry -like '*\gradle-home\caches\*' -and -not @([IO.Directory]::EnumerateFileSystemEntries($entry)).Count
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or $tracked.Contains($entry) -or
            $name -in @('.git', '.signing', 'App_Data') -or ($name -match $protectedName -and -not $emptyPackage) -or
            $name -match '^(?:appsettings.*\.json|\.env.*|client_secret.*\.json|google-services\.json)$' -or
            $name -match '(?:credentials|secrets|service[-_]account).*\.json$') {
            $blocked.Add($entry)
            continue
        }
        $modified = [IO.File]::GetLastWriteTimeUtc($entry)
        $created = [IO.File]::GetCreationTimeUtc($entry)
        if ($created -gt $modified) { $modified = $created }
        if ($modified -gt $newest) { $newest = $modified }
        if ($isDirectory) {
            foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($entry)) { $pending.Push($child) }
        } else { $bytes += ([IO.FileInfo]$entry).Length }
    }
    [pscustomobject]@{ Path = $Path; Bytes = $bytes; Newest = $newest; Blocked = $blocked }
}
function Plan-Candidate([string]$Path) {
    $info = Inspect-Candidate $Path
    if ($info.Blocked.Count) {
        foreach ($blocked in $info.Blocked) { $skipped.Add([pscustomobject]@{ Path = $blocked; Reason = 'Protected content or link' }) }
        # Retain App_Data/configuration while clearing safe compiled siblings.
        if ($info.Blocked -contains $Path) { return }
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($Path)) { Plan-Candidate $child }
    } elseif ($info.Newest -ge $cutoff) {
        $skipped.Add([pscustomobject]@{ Path = $Path; Reason = "Written within the last $MinimumAgeHours hours" })
    } else { $plan.Add($info) }
}

$result = [ordered]@{ StartedAt = [DateTimeOffset]::Now.ToString('o'); Status = 'Running'; MinimumAgeHours = $MinimumAgeHours;
    RemovedBytes = 0L; Removed = @(); Skipped = @(); Preview = [bool]$WhatIfPreference }
$lock = $null
$failure = $null
try {
    foreach ($path in @($repositoryRoot, $watchRoot, $stateRoot, $GitPath)) {
        if ($path -match '["\r\n]') { throw 'Paths must not contain quotes or newlines.' }
        Assert-NotRedirected $path
    }
    if (-not [IO.File]::Exists((Join-Path $repositoryRoot 'Signal.Server\Signal.Server.csproj'))) { throw 'Not a Signal checkout.' }
    [void][IO.Directory]::CreateDirectory($stateRoot)
    $lockPath = Join-Path $stateRoot 'cleanup.lock'
    Assert-NotRedirected $lockPath
    try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { $result.Status = 'AlreadyRunning'; return [pscustomobject]$result }
    $busy = Get-BusyReason
    if ($busy) { $result.Status = 'SkippedBusy'; $result.Reason = $busy }
    else {
        $roots.Add($repositoryRoot)
        if ([IO.File]::Exists((Join-Path $watchRoot 'settings.gradle.kts'))) { $roots.Add($watchRoot) }
        foreach ($root in $roots) { Add-TrackedFiles $root; Find-BuildOutput $root }
        foreach ($relative in @('Signal.Server\wwwroot', 'node_modules\.vite', 'node_modules\.vite-temp',
            'work\__pycache__', 'scripts\__pycache__', 'work\npm-cache', 'work\comment-news-vite-cache',
            'work\header-vite-cache', 'work\briefing-market-vite-cache', 'work\search-vite-cache',
            'work\eye-gestures\qa-dist', 'work\hand-gestures\qa-dist')) {
            Add-Candidate (Join-Path $repositoryRoot $relative) $repositoryRoot
        }
        $gradleCaches = Join-Path $repositoryRoot 'work\signalwatch-tools\gradle-home\caches'
        if ([IO.Directory]::Exists($gradleCaches)) {
            Assert-NotRedirected $gradleCaches
            foreach ($version in [IO.Directory]::EnumerateDirectories($gradleCaches)) {
                if ([IO.Path]::GetFileName($version) -match '^\d+\.\d+(?:\.\d+)?$') { Add-Candidate $version $repositoryRoot }
            }
        }
        foreach ($path in $candidates) { Plan-Candidate $path }
        # Re-read Git before deletion. Any new tracked file is protected by the second inspection.
        foreach ($root in $roots) { Add-TrackedFiles $root }
        $result.Status = 'Completed'
        foreach ($candidate in $plan) {
            $busy = Get-BusyReason
            if ($busy) { $result.Status = 'SkippedBusy'; $result.Reason = $busy; break }
            $current = Inspect-Candidate $candidate.Path
            if ($current.Blocked.Count -or $current.Newest -ge $cutoff) {
                $skipped.Add([pscustomobject]@{ Path = $candidate.Path; Reason = 'Changed since planning' })
                continue
            }
            if ($PSCmdlet.ShouldProcess($candidate.Path, 'Remove old generated Signal build/cache files')) {
                # Validate the absolute scope immediately before every recursive deletion.
                if (-not @($roots | Where-Object { $candidate.Path.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) {
                    throw 'Deletion escaped the Signal projects.'
                }
                Assert-NotRedirected $candidate.Path
                Remove-Item -LiteralPath $candidate.Path -Recurse -Force
                $removed.Add([pscustomobject]@{ Path = $candidate.Path; Bytes = $current.Bytes })
                $result.RemovedBytes += $current.Bytes
            }
        }
        $result.PlannedBytes = ($plan | Measure-Object Bytes -Sum).Sum
    }
} catch { $failure = $_; $result.Status = 'Failed'; $result.Error = $_.Exception.Message }
finally {
    if ($lock) {
        try {
            $result.CompletedAt = [DateTimeOffset]::Now.ToString('o')
            $result.Removed = @($removed.ToArray())
            $result.Skipped = @($skipped.ToArray())
            $json = [pscustomobject]$result | ConvertTo-Json -Depth 6
            $history = Join-Path $stateRoot ('run-' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.json')
            $latest = Join-Path $stateRoot 'latest.json'
            Assert-NotRedirected $latest
            [IO.File]::WriteAllText($history, $json)
            [IO.File]::WriteAllText($latest, $json)
            foreach ($old in @(Get-ChildItem -LiteralPath $stateRoot -File -Filter 'run-*.json' | Sort-Object Name -Descending | Select-Object -Skip $KeepLogs)) {
                if ($old.Name -notmatch '^run-\d{8}-\d{6}-[a-f0-9]{32}\.json$') { continue }
                Assert-NotRedirected $old.FullName
                Remove-Item -LiteralPath $old.FullName -Force
            }
        } finally { $lock.Dispose() }
    }
}
if ($failure) { throw $failure }
[pscustomobject]$result
