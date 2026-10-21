param(
    [string]$Endpoint = "https://api.cognitive.microsofttranslator.com/",
    [string]$Region = "",
    [string]$SitePath = "C:\sites\SignalHost"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) { throw "The Signal IIS directory was not found." }
Write-Host "Configure Azure Translator for Signal Reader." -ForegroundColor Cyan
Write-Host "The key is hidden and saved only in private IIS settings."
$Endpoint = $Endpoint.Trim().TrimEnd('/') + '/'
$translatorUri = $null
$globalHosts = @('api.cognitive.microsofttranslator.com', 'api-nam.cognitive.microsofttranslator.com', 'api-eur.cognitive.microsofttranslator.com', 'api-apc.cognitive.microsofttranslator.com')
if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$translatorUri) -or $translatorUri.Scheme -ne 'https' `
    -or -not $translatorUri.IsDefaultPort -or $translatorUri.UserInfo -or $translatorUri.Query -or $translatorUri.Fragment `
    -or $translatorUri.AbsolutePath -ne '/' -or ($translatorUri.Host -notin $globalHosts -and -not $translatorUri.Host.EndsWith('.cognitiveservices.azure.com'))) {
    throw "Use the HTTPS Translator API endpoint or your Azure resource's base endpoint."
}
if ([string]::IsNullOrWhiteSpace($Region)) { $Region = Read-Host "Azure resource region (leave blank for a global Translator resource)" }
$Region = $Region.Trim().ToLowerInvariant()
if ($Region.Length -gt 64 -or $Region -match '[^a-z0-9-]') { throw "Use the region identifier shown on Azure's Keys and Endpoint page." }
$secureKey = Read-Host "Azure Translator Key 1" -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $translatorKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($translatorKey.Length -lt 20 -or $translatorKey.Length -gt 256 -or $translatorKey -match '[\s\p{C}]') { throw "Copy the complete Translator resource key." }
    $headers = @{ 'Ocp-Apim-Subscription-Key' = $translatorKey }
    if ($Region) { $headers['Ocp-Apim-Subscription-Region'] = $Region }
    $translationPath = if ($translatorUri.Host.EndsWith('.cognitiveservices.azure.com')) { 'translator/text/v3.0/translate' } else { 'translate' }
    try {
        $validation = Invoke-RestMethod -Method Post -Uri ($Endpoint + $translationPath + '?api-version=3.0&to=en') `
            -ContentType 'application/json; charset=utf-8' -Body '[{"Text":"Signal translation is ready."}]' -Headers $headers -TimeoutSec 20 -MaximumRedirection 0
        if (-not $validation[0].translations[0].text) { throw "Incomplete response." }
    } catch { throw "Azure could not validate the Translator key, region and endpoint. Private settings were not changed." }
    $configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }
    $configuration | Add-Member -NotePropertyName AzureTranslator -NotePropertyValue ([pscustomobject]@{ Endpoint = $Endpoint; Key = $translatorKey; Region = $Region }) -Force
    $temporaryPath = "$configPath.tmp"
    [IO.File]::WriteAllText($temporaryPath, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    $webConfigPath = Join-Path $SitePath 'web.config'
    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) { (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date }
    Write-Host "Translation is configured. Refresh Signal, open an article, choose a language and select Translate." -ForegroundColor Green
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $translatorKey = $null
    $secureKey = $null
    $headers = $null
}
