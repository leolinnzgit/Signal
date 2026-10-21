$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $repository ('work\storage-deploy-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith((Join-Path $repository 'work') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The test fixture must remain in this repository.'
}
$package = Join-Path $fixtureRoot 'package'
$site = Join-Path $fixtureRoot 'site'
function Write-Fixture([string]$root, [string]$relative, [string]$text = 'fixture') {
    $path = Join-Path $root $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    Set-Content -LiteralPath $path -Value $text
    return $path
}
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
try {
    Write-Fixture $package 'Signal.Server.dll' | Out-Null
    Write-Fixture $site 'Signal.Server.dll' | Out-Null
    $manifest = Write-Fixture $site 'Signal.Server.deps.json' '{"runtimeTarget":{"name":".NETCoreApp,Version=v10.0/win-x64"},"keep":"runtimes/win-x64/native/needed.dll"}'
    $unused = Write-Fixture $site 'runtimes\linux-x64\native\old.so'
    $needed = Write-Fixture $site 'runtimes\win-x64\native\needed.dll'
    $packaged = Write-Fixture $site 'runtimes\win\needed.dll'
    Write-Fixture $package 'runtimes\win\needed.dll' | Out-Null
    $unknown = Write-Fixture $site 'runtimes\custom\user.dll'
    $data = Write-Fixture $site 'App_Data\signal.db'
    $settings = Write-Fixture $site 'appsettings.Production.json'
    $obsolete = Write-Fixture $site 'wwwroot\assets\index-Expired.js'
    $current = Write-Fixture $site 'wwwroot\assets\index-Current.css'
    Write-Fixture $package 'wwwroot\assets\index-Current.css' | Out-Null
    $recent = Write-Fixture $site 'wwwroot\assets\index-Recent.js.gz'
    $custom = Write-Fixture $site 'wwwroot\assets\user-script.js'
    foreach ($path in @($obsolete, $current, $custom)) { [IO.File]::SetLastWriteTimeUtc($path, [datetime]::UtcNow.AddDays(-8)) }
    $source = Get-Content -LiteralPath (Join-Path $repository 'scripts\Deploy-SignalIisPackage.ps1') -Raw
    $boundary = $source.IndexOf('# Only obsolete', [StringComparison]::Ordinal)
    Assert ($boundary -gt 0) 'The deploy cleanup section was not found.'
    # Exercise the actual cleanup against isolated files, without running IIS publication.
    $cleanup = [scriptblock]::Create($source.Substring($boundary))
    & $cleanup
    Assert (-not (Test-Path -LiteralPath $unused)) 'An unused platform runtime was retained.'
    Assert (-not (Test-Path -LiteralPath $obsolete)) 'An obsolete frontend bundle was retained.'
    foreach ($path in @($needed,$packaged,$unknown,$data,$settings,$current,$recent,$custom)) {
        Assert (Test-Path -LiteralPath $path) 'Cleanup removed a required, recent, or user-owned file.'
    }
    $unused = Write-Fixture $site 'runtimes\linux-x64\native\old.so'
    Set-Content -LiteralPath (Join-Path $site 'Signal.Server.dll') -Value 'mismatched assembly'
    try { & $cleanup; throw 'A mismatched package was accepted.' }
    catch { Assert ($_.Exception.Message -eq 'The deployed assembly differs from the package.') 'The cleanup failed for an unexpected reason.' }
    Assert (Test-Path -LiteralPath $unused) 'Cleanup ran before validating the deployed assembly.'
    Write-Fixture $site 'Signal.Server.dll' | Out-Null
    Set-Content -LiteralPath $manifest -Value '{"runtimeTarget":{"name":".NETCoreApp,Version=v10.0"}}'
    & $cleanup
    Assert (Test-Path -LiteralPath $unused) 'A portable deployment lost its platform libraries.'
    Write-Output 'IIS storage checks passed manifest/package protection, obsolete runtime and asset cleanup, grace period, data/settings preservation and portable-package compatibility.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
