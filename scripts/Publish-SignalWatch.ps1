[CmdletBinding()]
param([string]$WatchProject = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\SignalWatch'))
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$WatchProject = [IO.Path]::GetFullPath($WatchProject)
$source = Join-Path $repository 'public\signalwatch'
$site = [IO.Path]::GetFullPath('C:\sites\SignalHost')
$target = [IO.Path]::GetFullPath((Join-Path $site 'signalwatch'))
if ($target -ne 'C:\sites\SignalHost\signalwatch') { throw 'Unexpected publication target.' }
foreach ($directory in @($site, $target)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Publication cannot follow redirected directories.'
    }
}
$releaseDirectory = Join-Path $WatchProject 'outputs/play-release/0.2.0-3'
$manifest = Get-Content -LiteralPath (Join-Path $releaseDirectory 'release-manifest.json') -Raw | ConvertFrom-Json
$verification = Get-Content -LiteralPath (Join-Path $releaseDirectory 'verification.json') -Raw | ConvertFrom-Json
if ($verification.status -ne 'passed' -or $manifest.debuggable -ne $false) { throw 'Release artifact verification is required.' }
$apk = Join-Path $WatchProject 'app/build/outputs/apk/release/app-release.apk'
$debugApk = Join-Path $WatchProject 'app/build/outputs/apk/debug/app-debug.apk'
$hash = (Get-FileHash -LiteralPath $apk).Hash.ToLowerInvariant()
$recorded = $manifest.artifacts | Where-Object file -eq 'SignalWatch-0.2.0-3.apk'
if ($hash -ne $recorded.sha256) { throw 'The release APK differs from the checked artifact.' }
$protected = @('Signal.Server.dll', 'appsettings.json', 'appsettings.Production.json', 'appsettings.Development.json', 'web.config')
$before = @{}
foreach ($name in $protected) {
    $path = Join-Path $site $name
    if (Test-Path -LiteralPath $path) { $before[$name] = (Get-FileHash -LiteralPath $path).Hash }
}
Copy-Item -LiteralPath $apk -Destination (Join-Path $source 'SignalWatch-release.apk') -Force
Copy-Item -LiteralPath $debugApk -Destination (Join-Path $source 'SignalWatch-debug.apk') -Force
@{ version = $manifest.versionName; versionCode = $manifest.versionCode; build = 'release'; sha256 = $hash; file = 'SignalWatch-release.apk'; publishedAtUtc = [DateTime]::UtcNow.ToString('o'); intendedTrack = 'internal testing'; playStorePublished = $false } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $source 'release.json') -Encoding utf8
$files = @('index.html', 'SignalWatch-release.apk', 'SignalWatch-debug.apk', 'release.json', 'web.config', 'connect.html', 'connect.js', 'support.css', 'privacy.html', 'data-deletion.html')
$backup = Join-Path $repository ('work\signalwatch-backups\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $target, $backup | Out-Null
foreach ($name in $files) {
    $destination = Join-Path $target $name
    if (Test-Path -LiteralPath $destination) {
        if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Publication cannot replace redirected files.' }
        Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $name)
    }
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath (Join-Path $source $name)).Hash) { throw "Published hash mismatch: $name" }
}
foreach ($name in $before.Keys) {
    if ((Get-FileHash -LiteralPath (Join-Path $site $name)).Hash -ne $before[$name]) { throw "A protected production file changed: $name" }
}
Write-Host ('Published SignalWatch release candidate and support pages. APK SHA256: ' + $hash)
Write-Host 'Private keys and the Play upload bundle were not published. Production settings and App_Data were preserved.'
$global:LASTEXITCODE = 0
