param(
    [string]$SitePath = "C:\sites\SignalHost"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) { throw "The Signal IIS directory was not found at $SitePath." }
Write-Host "Configure Azure Maps for Signal Earthquake Visualizations." -ForegroundColor Cyan
Write-Host "Copy Primary Key (Key 1) from your Azure Maps resource's Authentication or Keys page."
Write-Host "The key is hidden and saved only in private IIS settings."

$secureKey = Read-Host "Azure Maps Subscription Key (Primary Key)" -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $mapsKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($mapsKey.Length -lt 20 -or $mapsKey.Length -gt 256 -or $mapsKey -match '\s') {
        throw "Copy the complete Azure Maps Primary Key (Key 1)."
    }
    try {
        $null = Invoke-RestMethod -Method Get -Uri "https://atlas.microsoft.com/search/address/json?api-version=1.0&query=test&subscription-key=$mapsKey" `
            -TimeoutSec 20 -MaximumRedirection 0
    } catch {
        throw "Azure could not validate the Azure Maps subscription key. Check the key on your Azure Maps Keys page. Private settings were not changed."
    }
    $configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }
    $configuration | Add-Member -NotePropertyName AzureMaps -NotePropertyValue ([pscustomobject]@{ SubscriptionKey = $mapsKey }) -Force
    $temporaryPath = "$configPath.tmp"
    [IO.File]::WriteAllText($temporaryPath, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    $webConfigPath = Join-Path $SitePath 'web.config'
    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) { (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date }
    Write-Host "Azure Maps is configured. Refresh Signal to view the live earthquake map visualization." -ForegroundColor Green
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $mapsKey = $null
    $secureKey = $null
}
