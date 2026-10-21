$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$fixture = [IO.Path]::GetFullPath((Join-Path $repository ('work\cleanup-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixture.StartsWith((Join-Path $repository 'work') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture path.' }
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Write-Fixture([string]$relative, [string]$text = 'fixture') {
    $path = Join-Path $fixture $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    Set-Content -LiteralPath $path -Value $text
    return $path
}
function Expect-Blocked([string]$message) {
    try { & $cleanup -IncludeReleaseCopies | Out-Null; throw 'Unsafe cleanup was accepted.' }
    catch { Assert ($_.Exception.Message -like $message) ('Unexpected cleanup error: ' + $_.Exception.Message) }
}
try {
    Write-Fixture 'Signal.Server\Signal.Server.csproj' | Out-Null
    Write-Fixture '.gitignore' "Signal.Server/bin/`nwork/`nnode_modules/" | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force | Out-Null
    $cleanup = Join-Path $fixture 'scripts\Clear-SignalBuildArtifacts.ps1'
    Copy-Item -LiteralPath (Join-Path $repository 'scripts\Clear-SignalBuildArtifacts.ps1') -Destination $cleanup
    & git -C $fixture init --quiet
    & git -C $fixture add .gitignore Signal.Server/Signal.Server.csproj
    & git -C $fixture -c user.name=SignalTests -c user.email=tests@example.invalid commit --quiet -m fixture
    if ($LASTEXITCODE -ne 0) { throw 'Fixture Git setup failed.' }
    $commit = (& git -C $fixture rev-parse --short HEAD).Trim()
    $generated = Write-Fixture 'Signal.Server\bin\generated.dll'
    $operational = Write-Fixture 'work\deploy-signal-without-uac.ps1'
    $patch = Write-Fixture 'work\unfinished.patch'
    $database = Write-Fixture 'Signal.Server\App_Data\signal.db'
    $package = Write-Fixture 'iis-publish\Signal.Server.dll'
    $dependency = Write-Fixture 'node_modules\bin\dependency.js'
    $preview = @(& $cleanup -WhatIf)
    Assert ((Test-Path -LiteralPath $generated) -and @($preview | Where-Object Removed).Count -eq 0) 'Preview deleted generated files.'
    foreach ($protectedName in @('signal.db', 'signal.sqlite3', 'signal.db-journal', 'unfinished.patch')) {
        $protected = Write-Fixture ('Signal.Server\bin\' + $protectedName)
        Expect-Blocked '*contains data or work*'
        Assert (Test-Path -LiteralPath $generated) 'Data protection ran after a deletion.'
        Remove-Item -LiteralPath $protected
    }
    $protected = Write-Fixture 'Signal.Server\bin\keep.cs'
    & git -C $fixture add -f Signal.Server/bin/keep.cs
    Expect-Blocked '*contains tracked files*'
    & git -C $fixture rm --cached --quiet Signal.Server/bin/keep.cs
    Remove-Item -LiteralPath $protected
    $redirectedParent = Join-Path $fixture 'work\reader-probe'
    New-Item -ItemType Junction -Path $redirectedParent -Target (Join-Path $fixture 'node_modules') | Out-Null
    Expect-Blocked '*path is redirected*'
    [IO.Directory]::Delete($redirectedParent, $false)
    Assert (Test-Path -LiteralPath $dependency) 'A redirected ancestor modified its target.'
    $release = Join-Path $fixture ('work\fixture-release-' + $commit)
    New-Item -ItemType Directory -Path $release | Out-Null
    $link = Join-Path $release 'node_modules'
    New-Item -ItemType Junction -Path $link -Target (Join-Path $fixture 'node_modules') | Out-Null
    Write-Fixture ('work\fixture-release-' + $commit + '\build.dll') | Out-Null
    $archive = Write-Fixture ('work\fixture-' + $commit + '.tar')
    & $cleanup -IncludeReleaseCopies | Out-Null
    Assert (-not (Test-Path -LiteralPath $generated) -and -not (Test-Path -LiteralPath $release) -and -not (Test-Path -LiteralPath $archive)) 'Generated files or recoverable release copies remained.'
    foreach ($path in @($operational, $patch, $database, $package, $dependency)) { Assert (Test-Path -LiteralPath $path) 'Cleanup removed preserved work, data, packages or dependencies.' }
    Write-Host 'Workspace cleanup passed preview, data and tracked-file protection, redirected ancestor rejection, release/archive removal and shared dependency preservation.'
} finally {
    foreach ($linkPath in @((Join-Path $fixture 'work\reader-probe'), (Join-Path $fixture ('work\fixture-release-' + $commit + '\node_modules')))) {
        if ((Test-Path -LiteralPath $linkPath) -and ((Get-Item -LiteralPath $linkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($linkPath, $false) }
    }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
