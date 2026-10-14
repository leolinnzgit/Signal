[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$package = [IO.Path]::GetFullPath((Join-Path $repository 'iis-publish'))
$staging = [IO.Path]::GetFullPath((Join-Path $repository ('work\iis-stage-' + [guid]::NewGuid().ToString('N'))))
if (-not $package.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    -not $staging.StartsWith((Join-Path $repository 'work') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The generated IIS package paths must stay within this repository.'
}
try {
    # Use a fresh stage so portable native libraries cannot accumulate between builds.
    & dotnet publish (Join-Path $repository 'Signal.Server\Signal.Server.csproj') -c Release -r win-x64 --self-contained false -o $staging
    if ($LASTEXITCODE -ne 0) { throw 'The Windows IIS package build failed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $staging 'Signal.Server.dll'))) { throw 'The staged server assembly is missing.' }
    & robocopy.exe $staging $package /MIR /R:2 /W:1 /NFL /NDL /NP /XD (Join-Path $staging 'App_Data') (Join-Path $package 'App_Data') |
        Out-File -LiteralPath (Join-Path $repository 'work\iis-package-copy.log')
    if ($LASTEXITCODE -ge 8) { throw 'The generated IIS package copy failed.' }
    Write-Host 'Built a fresh Windows x64 IIS package.'
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
