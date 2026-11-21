[CmdletBinding()]
param(
    [string]$AppDataPath = 'C:\sites\SignalHost\App_Data'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$revision = '02af79985278377e65c724a76275707cb0333c70'
$base = "https://huggingface.co/Xenova/e5-small-v2/resolve/$revision"
$directory = Join-Path $AppDataPath 'cortex-news-model'
New-Item -ItemType Directory -Path $directory -Force | Out-Null

$files = @(
    @{ Name = 'model.onnx'; Source = 'onnx/model_quantized.onnx'; Hash = '7d9092cb25f2bd1c023b7e8d2aa459044a02030ac880e5a59fdaf27af69f1ded' },
    @{ Name = 'vocab.txt'; Source = 'vocab.txt'; Hash = '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' }
)
foreach ($file in $files) {
    $destination = Join-Path $directory $file.Name
    if ((Test-Path -LiteralPath $destination -PathType Leaf) -and
        (Get-FileHash -LiteralPath $destination).Hash -eq $file.Hash) { continue }
    $temporary = Join-Path $directory ($file.Name + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Invoke-WebRequest -Uri "$base/$($file.Source)" -OutFile $temporary -TimeoutSec 180 -UseBasicParsing
        if ((Get-FileHash -LiteralPath $temporary).Hash -ne $file.Hash) {
            throw "Checksum mismatch for $($file.Name)."
        }
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Write-Host "Cortex news model verified in $directory"
