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

Create the deployable application:

```powershell
npm run iis:build
```

The output is written to `iis-publish`.

1. Install the .NET 10 Hosting Bundle on the IIS server.
2. Create an IIS site and an application pool configured with **No Managed
   Code**.
3. Copy the contents of `iis-publish` into the site's physical directory.
4. Grant the application-pool identity **Modify** permission on `App_Data`.
5. Configure Gmail OAuth, SMTP, or keep file delivery for local testing.
6. Add an HTTPS binding and redirect HTTP to HTTPS before allowing real users.
7. Recycle the application pool.

Signal creates `App_Data/signal.db` on first startup. Back up the complete
`App_Data` directory before deployments or schema changes because it also
contains the data-protection keys required to read existing authentication
cookies and encrypted Gmail credentials.

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
