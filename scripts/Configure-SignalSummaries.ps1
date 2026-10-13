param(
    [string]$Endpoint = "https://signal-language.cognitiveservices.azure.com/",
    [string]$SitePath = "C:\sites\SignalHost"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) { throw "The Signal IIS directory was not found." }
Write-Host "Configure Azure AI Language article summaries for Signal." -ForegroundColor Cyan
Write-Host "Copy the endpoint and Key 1 from the Language resource's Keys and Endpoint page."
Write-Host "The key is hidden and saved only in private IIS settings."
if ([string]::IsNullOrWhiteSpace($Endpoint)) { $Endpoint = Read-Host "Language resource endpoint" }
$Endpoint = $Endpoint.Trim().TrimEnd('/') + '/'
$summaryUri = $null
if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$summaryUri) -or $summaryUri.Scheme -ne 'https' `
    -or -not $summaryUri.IsDefaultPort -or $summaryUri.UserInfo -or $summaryUri.Query -or $summaryUri.Fragment `
    -or $summaryUri.AbsolutePath -ne '/' -or -not $summaryUri.Host.EndsWith('.cognitiveservices.azure.com')) {
    throw "Use the HTTPS endpoint of your Azure AI Language resource."
}
$secureKey = Read-Host "Azure AI Language Key 1" -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $summaryKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($summaryKey.Length -lt 20 -or $summaryKey.Length -gt 256 -or $summaryKey -match '\s') { throw "Copy the complete Language resource key." }
    $testBody = @{ kind = 'LanguageDetection'; parameters = @{ loggingOptOut = $true }; analysisInput = @{ documents = @(@{ id = '1'; text = 'Signal article summaries are ready.' }) } } | ConvertTo-Json -Depth 8
    try {
        $null = Invoke-RestMethod -Method Post -Uri ($Endpoint + 'language/:analyze-text?api-version=2023-04-01') `
            -ContentType 'application/json' -Body $testBody -Headers @{ 'Ocp-Apim-Subscription-Key' = $summaryKey } -TimeoutSec 20 -MaximumRedirection 0
    } catch { throw "Azure could not validate the key and endpoint. Private settings were not changed." }
    $configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }
    $configuration | Add-Member -NotePropertyName AzureLanguage -NotePropertyValue ([pscustomobject]@{ Endpoint = $Endpoint; Key = $summaryKey }) -Force
    $temporaryPath = "$configPath.tmp"
    [IO.File]::WriteAllText($temporaryPath, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    $webConfigPath = Join-Path $SitePath 'web.config'
    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) { (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date }
    Write-Host "Article summaries are configured. Refresh Signal and open an article to hear its summary." -ForegroundColor Green
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $summaryKey = $null
    $secureKey = $null
}
