#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$GoogleServicesFile,
    [Parameter(Mandatory)][string]$ServiceAccountFile,
    [string]$SitePath = 'C:\sites\SignalHost',
    [string]$CredentialDirectory = 'C:\ProgramData\SignalNativePush',
    [string]$ApplicationPool = 'SignalAppPool',
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$site = [IO.Path]::GetFullPath($SitePath)
$secretDirectory = [IO.Path]::GetFullPath($CredentialDirectory)
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
foreach ($publicRoot in @($site, $repository)) {
    if ($secretDirectory.Equals($publicRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $secretDirectory.StartsWith($publicRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The credential directory must be outside the website and repository.'
    }
}
$configPath = Join-Path $site 'appsettings.Production.json'
$webConfigPath = Join-Path $site 'web.config'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $webConfigPath -PathType Leaf)) {
    throw 'The existing Signal production settings and web.config are required.'
}
# Refuse redirected paths before installing a private key.
foreach ($path in @($secretDirectory, $site)) {
    $ancestor = $path
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and
            ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Configuration paths cannot contain redirected directories.'
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}

$options = Get-Content -LiteralPath $GoogleServicesFile -Raw | ConvertFrom-Json
$credentialText = Get-Content -LiteralPath $ServiceAccountFile -Raw
$credential = $credentialText | ConvertFrom-Json
$client = @($options.client | Where-Object { $_.client_info.android_client_info.package_name -ceq 'nz.signal.watch' })
if ($client.Count -ne 1 -or $credential.type -cne 'service_account' -or
    $credential.project_id -cne $options.project_info.project_id -or
    $credential.project_id -cnotmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' -or
    $credential.token_uri -cne 'https://oauth2.googleapis.com/token' -or
    [string]::IsNullOrWhiteSpace($credential.private_key) -or
    [string]::IsNullOrWhiteSpace($credential.client_email)) {
    throw 'Expected matching Firebase Android and service-account files for nz.signal.watch.'
}
$apiKey = @($client[0].api_key | Where-Object { -not [string]::IsNullOrWhiteSpace($_.current_key) })
if ($apiKey.Count -ne 1 -or
    [string]::IsNullOrWhiteSpace($client[0].client_info.mobilesdk_app_id) -or
    [string]::IsNullOrWhiteSpace($options.project_info.project_number)) {
    throw 'The Android Firebase configuration is incomplete.'
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$rsa = [Security.Cryptography.RSA]::Create()
$accessToken = $null
try {
    $rsa.ImportFromPem($credential.private_key)
    $issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","typ":"JWT"}'))
    $claims = @{
        iss = $credential.client_email
        scope = 'https://www.googleapis.com/auth/firebase.messaging'
        aud = 'https://oauth2.googleapis.com/token'
        iat = $issuedAt
        exp = $issuedAt + 3600
    } | ConvertTo-Json -Compress
    $unsigned = $header + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims)))
    $signature = $rsa.SignData([Text.Encoding]::UTF8.GetBytes($unsigned),
        [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $assertion = $unsigned + '.' + (ConvertTo-Base64Url $signature)
    try {
        $tokenResult = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' `
            -Body @{ grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer'; assertion = $assertion } `
            -TimeoutSec 30 -MaximumRedirection 0
        $accessToken = $tokenResult.access_token
        if ([string]::IsNullOrWhiteSpace($accessToken)) { throw 'No access token.' }
    } catch {
        throw 'Google could not authenticate the service-account key. Production settings were not changed.'
    }
    # A topic is only a validation target: validate_only forbids delivery to any device.
    $validation = @{
        validate_only = $true
        message = @{ topic = 'signal-configuration-check'; data = @{ kind = 'configuration-check' } }
    } | ConvertTo-Json -Depth 5 -Compress
    try {
        $null = Invoke-RestMethod -Method Post `
            -Uri "https://fcm.googleapis.com/v1/projects/$($credential.project_id)/messages:send" `
            -Headers @{ Authorization = "Bearer $accessToken" } -ContentType 'application/json' `
            -Body $validation -TimeoutSec 30 -MaximumRedirection 0
    } catch {
        $httpStatus = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'unavailable' }
        throw "FCM dry-run validation failed (HTTP $httpStatus). Enable FCM HTTP v1 and grant the service account Firebase Cloud Messaging API Admin. Production settings were not changed."
    }
    Write-Host 'Google authentication and FCM dry-run passed. No notification was sent.'
    if ($ValidateOnly) { return }

    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
    $originalOtherSettings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
    $originalOtherSettings.Remove('NativePush')
    $otherSettingsJson = $originalOtherSettings | ConvertTo-Json -Depth 100 -Compress
    $originalConfigHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
    $poolAccount = [Security.Principal.NTAccount]::new("IIS APPPOOL\$ApplicationPool")
    $poolSid = $poolAccount.Translate([Security.Principal.SecurityIdentifier])
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $permissions = [Security.AccessControl.DirectorySecurity]::new()
    $permissions.SetAccessRuleProtection($true, $false)
    $permissions.SetOwner($currentSid)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    foreach ($sid in @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $permissions.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl',
            $inherit, 'None', 'Allow'))
    }
    $permissions.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($poolSid, 'ReadAndExecute',
        $inherit, 'None', 'Allow'))
    $null = New-Item -ItemType Directory -Path $secretDirectory -Force
    Set-Acl -LiteralPath $secretDirectory -AclObject $permissions

    # Backups, temporary settings and the private key stay in the protected directory.
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff')
    $installedKey = Join-Path $secretDirectory "firebase-service-account-$stamp.json"
    [IO.File]::WriteAllText($installedKey, $credentialText, [Text.UTF8Encoding]::new($false))
    $configuration['NativePush'] = @{
        ProjectId = $credential.project_id
        ApplicationId = $client[0].client_info.mobilesdk_app_id
        SenderId = [string]$options.project_info.project_number
        ApiKey = $apiKey[0].current_key
        ServiceAccountFile = $installedKey
    }
    $stagedConfig = Join-Path $secretDirectory "production-$stamp.tmp"
    $backupConfig = Join-Path $secretDirectory "production-before-native-push-$stamp.json"
    [IO.File]::WriteAllText($stagedConfig, ($configuration | ConvertTo-Json -Depth 100) + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false))
    $roundTrip = Get-Content -LiteralPath $stagedConfig -Raw | ConvertFrom-Json -AsHashtable
    $roundTrip.Remove('NativePush')
    if (($roundTrip | ConvertTo-Json -Depth 100 -Compress) -cne $otherSettingsJson) {
        throw 'Unrelated settings did not survive serialization. Production settings were not changed.'
    }
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash -cne $originalConfigHash) {
        throw 'Production settings changed during setup; retry to preserve the newer settings.'
    }
    [IO.File]::Copy($configPath, $backupConfig)
    [IO.File]::Copy($stagedConfig, $configPath, $true)
    Remove-Item -LiteralPath $stagedConfig -Force
    (Get-Item -LiteralPath $webConfigPath).LastWriteTimeUtc = [DateTime]::UtcNow
    Write-Host "Native push configured for $($credential.project_id); Signal is restarting."
    Write-Host "Protected settings backup: $backupConfig"
    Write-Host 'A real paired phone/watch delivery test is still required.'
} finally {
    $rsa.Dispose()
    $accessToken = $null
    $tokenResult = $null
    $assertion = $null
    $credential = $null
    $credentialText = $null
}
