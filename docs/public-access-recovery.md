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
