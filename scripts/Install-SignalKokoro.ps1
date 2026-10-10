param(
    [string]$SitePath = "C:\sites\SignalHost",
    [string]$EnglishVoice = "bf_emma",
    [string]$ChineseVoice = "zf_xiaobei",
    [ValidateRange(1, 4)][int]$Threads = 4
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $SitePath 'Signal.Server.dll') -PathType Leaf)) {
    throw "Publish Signal to $SitePath before installing Kokoro."
}
$root = Join-Path $SitePath 'App_Data\Kokoro'
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
    $uv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) {
        throw 'Install uv from https://docs.astral.sh/uv/getting-started/installation/ and run this command again.'
    }
}
$assets = Join-Path $SitePath 'Speech'
if (-not (Test-Path -LiteralPath (Join-Path $assets 'kokoro_probe.py') -PathType Leaf)) {
    throw 'The published Kokoro support files are missing. Publish the updated Signal first.'
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
$cache = Join-Path $root 'SetupCache'
$managedPython = Join-Path $root 'python'
$venv = Join-Path $root 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
$oldCache = $env:UV_CACHE_DIR
$oldInstall = $env:UV_PYTHON_INSTALL_DIR
try {
    $env:UV_CACHE_DIR = $cache
    $env:UV_PYTHON_INSTALL_DIR = $managedPython
    Write-Host 'Installing local Kokoro voices. No speech account or API key is required.' -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($root)))
        if ($drive.AvailableFreeSpace -lt 1GB) { throw 'Kokoro setup needs at least 1 GB of free space on the site drive.' }
        & $uv python install 3.12.12
        if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
        & $uv venv $venv --python 3.12.12 --managed-python
        if ($LASTEXITCODE -ne 0) { throw 'The isolated Kokoro environment could not be created.' }
    }
    & $uv pip install --quiet --python $python -r (Join-Path $assets 'requirements-kokoro.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Kokoro package installation failed.' }
    $release = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/'
    $models = @(
        @{ Name = 'kokoro-v1.0.onnx'; Hash = 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a' },
        @{ Name = 'voices-v1.0.bin'; Hash = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' }
    )
    foreach ($model in $models) {
        $destination = Join-Path $root $model.Name
        if ((Test-Path -LiteralPath $destination -PathType Leaf) -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $model.Hash) { continue }
        Write-Host "Downloading $($model.Name)..."
        $download = "$destination.download"
        Invoke-WebRequest -Uri ($release + $model.Name) -OutFile $download -UseBasicParsing -TimeoutSec 1200
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $model.Hash) {
            throw 'The downloaded model failed its integrity check. Configuration was not changed.'
        }
        Move-Item -LiteralPath $download -Destination $destination -Force
    }
    Write-Host 'Checking English and Mandarin synthesis...'
    & $python -I (Join-Path $assets 'kokoro_probe.py') --root $root --english $EnglishVoice --chinese $ChineseVoice
    if ($LASTEXITCODE -ne 0) { throw 'Kokoro could not produce both recordings. Configuration was not changed.' }
    $configurationPath = Join-Path $SitePath 'appsettings.Production.json'
    $configuration = if (Test-Path -LiteralPath $configurationPath -PathType Leaf) {
        Get-Content -LiteralPath $configurationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }
    if (-not $configuration.Speech) { $configuration | Add-Member -NotePropertyName Speech -NotePropertyValue ([pscustomobject]@{}) -Force }
    foreach ($setting in @{
        Provider = 'Kokoro'; KokoroDirectory = $root; KokoroThreads = $Threads
        KokoroEnglishVoice = $EnglishVoice; KokoroChineseVoice = $ChineseVoice
    }.GetEnumerator()) {
        $configuration.Speech | Add-Member -NotePropertyName $setting.Key -NotePropertyValue $setting.Value -Force
    }
    $temporary = "$configurationPath.tmp"
    [IO.File]::WriteAllText($temporary, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $configurationPath -Force
    (Get-Item -LiteralPath (Join-Path $SitePath 'web.config')).LastWriteTime = Get-Date
    Write-Host 'Kokoro is configured. Signal is restarting.' -ForegroundColor Green
    Write-Host 'Refresh Signal, choose Recorded audio, then Preview voice. The first recording takes time; repeated text uses cached audio.'
} finally {
    $env:UV_CACHE_DIR = $oldCache
    $env:UV_PYTHON_INSTALL_DIR = $oldInstall
}
