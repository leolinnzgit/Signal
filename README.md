# Signal

![Signal — Stay current on what matters](public/og.png)

Signal is a self-hosted personal news monitor that turns the topics and
publishers you trust into one focused briefing. It collects stories from
multiple sources, refreshes each topic independently, tracks what you have
read, and keeps useful context such as market prices and local weather close
at hand.

The primary application is a React client backed by ASP.NET Core, SQLite, and
ASP.NET Core Identity. It is designed to run locally during development and on
IIS for a persistent personal deployment.

## Highlights

- Follow any number of topics and move quickly to the next unread topic.
- Collect stories from Google News, GDELT, and up to 20 custom RSS or Atom
  publisher feeds.
- Deduplicate feeds and articles before they enter the briefing.
- Refresh topics on independent schedules from 5 minutes to 8 hours, or
  refresh them manually.
- Store article history in SQLite with topic and source filters, pagination,
  and search.
- Bookmark stories indefinitely while automatically purging unbookmarked
  history on a configurable schedule.
- Track read status and show unread indicators whenever a topic receives new
  stories.
- Read supported articles inside Signal, with an automatic fallback to the
  publisher's original page when extraction is blocked or paywalled.
- Display feed images when publishers provide them.
- Suggest publishers and current Google Trends from English- and
  Mandarin-speaking regions.
- Show current market pricing for matching topics, with manual ticker
  overrides, including qualified NZX symbols such as `AIR:NZX`.
- Show current conditions and a seven-day forecast for a saved weather
  location.
- Send a formatted email briefing after scheduled refreshes.
- Adjust story and topic heading sizes, switch between light and dark themes,
  and install Signal as a progressive web app.
- Protect each account with confirmed email, secure cookies, CSRF protection,
  password reset, login lockout, and rate-limited account endpoints.

## Technology

| Area | Implementation |
| --- | --- |
| Client | React 19, TypeScript, Vite |
| Server | ASP.NET Core 10 |
| Authentication | ASP.NET Core Identity |
| Data | Entity Framework Core and SQLite |
| News | Google News, GDELT, RSS, and Atom |
| Market data | Twelve Data |
| Email | Gmail API OAuth, SMTP, or local mail-drop |
| Hosting | IIS with optional Tailscale Funnel access |
| Installability | Web app manifest and service worker |

## Repository layout

```text
iis-client/                         React client used by the IIS application
Signal.Server/                      ASP.NET Core API, scheduler, and web host
Signal.Server.TopicMatcher.Tests/   Server-side topic matching tests
Signal.GmailSetup/                  Windows Gmail OAuth setup utility
public/                             Shared images, icons, manifest, service worker
tests/                              Front-end and rendered HTML tests
app/                                Earlier OpenAI Sites/Vinext implementation
```

## Requirements

- Node.js 22.13 or newer
- npm
- .NET 10 SDK
- For IIS deployment: IIS and the .NET 10 Hosting Bundle
- Optional: a Twelve Data API key for stock quotes
- Optional: a Google OAuth desktop client with the Gmail API enabled, or an
  SMTP account, for real email delivery
- Optional: a Google OAuth **Web application** client for Google account sign-in

## Run locally

Install dependencies, build the React client, and start the server:

```powershell
npm install
npm run iis:client:build
npm run iis:server
```

Open <http://127.0.0.1:5168>.

The SQLite database, data-protection keys, and development mail are created
under `Signal.Server/App_Data`. Account emails use the local mail-drop by
default, so confirmation and password-reset messages can be tested without
configuring an external email provider.

### Client hot reload

Keep the server running in one terminal:

```powershell
npm run iis:server
```

Start Vite in another terminal:

```powershell
npm run iis:client:dev
```

Open <http://127.0.0.1:3000>. Vite proxies `/api` requests to the ASP.NET Core
server on port `5168`.

## Configuration

ASP.NET Core configuration can be supplied through `appsettings.json`, user
secrets during development, or environment variables in production. Do not
commit API keys, OAuth credentials, passwords, SQLite databases, or generated
data-protection keys.

### Market pricing

Set a Twelve Data API key to enable automatic stock matching and quotes:

```powershell
dotnet user-secrets --project Signal.Server set "MarketData:ApiKey" "YOUR_API_KEY"
```

For IIS, configure the equivalent `MarketData__ApiKey` environment variable on
the application pool and recycle the pool.

Signal supports exchange-qualified ticker overrides using
`SYMBOL:EXCHANGE`. For New Zealand Exchange listings, use the `NZX` exchange
code—for example, `AIR:NZX`, `SPK:NZX`, or `FBU:NZX`. The Twelve Data `XNZE`
market identifier is accepted and normalized to `NZX`.

Twelve Data currently makes NZX prices available on its Pro and Venture plans
or higher. Signal identifies valid NZX tickers on lower plans and reports this
provider requirement explicitly instead of treating the ticker as invalid.

### Google account sign-in

Google sign-in uses a separate OAuth client of type **Web application**. The
registered redirect URI for the public Signal site is:

```text
https://signal.tail445c22.ts.net/signin-google
```

The public client ID is stored in `Signal.Server/appsettings.json`. Keep the
client secret outside Git. After deploying, run `Configure Signal Google
Login.cmd` on the IIS machine and paste the client secret into its hidden
prompt. The script stores it only in the preserved IIS
`appsettings.Production.json` file and restarts Signal.

Existing password accounts must sign in first and use **Connect Google** in
Account settings. Signal deliberately does not link accounts solely because
their email addresses match.

### Gmail API OAuth

Signal can send confirmation, password-reset, and refreshed-briefing emails
through the Gmail API without storing a Gmail password.

Build the Windows setup utility:

```powershell
npm run gmail:setup:build
```

The utility expects a Google OAuth client JSON file of type **Desktop app**. It
uses a loopback browser authorization flow, requests Gmail send-only access,
sends a test message, and stores the refresh token encrypted with the same
machine-protected ASP.NET Core Data Protection keys used by Signal.

The included setup utility is intended for an IIS installation at
`C:\inetpub\Signal`. Its generated credential file belongs in `App_Data` and
must never be committed.

### SMTP

SMTP remains available for providers that support a password or API key.
Configure these IIS application-pool environment variables:

```text
Smtp__Mode=Smtp
Smtp__Host=smtp.example.com
Smtp__Port=587
Smtp__EnableSsl=true
Smtp__Username=your-address@example.com
Smtp__AppPassword=your-provider-secret
Smtp__FromAddress=your-address@example.com
Smtp__FromName=Signal
```

Recycle the application pool after changing its environment variables.

## Validation

Run the client type check, production build, and automated tests:

```powershell
npm run iis:typecheck
npm run iis:client:build
dotnet test Signal.Server.TopicMatcher.Tests
```

The earlier Sites/Vinext implementation also has its own validation command:

```powershell
npm test
```

## Build and deploy to IIS

The included scripts deploy Signal as an ASP.NET Core application named
`Signal`, using the `SignalAppPool` application pool and local HTTPS on port
`8443`. The default physical path is `C:\inetpub\Signal`.

### IIS prerequisites

The included workflow builds and deploys on the IIS machine. Install:

- Node.js 22.13 or newer and npm
- .NET 10 SDK (needed to build the application)
- Python 3, used to create transactionally consistent SQLite backups
- IIS, including the IIS Management Console and PowerShell management tools
- The .NET 10 Hosting Bundle, which installs ASP.NET Core Module V2 for IIS

Install the Hosting Bundle after IIS is enabled. If IIS was installed after the
Hosting Bundle, repair or reinstall the Hosting Bundle, then restart the server
or IIS. An administrator can verify the hosting module in PowerShell:

```powershell
Import-Module WebAdministration
Get-WebGlobalModule | Where-Object Name -eq "AspNetCoreModuleV2"
```

The setup and deployment scripts currently target this checkout path:

```text
D:\Backup\My Documents\Development\Signal
```

If the repository is cloned elsewhere, update `$sourcePath`, `$resultPath`, and
other repository paths near the top of the scripts in `work/` before running
them. The IIS destination may also be changed there if required.

### Create and validate the deployment package

From the repository root, install the locked dependencies, type-check the IIS
client, run the server tests, and publish the application:

```powershell
npm ci
npm run iis:typecheck
dotnet test Signal.Server.TopicMatcher.Tests
npm run iis:build
```

`iis:build` first creates the production React client and then runs
`dotnet publish`. The complete deployment package is written to `iis-publish`. Confirm
that `iis-publish\Signal.Server.dll` exists before continuing.

### First-time IIS installation

The first-time setup must run from an **Administrator PowerShell** window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\work\setup-signal-iis.ps1
```

The setup script stops without overwriting an existing `Signal` IIS site or a
non-empty `C:\inetpub\Signal` directory. On a clean installation it:

1. Copies the validated `iis-publish` package to `C:\inetpub\Signal`.
2. Creates `SignalAppPool` with **No Managed Code**, integrated mode, and
   `AlwaysRunning` enabled.
3. Creates the `Signal` website.
4. Creates and trusts a two-year self-signed `localhost` certificate.
5. Adds the `https://localhost:8443` IIS binding.
6. Grants the application-pool identity read access to the application and
   modify access to `App_Data`.
7. Starts the application pool and website.

The initial production email mode is `File`, which writes messages locally
instead of sending them. Configure Gmail API OAuth or SMTP before relying on
account, briefing, or shared-story email delivery.

Signal creates `App_Data\signal.db` on first startup. `App_Data` also contains
data-protection keys and may contain encrypted Gmail credentials, so the entire
directory is private operational data and must not be committed.

### Enable routine deployment without UAC

After the site has been created, run this one-time setup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\work\enable-signal-uac-free-deploy.ps1
```

Windows asks for administrator approval once. The script grants the current
Windows account **Modify** permission only on `C:\inetpub\Signal`. Later routine
deployments can then use application-offline mode without stopping IIS or
requesting UAC approval.

### Deploy an update

Build and deploy from the repository root:

```powershell
npm ci
npm run iis:typecheck
dotnet test Signal.Server.TopicMatcher.Tests
npm run iis:build
npm run iis:deploy
```

For a previously validated `iis-publish` package, `npm run iis:deploy` is the
only required deployment command. `Update Signal Website.cmd` provides the same
deployment path through a double-clickable Windows command file.

During each deployment, `work/deploy-signal-without-uac.ps1`:

- places `app_offline.htm` so IIS shuts the application down cleanly;
- waits for the server assembly to be released;
- creates a SQLite-consistent database backup;
- copies the new package; and
- removes the maintenance page so IIS starts Signal again.

The deploy preserves these production-owned items:

```text
App_Data
appsettings.json
appsettings.Development.json
appsettings.Production.json
```

Database backups are stored in
`C:\inetpub\Signal\App_Data\backups`. Retention keeps the latest 10 backups plus
one daily backup for up to 30 days. Do not use `-SkipBackup` for a normal
deployment.

The deployment result is recorded in `work\full-deploy-result.json`, including
the backup path or the error that stopped deployment. The script does not retain
the previous application binaries; keep a known-good release package separately
if binary rollback is required.

### Verify the deployment

Check the local HTTPS endpoint after setup or deployment:

```powershell
curl.exe --ssl-no-revoke --insecure --fail --silent --show-error `
  --output NUL https://localhost:8443/
if ($LASTEXITCODE -eq 0) { "Signal is healthy" }
```

`--insecure` is appropriate only for this local self-signed certificate. A
public endpoint must use a publicly trusted TLS certificate or a secure tunnel
such as Tailscale Funnel. When Funnel is configured, verify the public URL
separately as well as the local IIS endpoint.

Also confirm the following in IIS Manager:

- the `Signal` website is **Started**;
- `SignalAppPool` is **Started**; and
- the site has an HTTPS binding on port `8443`.

### Keep scheduled refreshes running

Signal's topic scheduler runs inside the IIS process. Install the recovery task
once so the local endpoint is checked every five minutes and an unhealthy
application pool is restarted:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\work\configure-signal-keepalive-task.ps1
```

This command requests administrator approval and registers the
`Signal IIS Keepalive` scheduled task as `SYSTEM`.

### Production configuration and secrets

Put production-only settings in the preserved
`C:\inetpub\Signal\appsettings.Production.json` file or in application-pool
environment variables. Recycle `SignalAppPool` after changing application-pool
variables. Never place API keys, client secrets, mail credentials, OAuth token
files, the SQLite database, or data-protection keys in the repository.

For the existing installation:

- run `Configure Signal Google Login.cmd` to store the Google web-client secret;
- follow the Gmail API OAuth section to configure Gmail sending; or
- set the SMTP variables documented above.

Send a real test email after configuring mail. A successful UI action only
proves that the request was accepted; the configured provider and recipient
mailbox must also accept delivery.

### Troubleshooting

- **`ASP.NET Core Module V2 is not registered with IIS`**: install or repair the
  .NET 10 Hosting Bundle after enabling IIS.
- **`The validated IIS package is missing`**: run `npm run iis:build` and confirm
  that `iis-publish\Signal.Server.dll` exists.
- **HTTP 503**: check that both the site and `SignalAppPool` are started, then
  inspect the application pool's recent failures in Windows Event Viewer.
- **HTTP 500.30 or immediate pool shutdown**: inspect the Windows **Application**
  log for ASP.NET Core Module errors and verify that the pool identity can modify
  `C:\inetpub\Signal\App_Data`.
- **Deployment appears stuck in maintenance mode**: read
  `work\full-deploy-result.json`. If no deployment process is still running,
  remove `C:\inetpub\Signal\app_offline.htm` and retry the local health check.
- **Database-related startup failure**: preserve the failed database, then
  restore a verified backup from `App_Data\backups` while Signal is offline.
  Back up the entire `App_Data` directory before any manual recovery.
- **Local certificate warning**: use `https://localhost:8443`; the self-signed
  certificate is created for `localhost`, not for a LAN IP or public hostname.

For recovery or binding repair on the existing installation, an administrator
can run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\work\setup-signal-iis.ps1 -StartOnly
```


## Operational notes

- Scheduled refresh state is stored separately for each user and topic.
- Bookmarked articles are exempt from history retention purges.
- Article reader availability depends on the publisher. When a publisher
  blocks extraction or does not expose enough readable content, Signal opens
  the original article instead.
- Weather location and market ticker overrides are saved per user.
- HTTPS is required for production authentication cookies and installable PWA
  behavior.

## Original Sites build

The earlier OpenAI Sites/Vinext version remains in `app/` and can be built with
`npm run build`. The actively deployed IIS client is in `iis-client/`, and its
server is in `Signal.Server/`.

## License

Signal is available under the [MIT License](LICENSE).
