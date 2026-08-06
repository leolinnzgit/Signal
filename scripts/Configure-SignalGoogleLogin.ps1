param(
    [string]$ClientId = "488666576021-n1l40v87ueebg7jq9iau40j87jj1chbb.apps.googleusercontent.com",
    [string]$SitePath = "C:\inetpub\Signal"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $SitePath "appsettings.Production.json"
$webConfigPath = Join-Path $SitePath "web.config"

if (-not (Test-Path -LiteralPath $SitePath -PathType Container)) {
    throw "The Signal IIS directory was not found at $SitePath."
}

$configuration = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    [pscustomobject]@{}
}

if (-not $configuration.PSObject.Properties["Authentication"]) {
    $configuration | Add-Member -NotePropertyName Authentication -NotePropertyValue ([pscustomobject]@{})
}
if (-not $configuration.Authentication.PSObject.Properties["Google"]) {
    $configuration.Authentication | Add-Member -NotePropertyName Google -NotePropertyValue ([pscustomobject]@{})
}

Write-Host "Configure Google sign-in for Signal." -ForegroundColor Cyan
Write-Host "The client secret will be hidden while you paste it and will not be written to the repository."
$secureSecret = Read-Host "Google OAuth client secret" -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)

try {
    $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
    if ([string]::IsNullOrWhiteSpace($clientSecret) -or $clientSecret.Length -lt 20) {
        throw "The Google OAuth client secret appears incomplete. Copy the full Client secret value and try again."
    }
    if ($clientSecret.EndsWith(".apps.googleusercontent.com", [StringComparison]::OrdinalIgnoreCase)) {
        throw "That value is a Client ID, not a Client secret. Copy the Client secret value and try again."
    }

    $configuration.Authentication.Google |
        Add-Member -NotePropertyName ClientId -NotePropertyValue $ClientId -Force
    $configuration.Authentication.Google |
        Add-Member -NotePropertyName ClientSecret -NotePropertyValue $clientSecret -Force

    $temporaryPath = "$configPath.tmp"
    $json = $configuration | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText(
        $temporaryPath,
        $json + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force

    if (Test-Path -LiteralPath $webConfigPath -PathType Leaf) {
        (Get-Item -LiteralPath $webConfigPath).LastWriteTime = Get-Date
    }

    Write-Host "Google sign-in is configured. Signal is restarting now." -ForegroundColor Green
} finally {
    if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    $clientSecret = $null
    $secureSecret = $null
}
