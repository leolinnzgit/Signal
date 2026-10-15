# Recovering Signal public access

Check IIS and the public Funnel address separately. A successful local check
does not establish that the public tunnel is working.

```powershell
curl.exe --insecure --fail --silent --show-error --max-time 20 --output NUL https://localhost:8443/
curl.exe --fail --silent --show-error --max-time 20 --output NUL https://signal.tail445c22.ts.net/
& 'C:\Program Files\Tailscale\tailscale.exe' funnel status
```

Use `--insecure` only for the local IIS certificate. Keep certificate validation
enabled for all public requests.

## Automatic recovery

Install or update the production checks from this checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Install-SignalPublicWatchdog.ps1
```

Installation requests Windows administrator elevation once. It publishes protected
script copies to `C:\ProgramData\SignalPublicWatchdog` and registers both tasks
as SYSTEM, with startup triggers and permission to run on battery power. It also
enables Tailscale's unattended mode while preserving its other preferences. No
application rebuild or database change is required. The prior IIS task definition
is retained in that directory as `Signal-IIS-Keepalive-before-install.xml`.

- **Signal IIS Keepalive** checks the local API every five minutes and recovers
  `SignalAppPool` when needed.
- **Signal Public Watchdog** checks every minute. It resolves public relay
  addresses through Google DNS-over-HTTPS, with Cloudflare as a fallback, and
  compares each relay's API version with local IIS using normal TLS validation.
  It rejects private and Tailscale addresses to avoid accidentally testing only
  the local listener. One working relay counts as usable but degraded service.
- Three consecutive failures across all tested public relays trigger a Tailscale
  service restart, followed by a wait for the existing node to reconnect and
  another public check. The saved Funnel configuration is preserved.
- A persistent 20-minute cooldown is recorded **before** restart, including when
  recovery fails or the process is interrupted. Overlapping checks are prevented.
- Deployment maintenance (`app_offline.htm`), local IIS failures, and unavailable
  public DNS probes defer tunnel recovery. External commands have deadlines.

The latest observations, relay results, failure count, and recovery timestamps
are recorded in `C:\ProgramData\SignalPublicWatchdog\state.json`. Task Scheduler
also reports failed recovery checks with a nonzero result. The tasks can recover
the running host independently of an interactive login; they do not change its
sleep policy or repair an outage in the upstream relay service.

Run the isolated failure-simulation tests with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/public-watchdog.test.ps1
```

References: [Tailscale unattended mode](https://tailscale.com/docs/how-to/run-unattended)
and [Windows task settings](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset).

## Manual recovery

If IIS is healthy but the public TLS handshake fails, inspect Tailscale before
redeploying the application. In an administrator PowerShell window, restart the
Tailscale service:

```powershell
Restart-Service -Name Tailscale -ErrorAction Stop
```

Wait for `tailscale status` to report the existing node online. Immediately after
a restart, the client can temporarily report `NoState`, a control-server timeout,
or no Serve configuration. Recheck connectivity before changing authentication
or overwriting configuration.

Once the node reconnects, verify its existing Funnel mapping. This deployment's
background mapping can be reapplied with:

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' funnel --bg --https=443 https+insecure://localhost:8443
```

Verify the homepage, `/api/app-version`, and the JavaScript and CSS assets
referenced by the returned homepage. Compare the public application version
with `https://localhost:8443/api/app-version`. When diagnosing intermittent
access, check each current public DNS address individually using curl's
`--resolve` option, keeping the original hostname for TLS validation.

## 16 October 2026 incident

Local IIS returned HTTP 200 while public TLS handshakes failed. Tailscale initially
reported the node online with no health errors. Reconnecting the node and
reapplying Funnel alone did not restore access.

An administrator service restart completed at approximately 09:41 NZDT. The node
initially reported `NoState` and a control-server connection timeout, then returned
online. After reconnection, the original background Funnel mapping was reapplied.
A temporary relay preference was also requested during diagnosis; the reported
home relay remained `sea`, so these checks do not establish that a relay change
caused recovery. The temporary preference was cleared afterward.

At approximately 09:45–09:48 NZDT:

- The normal public homepage returned HTTP 200.
- The public API version matched local IIS.
- Both frontend bundles returned HTTP 200.
- Public relay `208.111.34.11` returned HTTP 200.
- Public relay `208.111.35.209` continued to fail TLS handshakes, including after
  a routing-map refresh and relay reconnection. The remaining cause was not
  established; these results indicate partial recovery and possible intermittent
  access, rather than verified recovery through every relay.

The user subsequently confirmed that the normal public URL loaded on their
device. This confirms restored access on that device while the individual relay
failure remains an unresolved diagnostic finding.

The final Funnel configuration matched the pre-recovery configuration. No
application binaries, production settings, or application data were changed.
The existing production tunnel mapping was reapplied without rebuilding IIS.

During the later watchdog validation, both public relay addresses returned the
expected application version. The earlier individual relay failure was no
longer reproducible in that check.
