param(
    [string]$Endpoint = "",
    [ValidateSet(2, 4, 6)]
    [int]$RejectionThreshold = 2,
    [string]$SitePath = "C:\sites\SignalHost"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) { throw "The Signal IIS directory was not found at $SitePath." }
Write-Host "Configure Azure AI Content Safety comment moderation for Signal." -ForegroundColor Cyan
Write-Host "Copy the Endpoint and Key 1 from your Content Safety resource's Keys and Endpoint page."
Write-Host "The key is hidden and saved only in private IIS settings."

if ([string]::IsNullOrWhiteSpace($Endpoint)) { $Endpoint = Read-Host "Content Safety endpoint (https://<resource>.cognitiveservices.azure.com/)" }
$Endpoint = $Endpoint.Trim().TrimEnd('/') + '/'
$safetyUri = $null
if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$safetyUri) -or $safetyUri.Scheme -ne 'https' `
    -or -not $safetyUri.IsDefaultPort -or $safetyUri.UserInfo -or $safetyUri.Query -or $safetyUri.Fragment `
    -or $safetyUri.AbsolutePath -ne '/' -or -not $safetyUri.Host.EndsWith('.cognitiveservices.azure.com', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Use the HTTPS .cognitiveservices.azure.com endpoint of your Azure AI Content Safety resource."
}

$secureKey = Read-Host "Azure AI Content Safety Key 1" -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $safetyKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($safetyKey.Length -lt 20 -or $safetyKey.Length -gt 256 -or $safetyKey -match '\s') {
        throw "Copy the complete Azure AI Content Safety resource key."
    }

    $testBody = @{
        text       = 'Signal comment moderation is ready.'
        categories = @('Hate', 'SelfHarm', 'Sexual', 'Violence')
        outputType = 'FourSeverityLevels'
    } | ConvertTo-Json -Depth 6

    try {
        $null = Invoke-RestMethod -Method Post `
            -Uri ($Endpoint + 'contentsafety/text:analyze?api-version=2023-10-01') `
            -ContentType 'application/json' `
            -Body $testBody `
            -Headers @{ 'Ocp-Apim-Subscription-Key' = $safetyKey } `
            -TimeoutSec 20 `
            -MaximumRedirection 0
    } catch {
        throw "Azure could not validate the Content Safety key and endpoint. Private settings were not changed."
    }

    $configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }

    $configuration | Add-Member -NotePropertyName AzureContentSafety -NotePropertyValue ([pscustomobject]@{
        Endpoint           = $Endpoint
        SubscriptionKey    = $safetyKey
        RejectionThreshold = $RejectionThreshold
    }) -Force

    $temporaryPath = "$configPath.tmp"
    [IO.File]::WriteAllText($temporaryPath, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force

    $webConfigPath = Join-Path $SitePath 'web.config'
    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) { (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date }
    Write-Host "Azure AI Content Safety is configured. Public comments and discussions are now protected." -ForegroundColor Green
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $safetyKey = $null
    $secureKey = $null
}
