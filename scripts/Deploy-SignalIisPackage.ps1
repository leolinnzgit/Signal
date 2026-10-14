[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$package = Join-Path $repository 'iis-publish'
$site = [IO.Path]::GetFullPath('C:\sites\SignalHost')
& (Join-Path $repository 'work\deploy-signal-without-uac.ps1')

# Only obsolete, generated platform libraries are removed. App_Data and settings
# remain under the existing deployment's backup and preservation rules.
$dependencies = Get-Content -LiteralPath (Join-Path $site 'Signal.Server.deps.json') -Raw
$manifest = $dependencies | ConvertFrom-Json
if ($manifest.runtimeTarget.name -notlike '*/win-x64') {
    Write-Host 'Published a portable package; platform runtime cleanup was skipped.'
    return
}
if ((Get-FileHash -LiteralPath (Join-Path $site 'Signal.Server.dll')).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $package 'Signal.Server.dll')).Hash) { throw 'The deployed assembly differs from the package.' }
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $site 'runtimes'))
if ((Test-Path -LiteralPath $runtimeRoot) -and ((Get-Item -LiteralPath $runtimeRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Runtime cleanup cannot follow a redirected directory.'
}
$knownPlatforms = @('android-arm','android-arm64','android-x64','browser-wasm','ios-arm64','iossimulator-arm64','iossimulator-x64',
    'linux-arm','linux-arm64','linux-armel','linux-mips64','linux-musl-arm','linux-musl-arm64','linux-musl-riscv64','linux-musl-s390x',
    'linux-musl-x64','linux-ppc64le','linux-riscv64','linux-s390x','linux-x64','linux-x86','maccatalyst-arm64','maccatalyst-x64',
    'osx-arm64','osx-x64','win','win-arm64','win-x64','win-x86')
$removedBytes = 0L
foreach ($platform in $knownPlatforms) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $platform))
    if (-not $candidate.StartsWith($runtimeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A runtime cleanup path escaped the validated directory.'
    }
    if (Test-Path -LiteralPath (Join-Path $package ('runtimes\' + $platform))) { continue }
    if ($dependencies.Contains('runtimes/' + $platform + '/')) { continue }
    if (Test-Path -LiteralPath $candidate -PathType Container) {
        if ((Get-Item -LiteralPath $candidate).Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $removedBytes += (Get-ChildItem -LiteralPath $candidate -Recurse -File | Measure-Object Length -Sum).Sum
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
}
Write-Host ('Removed {0:N2} MiB of unused platform runtime files.' -f ($removedBytes / 1MB))

# Current assets stay available. A seven-day grace period also supports browsers
# still finishing playback or navigation with a previous release already open.
$assetRoot = [IO.Path]::GetFullPath((Join-Path $site 'wwwroot\assets'))
$packageAssets = Join-Path $package 'wwwroot\assets'
$removedAssetBytes = 0L
if (Test-Path -LiteralPath $assetRoot -PathType Container) {
    if ((Get-Item -LiteralPath $assetRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Asset cleanup cannot follow a redirected directory.'
    }
    foreach ($asset in Get-ChildItem -LiteralPath $assetRoot -File) {
        if ($asset.Name -notmatch '^index-[A-Za-z0-9_-]+\.(?:js|css)(?:\.(?:br|gz))?$' -or
            $asset.LastWriteTimeUtc -ge [datetime]::UtcNow.AddDays(-7) -or
            (Test-Path -LiteralPath (Join-Path $packageAssets $asset.Name))) { continue }
        $candidate = [IO.Path]::GetFullPath($asset.FullName)
        if (-not ([IO.Path]::GetDirectoryName($candidate)).Equals($assetRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'An asset cleanup path escaped the validated directory.'
        }
        $removedAssetBytes += $asset.Length
        Remove-Item -LiteralPath $candidate -Force
    }
}
Write-Host ('Removed {0:N2} MiB of obsolete frontend bundles.' -f ($removedAssetBytes / 1MB))
