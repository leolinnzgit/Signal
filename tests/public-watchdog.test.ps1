$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
. (Join-Path $repository 'scripts\Invoke-SignalPublicWatchdog.ps1')
$realEndpointProbe = ${function:Get-SignalEndpointVersion}
$realPublicProbe = ${function:Get-SignalPublicHealth}
$fixtureRoot = Join-Path $repository ('work\watchdog-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
$script:localHealthy = $true
$script:publicHealthy = $false
$script:degraded = $false
$script:recoverWorks = $true
$script:canDiagnose = $true
$script:restarts = 0
function Get-SignalEndpointVersion { param($Origin, [switch]$Local, $Address); if ($script:localHealthy) { 'fixture-version' } }
function Get-SignalPublicHealth {
    param($Origin, $ExpectedVersion)
    [pscustomobject]@{ Healthy = $script:publicHealthy; CanDiagnose = $script:canDiagnose; Message = 'fixture'; Checks = @(
        [pscustomobject]@{ Address = '208.111.34.11'; Healthy = $script:publicHealthy },
        [pscustomobject]@{ Address = '208.111.35.209'; Healthy = ($script:publicHealthy -and -not $script:degraded) }
    ) }
}
function Restart-SignalTunnel {
    $script:restarts++
    if ($script:recoverWorks) { $script:publicHealthy = $true } else { throw 'Simulated reconnect timeout.' }
}
function Run-Check([int]$minute = 0) {
    Invoke-SignalPublicWatchdog -StateDirectory (Join-Path $fixtureRoot 'state') -SitePath $fixtureRoot `
        -PublicOrigin 'https://signal.tail445c22.ts.net' -Now ([DateTimeOffset]'2026-10-16T00:00:00Z').AddMinutes($minute)
}
try {
    Assert (-not (Test-SignalPublicAddress '100.87.141.88')) 'A local Tailscale address was treated as public.'
    Assert (-not (Test-SignalPublicAddress 'fd7a:115c:a1e0::1')) 'A Tailscale IPv6 address was treated as public.'
    Assert (-not (Test-SignalPublicAddress '::ffff:127.0.0.1')) 'A mapped loopback address was treated as public.'
    Assert (Test-SignalPublicAddress '208.111.34.11') 'A public relay was rejected.'
    Assert ((Run-Check 0).Status -eq 'AwaitingConfirmation') 'First failure caused a restart.'
    Assert ((Run-Check 1).Status -eq 'AwaitingConfirmation') 'Second failure caused a restart.'
    Assert ($script:restarts -eq 0) 'A transient failure restarted the tunnel.'
    Assert ((Run-Check 2).Status -eq 'Recovered') 'Three failures did not trigger verified recovery.'
    Assert ($script:restarts -eq 1) 'Recovery did not perform exactly one restart.'
    $script:publicHealthy = $false
    Run-Check 3 | Out-Null
    Run-Check 4 | Out-Null
    Assert ((Run-Check 5).Status -eq 'Cooldown') 'The persistent cooldown was ignored.'
    Assert ($script:restarts -eq 1) 'Repeated failure caused a restart loop.'
    $script:recoverWorks = $false
    Assert ((Run-Check 22).Status -eq 'RecoveryFailed') 'A failed reconnect was reported as recovered.'
    Assert ($script:restarts -eq 2) 'Recovery did not resume after cooldown.'
    Assert ((Run-Check 23).Status -eq 'Cooldown') 'An exception lost the saved restart cooldown.'
    $script:publicHealthy = $true; $script:degraded = $true
    $result = Run-Check 24
    Assert ($result.Status -eq 'Degraded' -and $result.ConsecutiveFailures -eq 0) 'A usable relay caused recovery loops.'
    $script:localHealthy = $false
    Assert ((Run-Check 25).Status -eq 'LocalUnavailable') 'Local IIS failure was treated as a tunnel problem.'
    Set-Content -LiteralPath (Join-Path $fixtureRoot 'app_offline.htm') -Value 'maintenance'
    Assert ((Run-Check 26).Status -eq 'Maintenance') 'Deployment maintenance was interrupted.'
    Assert ($script:restarts -eq 2) 'Maintenance or local IIS failure restarted Tailscale.'
    Remove-Item -LiteralPath (Join-Path $fixtureRoot 'app_offline.htm')
    $script:localHealthy = $true; $script:canDiagnose = $false
    Assert ((Run-Check 27).Status -eq 'ProbeUnavailable') 'Resolver/network failure triggered tunnel recovery.'
    Assert ($script:restarts -eq 2) 'An unavailable DNS probe restarted Tailscale.'
    $statePath = Join-Path $fixtureRoot 'state\state.json'
    Set-Content -LiteralPath $statePath -Value '{broken'
    $rejected = $false
    try { Run-Check 28 | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Damaged state silently discarded the cooldown.'
    # Exercise the real bounded command runner, including timeout and argument quoting.
    $response = Invoke-SignalCommand "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" @('-NoProfile', '-Command', 'Write-Output ''a b''') 10
    Assert ($response.ExitCode -eq 0 -and $response.Output.Trim() -eq 'a b') 'Native command argument handling failed.'
    $response = Invoke-SignalCommand "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe" @('-NoProfile', '-Command', 'Start-Sleep -Seconds 5') 1
    Assert ($response.ExitCode -eq -1) 'A hung external command exceeded its deadline.'
    # Exercise actual response validation and public DNS fallback without network calls.
    $script:fakeOutput = '{"version":"expected"}'
    $script:commandArguments = @()
    function Invoke-SignalCommand {
        param($FilePath, $Arguments, $TimeoutSeconds)
        $script:commandArguments += ,$Arguments
        [pscustomobject]@{ ExitCode = 0; Output = $script:fakeOutput; Error = '' }
    }
    Assert ((& $realEndpointProbe -Origin 'https://signal.tail445c22.ts.net' -Address '208.111.34.11') -eq 'expected') 'The version response was not parsed.'
    Assert ('--insecure' -notin $script:commandArguments[0]) 'Public TLS certificate validation was disabled.'
    Assert ('signal.tail445c22.ts.net:443:208.111.34.11' -in $script:commandArguments[0]) 'The public relay was not explicitly selected.'
    $script:fakeOutput = '<html>wrong server</html>'
    Assert (-not (& $realEndpointProbe -Origin 'https://signal.tail445c22.ts.net')) 'An arbitrary HTTP 200 page was accepted.'
    $script:dnsCalls = 0
    function Invoke-SignalCommand {
        param($FilePath, $Arguments, $TimeoutSeconds)
        $script:dnsCalls++
        if ($script:dnsCalls -eq 1) { return [pscustomobject]@{ ExitCode = 28; Output = ''; Error = 'Timeout' } }
        [pscustomobject]@{ ExitCode = 0; Output = '{"Answer":[{"type":1,"data":"100.87.141.88"},{"type":1,"data":"208.111.34.11"}]}'; Error = '' }
    }
    $probe = & $realPublicProbe -Origin 'https://signal.tail445c22.ts.net' -ExpectedVersion 'fixture-version'
    Assert ($probe.Healthy -and $probe.Checks.Count -eq 1 -and $script:dnsCalls -eq 2) 'DNS fallback or tailnet-address rejection failed.'
    $probe = & $realPublicProbe -Origin 'https://signal.tail445c22.ts.net' -ExpectedVersion 'different-version'
    Assert (-not $probe.Healthy) 'An old or unrelated application version was accepted.'
    Write-Output 'Watchdog checks passed: repeated failures, recovery verification, persistent cooldown, failed restart, degraded relays, IIS deferral, maintenance, state corruption, command deadlines, TLS validation, public DNS fallback and version matching.'
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $workRoot = [IO.Path]::GetFullPath((Join-Path $repository 'work'))
    if (-not $resolvedFixture.StartsWith($workRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture cleanup path.' }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
