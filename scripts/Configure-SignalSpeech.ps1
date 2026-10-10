param(
    [string]$Region = "",
    [string]$SitePath = "C:\sites\SignalHost",
    [string]$EnglishVoice = "en-NZ-MollyNeural",
    [string]$ChineseVoice = "zh-TW-HsiaoChenNeural"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
$webConfigPath = Join-Path $SitePath "web.config"
if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) {
    throw "The Signal IIS directory was not found at $SitePath."
}

Write-Host "Configure Azure neural reading voices for Signal." -ForegroundColor Cyan
Write-Host "Find Key 1 and Region on your Speech resource's Keys and Endpoint page."
Write-Host "The key will be hidden and saved only in the private IIS configuration."
if ([string]::IsNullOrWhiteSpace($Region)) { $Region = Read-Host "Speech resource region (for example australiaeast)" }
$Region = $Region.Trim().ToLowerInvariant()
if ($Region -cnotmatch '^[a-z][a-z0-9]{1,39}$') { throw "Copy the Region identifier, such as australiaeast, rather than an endpoint URL." }

$secureKey = Read-Host "Azure Speech Key 1" -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $speechKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($speechKey.Length -lt 20 -or $speechKey.Length -gt 256 -or $speechKey -match '\s') {
        throw "The Speech key appears incomplete. Copy the full Key 1 value and try again."
    }
    try {
        $voices = @(Invoke-RestMethod -Method Get -Uri "https://$Region.tts.speech.microsoft.com/cognitiveservices/voices/list" `
            -Headers @{ 'Ocp-Apim-Subscription-Key' = $speechKey } -TimeoutSec 20 -MaximumRedirection 0)
    } catch {
        throw "Azure could not validate the Speech key and region. Check both values on Keys and Endpoint. Configuration was not changed."
    }
    foreach ($choice in @(@{ Id = $EnglishVoice; Language = 'en-' }, @{ Id = $ChineseVoice; Language = 'zh-' })) {
        if (-not ($voices | Where-Object { $_.ShortName -eq $choice.Id -and $_.Locale.StartsWith($choice.Language) -and $_.VoiceType -eq 'Neural' -and $_.Status -eq 'GA' })) {
            throw "Azure does not offer $($choice.Id) in this region. Configuration was not changed."
        }
    }
    $configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }
    $configuration | Add-Member -NotePropertyName Speech -NotePropertyValue ([pscustomobject]@{
        Provider = 'Azure'
        Key = $speechKey
        Region = $Region
        EnglishVoice = $EnglishVoice
        ChineseVoice = $ChineseVoice
    }) -Force
    $temporaryPath = "$configPath.tmp"
    [IO.File]::WriteAllText($temporaryPath, ($configuration | ConvertTo-Json -Depth 30) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) { (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date }
    Write-Host "Azure neural narration is configured. Signal is restarting." -ForegroundColor Green
    Write-Host "Refresh Signal, then choose Recorded audio and preview a voice."
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $speechKey = $null
    $secureKey = $null
}
