$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$fixture = Join-Path $repository ('work\weekly-cleanup-test-' + [guid]::NewGuid().ToString('N'))
$signal = Join-Path $fixture 'Signal'
$watch = $signal + 'Watch'
$state = Join-Path $fixture 'state'
$runner = Join-Path $repository 'scripts\Invoke-SignalWeeklyCleanup.ps1'
$global:SignalWeeklyCleanupTestProcesses = @()
function Get-CimInstance { [CmdletBinding()]param([string]$ClassName); $global:SignalWeeklyCleanupTestProcesses }
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Fixture([string]$Path, [string]$Content = 'fixture') {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    [IO.File]::WriteAllText($Path, $Content)
    return $Path
}
function Age-Fixture {
    foreach ($item in Get-ChildItem -LiteralPath $fixture -Recurse -Force | Where-Object { $_.FullName -notmatch '\\\.git(?:\\|$)' }) {
        $item.CreationTimeUtc = [datetime]::UtcNow.AddDays(-4)
        $item.LastWriteTimeUtc = [datetime]::UtcNow.AddDays(-4)
    }
}
function Run-Cleanup([switch]$Preview) {
    & $runner -Repository $signal -StateDirectory $state -WhatIf:$Preview -KeepLogs 2
}
try {
    Write-Fixture (Join-Path $signal 'Signal.Server\Signal.Server.csproj') | Out-Null
    Write-Fixture (Join-Path $signal '.gitignore') "bin/`nobj/`nwork/`nnode_modules/`nSignal.Server/wwwroot/" | Out-Null
    Write-Fixture (Join-Path $watch 'settings.gradle.kts') | Out-Null
    Write-Fixture (Join-Path $watch 'app\build.gradle.kts') | Out-Null
    Write-Fixture (Join-Path $watch 'phone\build.gradle.kts') | Out-Null
    Write-Fixture (Join-Path $watch '.gitignore') "**/build/`n.gradle/`n.kotlin/`noutputs/`n.signing/" | Out-Null
    foreach ($root in @($signal, $watch)) {
        & git -C $root init --quiet
        & git -C $root add .
        & git -C $root -c user.name=SignalTests -c user.email=tests@example.invalid commit --quiet -m fixture
        if ($LASTEXITCODE -ne 0) { throw 'Git fixture setup failed.' }
    }
    $generated = Write-Fixture (Join-Path $signal 'Signal.Server\bin\Debug\generated.dll')
    $watchBuild = Write-Fixture (Join-Path $watch 'app\build\intermediates\classes.dex')
    $phoneBuild = Write-Fixture (Join-Path $watch 'phone\build\intermediates\classes.dex')
    $cache = Write-Fixture (Join-Path $signal 'work\signalwatch-tools\gradle-home\caches\8.11.1\generated.jar')
    $dependencies = Write-Fixture (Join-Path $signal 'work\signalwatch-tools\gradle-home\caches\modules-2\dependency.jar')
    $sdk = Write-Fixture (Join-Path $signal 'work\signalwatch-tools\sdk\build-tools\tool.exe')
    $package = Write-Fixture (Join-Path $signal 'iis-publish\Signal.Server.dll')
    $release = Write-Fixture (Join-Path $watch 'outputs\release.apk')
    $key = Write-Fixture (Join-Path $watch '.signing\upload.p12')
    $database = Write-Fixture (Join-Path $signal 'Signal.Server\bin\Debug\App_Data\signal.db')
    $patch = Write-Fixture (Join-Path $signal 'Signal.Server\bin\Debug\unfinished.patch')
    $settings = Write-Fixture (Join-Path $signal 'Signal.Server\bin\Debug\appsettings.Production.json')
    $signingInBuild = Write-Fixture (Join-Path $watch 'app\build\upload.keystore')
    $tracked = Write-Fixture (Join-Path $signal 'Signal.Server\obj\keep.cs')
    & git -C $signal add -f Signal.Server/obj/keep.cs
    Age-Fixture
    $preview = Run-Cleanup -Preview
    Assert ($preview.Preview -and $preview.RemovedBytes -eq 0 -and (Test-Path -LiteralPath $generated)) 'Preview removed files.'
    $global:SignalWeeklyCleanupTestProcesses = @([pscustomobject]@{ Name = 'dotnet.exe'; ProcessId = 123; CommandLine = 'dotnet build' })
    Assert ((Run-Cleanup).Status -eq 'SkippedBusy' -and (Test-Path -LiteralPath $generated)) 'An active build was not skipped.'
    $global:SignalWeeklyCleanupTestProcesses = @([pscustomobject]@{ Name = 'pwsh.exe'; ProcessId = 123; CommandLine = 'Deploy-SignalIisPackage.ps1' })
    Assert ((Run-Cleanup).Status -eq 'SkippedBusy') 'An active deployment was not skipped.'
    $global:SignalWeeklyCleanupTestProcesses = @()
    $fresh = Write-Fixture (Join-Path $signal 'Signal.Server\obj\new\generated.cs')
    $copied = Write-Fixture (Join-Path $signal 'Signal.Server\obj\copied.dll')
    [IO.File]::SetLastWriteTimeUtc($copied, [datetime]::UtcNow.AddDays(-4))
    $external = Write-Fixture (Join-Path $fixture 'outside\keep.txt')
    $link = Join-Path $signal 'Signal.Server\bin\Debug\redirect'
    New-Item -ItemType Junction -Path $link -Target (Split-Path -Parent $external) | Out-Null
    $blocked = $false
    try { Run-Cleanup | Out-Null } catch { $blocked = $_.Exception.Message -like '*Redirected path*' }
    Assert ($blocked -and (Test-Path -LiteralPath $generated) -and (Test-Path -LiteralPath $external)) 'A link was followed or preflight deleted files.'
    [IO.Directory]::Delete($link, $false)
    $result = Run-Cleanup
    Assert ($result.Status -eq 'Completed' -and $result.RemovedBytes -gt 0) 'Cleanup did not complete.'
    foreach ($path in @($generated, $watchBuild, $phoneBuild, $cache)) { Assert (-not (Test-Path -LiteralPath $path)) "Generated artifact remained: $path" }
    foreach ($path in @($dependencies, $sdk, $package, $release, $key, $database, $patch, $settings, $signingInBuild, $tracked, $fresh, $copied, $external)) {
        Assert (Test-Path -LiteralPath $path) "Protected/recent content was deleted: $path"
    }
    Assert (@(Get-ChildItem -LiteralPath $state -Filter 'run-*.json').Count -eq 2) 'Log retention was not bounded.'
    $held = [IO.File]::Open((Join-Path $state 'cleanup.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try { Assert ((Run-Cleanup).Status -eq 'AlreadyRunning') 'Overlapping cleanup was allowed.' } finally { $held.Dispose() }
    # A missing Git executable or unavailable process inspection must fail before deletion.
    $blocked = $false
    try { & $runner -Repository $signal -StateDirectory $state -GitPath (Join-Path $fixture 'missing.exe') | Out-Null } catch { $blocked = $true }
    Assert $blocked 'An unavailable Git inventory was accepted.'
    function Get-CimInstance { [CmdletBinding()]param([string]$ClassName); throw 'Process inspection unavailable.' }
    $blocked = $false
    try { Run-Cleanup | Out-Null } catch { $blocked = $true }
    Assert ($blocked -and (Test-Path -LiteralPath $fresh)) 'Process inspection failure did not fail closed.'
    Write-Host 'Weekly cleanup passed preview, age limits, activity checks, tracked/data/signing preservation, link rejection, overlap prevention, log retention and failure handling.'
} finally {
    Remove-Variable -Name SignalWeeklyCleanupTestProcesses -Scope Global -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath (Join-Path $signal 'Signal.Server\bin\Debug\redirect')) {
        [IO.Directory]::Delete((Join-Path $signal 'Signal.Server\bin\Debug\redirect'), $false)
    }
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith((Join-Path $repository 'work') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
