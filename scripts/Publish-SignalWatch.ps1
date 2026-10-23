[CmdletBinding()]
param(
    [string]$WatchProject = (Join-Path (Split-Path -Parent $PSScriptRoot) '..\SignalWatch')
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$source = Join-Path $repository 'public\signalwatch'
$site = [IO.Path]::GetFullPath('C:\sites\SignalHost')
$target = [IO.Path]::GetFullPath((Join-Path $site 'signalwatch'))
if ($target -ne 'C:\sites\SignalHost\signalwatch') { throw 'Unexpected publication target.' }
foreach ($directory in @($site, $target)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Publication cannot follow redirected directories.'
    }
}
$apk = Join-Path ([IO.Path]::GetFullPath($WatchProject)) 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw 'Build and check the SignalWatch APK before publication.' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'index.html'))) { throw 'The SignalWatch preview is missing.' }
$protected = @('Signal.Server.dll', 'appsettings.json', 'appsettings.Production.json', 'appsettings.Development.json', 'web.config')
$before = @{}
foreach ($name in $protected) {
    $path = Join-Path $site $name
    if (Test-Path -LiteralPath $path) { $before[$name] = (Get-FileHash -LiteralPath $path).Hash }
}
Copy-Item -LiteralPath $apk -Destination (Join-Path $source 'SignalWatch-debug.apk') -Force
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
@{ version = '0.1.0'; build = 'debug'; sha256 = $hash; file = 'SignalWatch-debug.apk'; publishedAtUtc = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $source 'release.json') -Encoding utf8
$files = @('index.html', 'SignalWatch-debug.apk', 'release.json', 'web.config')
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
Write-Host ('Published SignalWatch preview and development APK. SHA256: ' + $hash)
Write-Host 'Production server binaries and settings verified unchanged. App_Data was not part of publication.'
$global:LASTEXITCODE = 0
