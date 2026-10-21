[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$IncludeReleaseCopies)

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not (Test-Path -LiteralPath (Join-Path $repository 'Signal.Server\Signal.Server.csproj'))) {
    throw 'Run this script from a Signal checkout.'
}
$paths = @(
    'Signal.Server\bin', 'Signal.Server\obj', 'Signal.Server\wwwroot',
    'Signal.Server.TopicMatcher.Tests\bin', 'Signal.Server.TopicMatcher.Tests\obj',
    'Signal.GmailSetup\bin', 'Signal.GmailSetup\obj',
    'work\reader-probe\bin', 'work\reader-probe\obj',
    'work\stuff-reader-probe\bin', 'work\stuff-reader-probe\obj',
    'work\summary-live-check\bin', 'work\summary-live-check\obj',
    'work\shared-audio-scroll-package', 'work\stuff-reader-package',
    'work\npm-cache', 'work\comment-news-vite-cache', 'work\header-vite-cache',
    'work\eye-gestures\qa-dist', 'work\hand-gestures\qa-dist', 'work\__pycache__'
)
if ($IncludeReleaseCopies) {
    foreach ($item in Get-ChildItem -LiteralPath (Join-Path $repository 'work') -Force) {
        $commit = $null
        if ($item.PSIsContainer -and $item.Name -match '^.+-release-([a-f0-9]{7,40})$') { $commit = $Matches[1] }
        elseif (-not $item.PSIsContainer -and $item.Name -match '^.+-([a-f0-9]{7,40})\.(?:tar|zip)$') { $commit = $Matches[1] }
        if (-not $commit) { continue }
        & git -C $repository merge-base --is-ancestor $commit HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Release $($item.Name) is not recoverable from the current Git history." }
        $paths += 'work\' + $item.Name
    }
}

# Preflight every candidate before deleting anything. Never traverse a junction.
$plan = foreach ($relative in $paths) {
    $path = [IO.Path]::GetFullPath((Join-Path $repository $relative))
    if (-not $path.StartsWith($repository + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped the checkout.' }
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $parent = $path
    while (-not $parent.Equals($repository, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup path is redirected: $parent" }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    $tracked = @(& git -C $repository ls-files -- $relative)
    if ($LASTEXITCODE -ne 0 -or $tracked.Count) { throw "Cleanup candidate contains tracked files: $relative" }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($path)
    $links = [Collections.Generic.List[string]]::new()
    $bytes = 0L
    while ($pending.Count) {
        $entry = Get-Item -LiteralPath $pending.Pop() -Force
        if ($entry.Name -eq '.git' -or $entry.Name -match '\.(?:(?:db|db3|sqlite|sqlite3)(?:-wal|-shm|-journal)?|bundle|patch)$') {
            throw "Cleanup candidate contains data or work that must be preserved: $($entry.FullName)"
        }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $expectedLink = Join-Path $path 'node_modules'
            $target = [IO.Path]::GetFullPath([string](@($entry.Target)[0]))
            if (-not $entry.FullName.Equals($expectedLink, [StringComparison]::OrdinalIgnoreCase) -or
                -not $target.Equals((Join-Path $repository 'node_modules'), [StringComparison]::OrdinalIgnoreCase)) {
                throw "Cleanup candidate contains an unexpected link: $($entry.FullName)"
            }
            $links.Add($entry.FullName)
        } elseif ($entry.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) { $pending.Push($child.FullName) }
        } else { $bytes += $entry.Length }
    }
    [pscustomobject]@{ Path = $path; Bytes = $bytes; Links = $links }
}
foreach ($candidate in $plan) {
    $removed = $false
    if ($PSCmdlet.ShouldProcess($candidate.Path, 'Remove generated Signal build artifacts')) {
        foreach ($link in $candidate.Links) { [IO.Directory]::Delete($link, $false) }
        Remove-Item -LiteralPath $candidate.Path -Recurse -Force
        $removed = $true
    }
    [pscustomobject]@{ Path = $candidate.Path; Bytes = $candidate.Bytes; Removed = $removed }
}
