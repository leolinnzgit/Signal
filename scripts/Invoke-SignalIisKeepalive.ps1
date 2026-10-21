$ErrorActionPreference = 'Stop'
$appCmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
$offlinePath = 'C:\sites\SignalHost\app_offline.htm'
function Test-SignalLocalHealth {
    & "$env:windir\System32\curl.exe" --insecure --fail --silent --show-error --noproxy '*' --max-time 15 --output NUL 'https://localhost:8443/api/app-version'
    return $LASTEXITCODE -eq 0
}
if ((Test-Path -LiteralPath $offlinePath) -or (Test-SignalLocalHealth)) { exit 0 }
$poolState = (& $appCmd list apppool '/name:SignalAppPool' '/text:state') -join ''
if ($LASTEXITCODE -ne 0) { throw 'Could not read SignalAppPool state.' }
if (Test-Path -LiteralPath $offlinePath) { exit 0 }
if ($poolState.Trim() -eq 'Started') { & $appCmd recycle apppool '/apppool.name:SignalAppPool' }
else { & $appCmd start apppool '/apppool.name:SignalAppPool' }
if ($LASTEXITCODE -ne 0) { throw 'Could not recover SignalAppPool.' }
Start-Sleep -Seconds 5
if (-not (Test-SignalLocalHealth)) { throw 'Signal IIS remained unavailable after recovery.' }
