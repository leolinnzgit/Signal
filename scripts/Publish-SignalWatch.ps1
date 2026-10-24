[CmdletBinding()]
param([string]$WatchProject, [switch]$NotificationPreview)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $WatchProject) { $WatchProject = Join-Path $repository '..\SignalWatch' }
$WatchProject = [IO.Path]::GetFullPath($WatchProject)
$source = Join-Path $repository 'public\signalwatch'
$supportSource = $source
if ($NotificationPreview) { $source = Join-Path $source 'native-preview' }
$site = [IO.Path]::GetFullPath('C:\sites\SignalHost')
$target = [IO.Path]::GetFullPath((Join-Path $site 'signalwatch'))
if ($NotificationPreview) { $target = Join-Path $target 'native-preview' }
$expectedTarget = if ($NotificationPreview) { 'C:\sites\SignalHost\signalwatch\native-preview' } else { 'C:\sites\SignalHost\signalwatch' }
if ($target -ne $expectedTarget) { throw 'Unexpected publication target.' }
foreach ($directory in @($site, (Join-Path $site 'signalwatch'), $target)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Publication cannot follow redirected directories.'
    }
}
$gradleFile = Get-Content -LiteralPath (Join-Path $WatchProject 'app/build.gradle.kts') -Raw
if ($gradleFile -notmatch 'versionCode\s*=\s*(\d+)') { throw 'The app versionCode was not found.' }
$versionCode = [int]$Matches[1]
$publishedManifest = Join-Path $target 'release.json'
if (Test-Path -LiteralPath $publishedManifest) {
    $publishedVersion = Get-Content -LiteralPath $publishedManifest -Raw | ConvertFrom-Json
    if ([int]$publishedVersion.versionCode -gt $versionCode) { throw 'A newer SignalWatch version is already published. Publication cannot downgrade it.' }
}
if ($gradleFile -notmatch 'versionName\s*=\s*"(\d+\.\d+\.\d+)"') { throw 'The app versionName was not found.' }
$versionName = $Matches[1]
$release = "$versionName-$versionCode"
$releaseDirectory = Join-Path $WatchProject "outputs/play-release/$release"
$manifest = Get-Content -LiteralPath (Join-Path $releaseDirectory 'release-manifest.json') -Raw | ConvertFrom-Json
$verification = Get-Content -LiteralPath (Join-Path $releaseDirectory 'verification.json') -Raw | ConvertFrom-Json
if ($verification.status -ne 'passed' -or $manifest.debuggable -ne $false) { throw 'Release artifact verification is required.' }
$apk = Join-Path $WatchProject 'app/build/outputs/apk/release/app-release.apk'
$debugApk = Join-Path $WatchProject 'app/build/outputs/apk/debug/app-debug.apk'
$hash = (Get-FileHash -LiteralPath $apk).Hash.ToLowerInvariant()
$recorded = $manifest.artifacts | Where-Object file -eq "SignalWatch-$release.apk"
if ($hash -ne $recorded.sha256) { throw 'The release APK differs from the checked artifact.' }
$protected = @('Signal.Server.dll', 'appsettings.json', 'appsettings.Production.json', 'appsettings.Development.json', 'web.config')
$before = @{}
foreach ($name in $protected) {
    $path = Join-Path $site $name
    if (Test-Path -LiteralPath $path) { $before[$name] = (Get-FileHash -LiteralPath $path).Hash }
}
Copy-Item -LiteralPath $apk -Destination (Join-Path $source 'SignalWatch-release.apk') -Force
if (-not $NotificationPreview) { Copy-Item -LiteralPath $debugApk -Destination (Join-Path $source 'SignalWatch-debug.apk') -Force }
$releaseInfo = @{ version = $manifest.versionName; versionCode = $manifest.versionCode; build = 'release'; sha256 = $hash; file = 'SignalWatch-release.apk'; publishedAtUtc = [DateTime]::UtcNow.ToString('o'); intendedTrack = 'internal testing'; playStorePublished = $false }
if ($NotificationPreview) {
    $phoneGradle = Get-Content -LiteralPath (Join-Path $WatchProject 'phone/build.gradle.kts') -Raw
    if ($phoneGradle -notmatch 'versionCode\s*=\s*(\d+)') { throw 'The companion versionCode was not found.' }
    $phoneCode = [int]$Matches[1]
    if ($phoneCode -ge $versionCode) { throw 'The phone companion must use a different, lower version code than this watch release.' }
    if ($phoneGradle -notmatch 'versionName\s*=\s*"(\d+\.\d+\.\d+)"') { throw 'The companion versionName was not found.' }
    $phoneVersion = $Matches[1]
    $phoneOutput = Join-Path $WatchProject "outputs/play-release/$phoneVersion-$phoneCode"
    $phoneManifest = Get-Content -LiteralPath (Join-Path $phoneOutput 'release-manifest.json') -Raw | ConvertFrom-Json
    $phoneCheck = Get-Content -LiteralPath (Join-Path $phoneOutput 'verification.json') -Raw | ConvertFrom-Json
    if ($phoneCheck.status -ne 'passed' -or $phoneManifest.debuggable -ne $false) { throw 'Companion release verification is required.' }
    $phoneApk = Join-Path $WatchProject 'phone/build/outputs/apk/release/phone-release.apk'
    $phoneHash = (Get-FileHash -LiteralPath $phoneApk).Hash.ToLowerInvariant()
    $phoneRecorded = $phoneManifest.artifacts | Where-Object file -eq "SignalCompanion-$phoneVersion-$phoneCode.apk"
    if ($phoneHash -ne $phoneRecorded.sha256) { throw 'The companion APK differs from its checked artifact.' }
    Copy-Item -LiteralPath $phoneApk -Destination (Join-Path $source 'SignalCompanion-release.apk') -Force
    $releaseInfo.companion = @{ version = $phoneVersion; versionCode = $phoneCode; sha256 = $phoneHash; file = 'SignalCompanion-release.apk' }
    $releaseInfo.channel = 'notification-preview'
}
$releaseInfo |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $source 'release.json') -Encoding utf8
$files = @('index.html', 'SignalWatch-release.apk', 'SignalWatch-debug.apk', 'release.json', 'web.config', 'connect.html', 'connect.js', 'support.css', 'privacy.html', 'data-deletion.html', 'promo-briefing.png', 'promo-saved.png')
if ($NotificationPreview) { $files = @('index.html', 'SignalWatch-release.apk', 'SignalCompanion-release.apk', 'release.json', 'web.config') }
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
if ($NotificationPreview) {
    foreach ($name in @('connect.js', 'support.css')) {
        $destination = Join-Path $site "signalwatch/$name"
        if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Support publication cannot follow redirected files.' }
        Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $name) -Force
        Copy-Item -LiteralPath (Join-Path $supportSource $name) -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath (Join-Path $supportSource $name)).Hash) { throw "Published support hash mismatch: $name" }
    }
}
Write-Host ('Published SignalWatch release candidate and support pages. APK SHA256: ' + $hash)
Write-Host 'Private keys and the Play upload bundle were not published. Production settings and App_Data were preserved.'
$global:LASTEXITCODE = 0
