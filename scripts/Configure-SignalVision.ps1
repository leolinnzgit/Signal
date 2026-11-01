param(
    [string]$Endpoint = "",
    [string]$SitePath = "C:\sites\SignalHost"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) { throw "The Signal IIS directory was not found at $SitePath." }
Write-Host "Configure Azure AI Vision (Image Descriptions, Smart Cropping & OCR) for Signal." -ForegroundColor Cyan
Write-Host "Copy the Endpoint and Key 1 from your Azure AI Vision or multi-service resource's Keys and Endpoint page."
Write-Host "The key is hidden and saved only in private IIS settings."

if ([string]::IsNullOrWhiteSpace($Endpoint)) { $Endpoint = Read-Host "Azure AI Vision endpoint (https://<resource>.cognitiveservices.azure.com/)" }
$Endpoint = $Endpoint.Trim().TrimEnd('/') + '/'
$visionUri = $null
if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$visionUri) -or $visionUri.Scheme -ne 'https' `
    -or -not $visionUri.IsDefaultPort -or $visionUri.UserInfo -or $visionUri.Query -or $visionUri.Fragment `
    -or $visionUri.AbsolutePath -ne '/' -or -not $visionUri.Host.EndsWith('.cognitiveservices.azure.com', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Use the HTTPS .cognitiveservices.azure.com endpoint of your Azure AI Vision resource."
}

$secureKey = Read-Host "Azure AI Vision Key 1" -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $visionKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($visionKey.Length -lt 20 -or $visionKey.Length -gt 256 -or $visionKey -match '\s') {
        throw "Copy the complete Azure AI Vision resource key."
    }

    # Build a minimal valid 64x64 24-bit BMP in memory (Vision 4.0 requires >= 50x50 pixels)
    $bmpBytes = New-Object byte[] (54 + 64 * 64 * 3)
    $bmpBytes[0] = 0x42; $bmpBytes[1] = 0x4D
    [BitConverter]::GetBytes([int]$bmpBytes.Length).CopyTo($bmpBytes, 2)
    [BitConverter]::GetBytes([int]54).CopyTo($bmpBytes, 10)
    [BitConverter]::GetBytes([int]40).CopyTo($bmpBytes, 14)
    [BitConverter]::GetBytes([int]64).CopyTo($bmpBytes, 18)
    [BitConverter]::GetBytes([int]64).CopyTo($bmpBytes, 22)
    [BitConverter]::GetBytes([uint16]1).CopyTo($bmpBytes, 26)
    [BitConverter]::GetBytes([uint16]24).CopyTo($bmpBytes, 28)
    [BitConverter]::GetBytes([int](64 * 64 * 3)).CopyTo($bmpBytes, 34)
    for ($i = 54; $i -lt $bmpBytes.Length; $i++) { $bmpBytes[$i] = 0xE8 }

    try {
        $null = Invoke-RestMethod -Method Post `
            -Uri ($Endpoint + 'computervision/imageanalysis:analyze?api-version=2023-10-01&features=smartCrops') `
            -ContentType 'application/octet-stream' `
            -Body $bmpBytes `
            -Headers @{ 'Ocp-Apim-Subscription-Key' = $visionKey } `
            -TimeoutSec 20 `
            -MaximumRedirection 0
    } catch {
        throw "Azure could not validate the Vision key and endpoint. Private settings were not changed."
    }

    $configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }

    $configuration | Add-Member -NotePropertyName AzureVision -NotePropertyValue ([pscustomobject]@{
        Endpoint = $Endpoint
        Key      = $visionKey
    }) -Force

    $temporaryPath = "$configPath.tmp"
    [IO.File]::WriteAllText($temporaryPath, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force

    $webConfigPath = Join-Path $SitePath 'web.config'
    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) { (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date }
    Write-Host "Azure AI Vision is configured. Refresh Signal to enable AI photo descriptions, smart focal cropping, and image OCR." -ForegroundColor Green
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $visionKey = $null
    $secureKey = $null
}
