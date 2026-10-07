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

- Follow any number of topics and move quickly to the next unread topic using
  a floating navigation bar with previous topic, next unread, back-to-top,
  and add-topic shortcuts that can be switched between sides of the viewport.
- Collect stories from Google News, GDELT, and up to 20 custom RSS or Atom
  publisher feeds with source-balanced selection that prevents aggregators
  from crowding out direct publisher content.
- Deduplicate feeds and articles before they enter the briefing.
- Refresh topics on independent schedules from 5 minutes to 8 hours, or
  refresh them manually.
- Receive Web Push notifications when scheduled refreshes find new stories,
  and see unread counts on the OS app badge.
  In Settings, **Show each news title** is on by default and sends a separate
  notification with each new story's title, publisher, and a short summary from
  the news feed when available (up to 180 characters). Turn it off for topic
  summaries. This preference applies to all notification-enabled devices on
  your account; notification permission is still enabled separately per device.
- Store article history in SQLite with topic and source filters, pagination,
  and multi-term search.
- Bookmark stories indefinitely while automatically purging unbookmarked
  history on a configurable schedule (from 1 day to 1 year).
- Track read status and show unread indicators whenever a topic receives new
  stories.
- Play unread headlines across all topics with the floating play button. The
  full-screen, title-only briefing shows each title for at least six seconds, with pause,
  previous/next, and speed controls. Read-aloud is on by default in supported
  browsers and finishes each title before advancing; the voice toggle mutes it.
  Automatic voice selection prefers voices labelled Natural, Neural, Enhanced,
  Premium, or Google when available, with a relaxed default speaking speed and
  a brief pause between titles. Choose a reading voice and speaking speed in
  the player; choices are remembered on that device, with a voice saved for each language.
  Pause also pauses speech, and skipping or closing stops it. Displayed
  headlines are marked as read; closing early leaves unseen stories unread.
  Choose a headline to jump to a story and pause playback. **Read article** opens
  Signal Reader, **Open original** opens the publisher in a new tab and pauses
  the briefing, and **Back to news** returns to the feed at any time.
  **Read full news aloud** pauses headline playback, opens the article reader,
  and prepares the article title and all available extracted paragraphs with
  the server's female voices. The reader also has this button for articles opened
  from the feed. Full article audio has play/pause, seeking, speaking speed,
  lock-screen media controls and separate English and Chinese reading voice
  selectors. Available server voices
  show their names, gender and language; choices are saved on the device and
  shared with screen-off headline audio. Changing a voice prepares a new
  recording from the current article section or headline. Automatic selection
  still prefers female voices if a saved voice is no longer installed.
  Tap Play if the browser blocks automatic playback.
  Closing the reader cancels preparation and stops its narration. Publishers that
  block extraction show an explanation and a link to read the original article.
  With voice on, narration continues when you switch tabs or minimize the
  browser. Muted playback pauses while hidden, and manual Pause always applies.
  Leaving native fullscreen keeps the briefing running; use **Close** or
  **Back to news** to end playback.
  For screen-off listening, choose **Screen-off audio**, wait for the entire
  recording to be prepared, and tap **Play** before locking the device. Signal
  opens this mode by default in the installed Android app. On Samsung phones,
  check **Settings → Battery → Background usage limits** if recorded audio
  stops after pressing Home; exclude Signal (or its installing browser) from
  sleeping apps. The player includes a link to Samsung's guidance.
  Signal creates one continuous audio track with English and Chinese voices installed
  on the Windows server, preferring female voices in both languages and including
  the pauses between headlines. Supported
  browsers expose lock-screen play/pause and headline navigation controls.
  **Preview voice** plays a short sample of the selected English or Chinese
  voice before a reading. Previewing pauses current narration; switching voices
  or closing the reader cancels the sample. Samples reuse the private clip cache.
  This mode uses the server's voices; **Use browser voice** returns to the usual
  voice picker. Recordings are kept in the browser for the current briefing and
  are released when you close it. Long briefings are prepared in small batches,
  with progress shown, then joined into one recording before playback. There is
  no 200-headline limit on the briefing. Preparation requires Windows server
  speech voices. Individual narration clips are cached privately on the server
  in `App_Data/HeadlineAudioClips` for seven days, with a 256 MiB cache limit.
  Repeat headlines reuse their clips across briefings and display intervals.
  Recordings use HTTP Brotli/gzip compression to reduce download time, including
  the silent gaps. New headlines still require speech preparation; these Windows
  voices are older speech voices rather than modern neural narration.
  Speech generation uses native Windows SAPI on a dedicated STA thread in a
  disposable child process with a 45-second deadline
  per batch. Closing preparation cancels that worker, and a timeout releases the
  queue for later attempts. A startup check verifies a full 50-headline English/Chinese batch and records synthesis
  results privately in `App_Data/headline-audio-health.json` under the server's
  actual account.
  On IIS, Windows may restrict the profile's `Speech_OneCore/Isolated` registry
  key to interactive users. If the private startup check reports a registry
  error, run `scripts/Repair-SignalSpeechProfile.ps1 -Permission FullControl -VerifyProductionAudio`
  once from elevated Windows PowerShell. The script backs up the original permissions
  and grants only the specified pool full access to that single key in its own
  loaded user profile. It temporarily takes ownership to update the permissions
  and restores the original owner. It restarts that pool and tests production audio;
  a failed test restores the permissions from before the repair attempt.
  Phone screen-lock and background playback depend on the browser and operating
  system keeping the page active; browser speech cannot guarantee uninterrupted
  playback when the page is suspended.
- Read supported articles inside Signal, with an automatic fallback to the
  publisher's original page when extraction is blocked or paywalled.
- Display feed images when publishers provide them.
- Discuss articles with other Signal users through per-article comment
  threads and a site-wide latest-comments feed.
- Find friends by email, send and accept friend requests, and see real-time
  online presence.
- Send direct messages to friends with an emoji picker, paginated message
  history, a Web Audio chime on incoming messages, and a minimizable floating
  chat dock.
- Share stories directly to a friend's conversation. If the friend is
  offline, Signal automatically sends an email notification.
- Upload a profile photo or capture one from a device camera, with
  client-side square crop to 512×512 JPEG and server-side binary validation.
- Suggest publishers and current Google Trends from up to 20 English- and
  Mandarin-speaking regions with configurable trend counts per region.
- Show current market pricing for matching topics, with manual ticker
  overrides, including qualified NZX symbols such as `AIR:NZX`.
- Show current conditions and a seven-day forecast for a weather location
  searched by city or region worldwide, or from device GPS.
- Display a secondary time zone clock searched from cities worldwide via
  Open-Meteo geocoding.
- Send a formatted email briefing after scheduled refreshes.
- Adjust story and topic heading sizes, independently toggle pinned topic and
  source filter visibility, switch between light and dark themes, and install
  Signal as a progressive web app with platform-specific installation help.
- Automatically detect new deployments and reload the client.
- Protect each account with confirmed email, secure cookies, CSRF protection,
  password reset, login lockout, rate-limited account endpoints, and optional
  Google account sign-in with password linking.

## Technology

| Area | Implementation |
| --- | --- |
| Client | React 19, TypeScript, Vite |
| Server | ASP.NET Core 10 |
| Authentication | ASP.NET Core Identity |
| Data | Entity Framework Core and SQLite |
| News | Google News, GDELT, RSS, and Atom |
| Market data | Twelve Data |
| Weather & Clocks | Open-Meteo weather and geocoding APIs |
| Push notifications | VAPID Web Push (RFC 8291/8292) and OS App Badging API |
| Social & Messaging | Direct messages, friend relationships, presence, and comments |
| Email | Gmail API OAuth, SMTP, or local mail-drop |
| Hosting | IIS with optional Tailscale Funnel access |
| Installability | Web app manifest and service worker |

## Repository layout

```text
iis-client/                         React client used by the IIS application
Signal.Server/                      ASP.NET Core API, scheduler, and web host
Signal.Server.TopicMatcher.Tests/   Server-side integration and unit tests
Signal.GmailSetup/                  Windows Gmail OAuth setup utility
public/                             Shared images, icons, manifest, service worker
tests/                              Client unit and rendered HTML tests
scripts/                            Configuration helper scripts (Google Login)
work/                               IIS deployment, backup, and operational scripts
build/                              Build plugins for earlier Sites/Vinext platform
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
their email addresses match. Accounts created via Google sign-in can also set
an account password in settings to enable direct password login.

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

To launch the setup utility easily on Windows, run `Configure Signal Gmail.cmd`
with the path to your client secret JSON file:

```cmd
"Configure Signal Gmail.cmd" "C:\path\to\client_secret.json"
```

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

For Gmail accounts using an App Password, helper scripts are provided in `work/`:
- `work/configure-signal-gmail.ps1` (command line)
- `work/configure-signal-gmail-gui.ps1` (Windows graphical interface)

Recycle the application pool after changing its environment variables.

## Validation

Run the client type check, production build, client unit tests, and server integration tests:

```powershell
npm run iis:typecheck
npm run iis:client:build
npm run test:client
npm run test:server
```

Or run all verification tests in a single command:

```powershell
npm run iis:test
```

- **Client unit tests** (`npm run test:client`): Verify app badge normalization,
  Web Share link resolution and HTTPS enforcement, profile photo square crop
  geometry and file type limits, IANA timezone validation, publisher suggestion
  matching, and token/phrase matching.
- **Server test suite** (`npm run test:server` or `dotnet run --project Signal.Server.TopicMatcher.Tests`): Integration and unit
  tests covering core subsystems: topic relevance matching, feed URL
  canonicalization and tracking stripping, profile photo binary validation,
  market ticker parsing and Twelve Data quote handling, Google Trends regional
  caching, article reader extraction and redirects, SQLite multi-term history
  search, and background topic refresh scheduling with cross-device version cursors.
  (`dotnet test Signal.Server.TopicMatcher.Tests` is also supported to verify compilation).

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
- 7-Zip (`C:\Program Files\7-Zip\7z.exe`), used for encrypted disaster-recovery backups

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
recommended routine deployment command. It runs `work/deploy-signal-without-uac.ps1`
using `app_offline.htm` without requiring administrative elevation.

Alternatively, `Update Signal Website.cmd` provides a double-clickable Windows command
file that invokes `work\setup-signal-iis.ps1 -DeployUpdate` (which stops and restarts
the application pool and requests administrator elevation).

During each deployment, the update script:

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

To ensure the IIS application pool stays running continuously without idle timeouts
and starts automatically when IIS boots:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\work\configure-signal-background-refresh.ps1
```

This sets `startMode: AlwaysRunning`, `processModel.idleTimeout: 00:00:00`, and
`preloadEnabled: true` on the `Signal/` IIS application.

### Disaster recovery backups

Routine deployments create automatic unencrypted SQLite database backups in
`C:\inetpub\Signal\App_Data\backups`. For full-system disaster recovery, run
`New-SignalDisasterRecoveryBackup.ps1` from an elevated prompt:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\work\New-SignalDisasterRecoveryBackup.ps1
```

This script prompts for an encryption passphrase (minimum 16 characters) and
creates a transactionally consistent, AES-256 encrypted 7-Zip archive containing
the entire `App_Data` folder—including the SQLite database, machine-wide Data
Protection keys, and OAuth credentials. Archives are stored in:

```text
D:\Backup\Signal\DisasterRecovery
```

### Security and permissions hardening

To harden permissions on the operational data directory, an administrator can run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\work\Set-SignalDataAcl.ps1
```

This script restricts access to `C:\inetpub\Signal\App_Data` and its backups folder
so that only `IIS AppPool\SignalAppPool`, `NT AUTHORITY\SYSTEM`, `Administrators`,
and the designated deployment user have access, removing inheritance and any broader
user access.

### Tailscale Funnel and tunnel recovery

When hosting Signal publicly via Tailscale Funnel (`https://signal.tail445c22.ts.net/`),
routing issues may occasionally occur after Windows network or adapter changes. Helper
scripts in `work/` assist with diagnosing and fixing tunnel connectivity:

- `work/Repair-SignalTunnelRouting.ps1`: Configures the Tailscale Windows service with
  `TS_BIND_TO_INTERFACE_BY_ROUTE=true` and restarts the service.
- `work/Restore-SignalTunnel.ps1`: Restarts the Tailscale service, inspects funnel status,
  and tests HTTPS responses from the public funnel domain.

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
- User preferences are saved per user in SQLite, including weather location,
  secondary time zone, market ticker overrides, pinned filter visibility,
  trend regions, and story limits.
- Web Push notifications and subscriptions are stored per user and endpoint,
  automatically pruning expired endpoints.
- Direct messages and friend relationships are persisted in SQLite, with
  automatic offline email dispatch when sharing stories with inactive friends.
- HTTPS is required for production authentication cookies, Web Push, and installable
  PWA behavior.

## Original Sites build

The earlier OpenAI Sites/Vinext version remains in `app/` and can be built with
`npm run build`. The actively deployed IIS client is in `iis-client/`, and its
server is in `Signal.Server/`.

## License

Signal is available under the [MIT License](LICENSE).
