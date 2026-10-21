[CmdletBinding()]
param(
    [string]$StateDirectory = "$env:ProgramData\SignalPublicWatchdog",
    [string]$SitePath = 'C:\sites\SignalHost',
    [string]$PublicOrigin = 'https://signal.tail445c22.ts.net'
)

$ErrorActionPreference = 'Stop'

function Invoke-SignalCommand {
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 15)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $quoted = foreach ($argument in $Arguments) {
        '"' + [regex]::Replace([regex]::Replace($argument, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }
    $startInfo.Arguments = $quoted -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw "Could not start $FilePath." }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return [pscustomobject]@{ ExitCode = -1; Output = ''; Error = 'Command timed out.' }
        }
        $process.WaitForExit()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.Result; Error = $stderr.Result }
    } finally { $process.Dispose() }
}

function Get-SignalEndpointVersion {
    param([string]$Origin, [switch]$Local, [string]$Address)
    $arguments = @('--silent', '--show-error', '--fail', '--noproxy', '*', '--max-time', '8')
    if ($Local) { $arguments += '--insecure' }
    if ($Address) {
        $hostname = ([uri]$Origin).DnsSafeHost
        $resolved = if ($Address.Contains(':')) { "[$Address]" } else { $Address }
        $arguments += @('--resolve', "${hostname}:443:$resolved")
    }
    $arguments += "$Origin/api/app-version"
    $response = Invoke-SignalCommand "$env:windir\System32\curl.exe" $arguments 10
    if ($response.ExitCode -ne 0) { return $null }
    try { return ($response.Output | ConvertFrom-Json).version } catch { return $null }
}

function Test-SignalPublicAddress {
    param([string]$Address)
    $ip = [Net.IPAddress]::Parse($Address)
    if ($ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
        if ($ip.IsIPv4MappedToIPv6) { return Test-SignalPublicAddress $ip.MapToIPv4().ToString() }
        $bytes = $ip.GetAddressBytes()
        # Public unicast only; exclude loopback, link-local and Tailscale/other ULA addresses.
        return ($bytes[0] -band 0xe0) -eq 0x20
    }
    $bytes = $ip.GetAddressBytes()
    return -not ($bytes[0] -in @(0, 10, 127) -or $bytes[0] -ge 224 -or
        ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127) -or
        ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168))
}

function Get-SignalPublicHealth {
    param([string]$Origin, [string]$ExpectedVersion)
    # Resolve through public DNS-over-HTTPS: a MagicDNS/self-host entry must not
    # allow a local Tailscale listener to mask a broken public Funnel.
    $hostname = ([uri]$Origin).DnsSafeHost
    $checks = @()
    $addresses = @()
    foreach ($resolver in @("https://dns.google/resolve?name=$hostname&type=A", "https://cloudflare-dns.com/dns-query?name=$hostname&type=A")) {
        $dns = Invoke-SignalCommand "$env:windir\System32\curl.exe" @(
            '--silent', '--show-error', '--fail', '--noproxy', '*', '--max-time', '8',
            '-H', 'accept: application/dns-json', $resolver
        ) 10
        try {
            if ($dns.ExitCode -ne 0) { continue }
            $addresses = @(($dns.Output | ConvertFrom-Json).Answer | Where-Object { $_.type -eq 1 } |
                ForEach-Object { $_.data } | Where-Object { Test-SignalPublicAddress $_ } | Select-Object -Unique -First 4)
            if ($addresses.Count) { break }
        } catch { continue }
    }
    if (-not $addresses.Count) {
        return [pscustomobject]@{ Healthy = $false; CanDiagnose = $false; Checks = @(); Message = 'Public DNS unavailable from both resolvers; recovery deferred.' }
    }
    try {
        foreach ($address in $addresses) {
            $version = Get-SignalEndpointVersion -Origin $Origin -Address $address
            $checks += [pscustomobject]@{ Address = $address; Healthy = ($version -eq $ExpectedVersion); Version = $version }
        }
    } catch { return [pscustomobject]@{ Healthy = $false; CanDiagnose = $false; Checks = @(); Message = $_.Exception.Message } }
    $passing = @($checks | Where-Object Healthy).Count
    return [pscustomobject]@{
        Healthy = ($passing -gt 0)
        CanDiagnose = $true
        Checks = $checks
        Message = "$passing of $($checks.Count) public relays returned the local application version."
    }
}

function Restart-SignalTunnel {
    $tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe"
    Restart-Service -Name Tailscale -ErrorAction Stop
    $deadline = [datetime]::UtcNow.AddSeconds(75)
    do {
        $result = Invoke-SignalCommand $tailscale @('status', '--json') 5
        try { $status = $result.Output | ConvertFrom-Json } catch { $status = $null }
        if ($status -and $status.BackendState -eq 'Running' -and $status.Self.Online) {
            # Reuse the saved Serve/Funnel configuration; do not replace production mappings.
            return
        }
        Start-Sleep -Seconds 3
    } while ([datetime]::UtcNow -lt $deadline)
    throw 'Tailscale did not return online within 75 seconds.'
}

function Save-SignalWatchdogState {
    param([string]$Path, $State)
    $temporary = "$Path.tmp"
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Invoke-SignalPublicWatchdog {
    param(
        [string]$StateDirectory,
        [string]$SitePath,
        [string]$PublicOrigin,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    if (([uri]$PublicOrigin).Scheme -ne 'https' -or ([uri]$PublicOrigin).Port -ne 443) {
        throw 'The watchdog requires a public HTTPS origin on port 443.'
    }
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    $lock = $null
    try {
        try { $lock = [IO.File]::Open((Join-Path $StateDirectory 'watchdog.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] { return }
        $statePath = Join-Path $StateDirectory 'state.json'
        $state = [pscustomobject]@{
            CheckedAtUtc = $Now.ToString('o'); Status = 'Checking'; Message = ''
            ConsecutiveFailures = 0; LastRecoveryAttemptUtc = $null
            LastRecoverySucceededUtc = $null; LocalVersion = $null; PublicChecks = @()
        }
        if (Test-Path -LiteralPath $statePath) {
            # Fail closed on damaged state rather than discarding the restart cooldown.
            $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if ($null -eq $previous.ConsecutiveFailures) { throw 'Invalid watchdog state.' }
            $state.ConsecutiveFailures = [int]$previous.ConsecutiveFailures
            $state.LastRecoveryAttemptUtc = $previous.LastRecoveryAttemptUtc
            $state.LastRecoverySucceededUtc = $previous.LastRecoverySucceededUtc
            if ($state.LastRecoveryAttemptUtc) { $null = [DateTimeOffset]::Parse($state.LastRecoveryAttemptUtc) }
        }
        if (Test-Path -LiteralPath (Join-Path $SitePath 'app_offline.htm')) {
            $state.Status = 'Maintenance'; $state.ConsecutiveFailures = 0
            $state.Message = 'Intentional IIS maintenance; recovery deferred.'
        } else {
            $state.LocalVersion = Get-SignalEndpointVersion -Origin 'https://localhost:8443' -Local
            if (-not $state.LocalVersion) {
                $state.Status = 'LocalUnavailable'; $state.ConsecutiveFailures = 0
                $state.Message = 'Local IIS unavailable; leave recovery to Signal IIS Keepalive.'
            } else {
                $health = Get-SignalPublicHealth $PublicOrigin $state.LocalVersion
                $state.PublicChecks = @($health.Checks); $state.Message = $health.Message
                if (-not $health.CanDiagnose) {
                    $state.ConsecutiveFailures = 0; $state.Status = 'ProbeUnavailable'
                } elseif ($health.Healthy) {
                    $state.ConsecutiveFailures = 0
                    $state.Status = if (@($health.Checks | Where-Object { -not $_.Healthy }).Count) { 'Degraded' } else { 'Healthy' }
                } else {
                    $state.ConsecutiveFailures++
                    $coolingDown = $state.LastRecoveryAttemptUtc -and
                        ($Now - [DateTimeOffset]::Parse($state.LastRecoveryAttemptUtc)).TotalMinutes -lt 20
                    if ($state.ConsecutiveFailures -lt 3) { $state.Status = 'AwaitingConfirmation' }
                    elseif ($coolingDown) { $state.Status = 'Cooldown' }
                    else {
                        # Recheck maintenance and IIS immediately before disrupting the tunnel.
                        if ((Test-Path -LiteralPath (Join-Path $SitePath 'app_offline.htm')) -or
                            -not (Get-SignalEndpointVersion -Origin 'https://localhost:8443' -Local)) {
                            $state.Status = 'RecoveryDeferred'
                        } else {
                            $state.Status = 'Recovering'; $state.LastRecoveryAttemptUtc = $Now.ToString('o')
                            Save-SignalWatchdogState $statePath $state
                            try {
                                Restart-SignalTunnel
                                $health = Get-SignalPublicHealth $PublicOrigin $state.LocalVersion
                                $state.PublicChecks = @($health.Checks); $state.Message = $health.Message
                                if ($health.Healthy) {
                                    $state.Status = 'Recovered'; $state.ConsecutiveFailures = 0
                                    $state.LastRecoverySucceededUtc = [DateTimeOffset]::UtcNow.ToString('o')
                                } else { $state.Status = 'RecoveryFailed' }
                            } catch { $state.Status = 'RecoveryFailed'; $state.Message = $_.Exception.Message }
                        }
                    }
                }
            }
        }
        Save-SignalWatchdogState $statePath $state
        return $state
    } finally { if ($lock) { $lock.Dispose() } }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $result = Invoke-SignalPublicWatchdog -StateDirectory $StateDirectory -SitePath $SitePath -PublicOrigin $PublicOrigin
        $result | ConvertTo-Json -Depth 8
        if ($result -and $result.Status -in @('RecoveryFailed', 'Cooldown', 'LocalUnavailable', 'ProbeUnavailable')) { exit 1 }
    } catch { Write-Error $_; exit 1 }
}
