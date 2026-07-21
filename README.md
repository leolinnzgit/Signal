# Signal

Signal is an authenticated personal news monitor. The IIS build uses ASP.NET
Core Identity for email/password accounts and a React client for the news
dashboard.

## Account features

- email registration with confirmation
- secure Identity password hashing and session cookies
- login lockout after repeated failures
- forgotten-password email and reset links
- authenticated password changes
- CSRF-protected account actions
- authenticated Google News, GDELT, and custom RSS/Atom feeds

## Requirements

- Node.js 22.13 or newer
- .NET 10 SDK for development
- IIS with the .NET 10 Hosting Bundle for deployment
- a Gmail account with two-step verification and an app password

## Local development

Build the React client and start the ASP.NET Core server:

```powershell
npm install
npm run iis:client:build
dotnet run --project Signal.Server/Signal.Server.csproj --launch-profile http
```

Open `http://127.0.0.1:5168`.

Development account emails are written to
`Signal.Server/App_Data/maildrop` instead of being sent. Open the newest HTML
file to test confirmation and password-reset links.

For client hot reload, run `npm run iis:client:dev` in a second terminal while
the ASP.NET server is running, then open `http://127.0.0.1:3000`.

## Gmail SMTP configuration

Never commit the Gmail password or app password. Configure these environment
variables on the IIS server:

```text
Smtp__Mode=Smtp
Smtp__Host=smtp.gmail.com
Smtp__Port=587
Smtp__EnableSsl=true
Smtp__Username=your-address@gmail.com
Smtp__AppPassword=your-16-character-app-password
Smtp__FromAddress=your-address@gmail.com
Smtp__FromName=Signal
```

Use a Gmail app password, not the normal Gmail account password. Recycle the
application pool after changing environment variables.

## Build for IIS

```powershell
npm run iis:build
```

The deployable application is produced in `iis-publish`.

1. Install the current .NET 10 Hosting Bundle on the IIS server.
2. Copy the contents of `iis-publish` into the IIS site's physical directory.
3. Use an application pool configured with **No Managed Code**.
4. Grant the application-pool identity **Modify** permission on the
   `App_Data` directory so SQLite and data-protection keys can be written.
5. Configure the Gmail environment variables above.
6. Add an HTTPS binding and redirect HTTP to HTTPS before allowing real users.
7. Recycle the application pool.

The SQLite account database is created at `App_Data/signal.db`. Back up that
file regularly and before deploying schema changes.

## Original Sites build

The prior OpenAI Sites/Vinext implementation remains in `app/` and can still be
built with `npm run build`. The IIS entry point is `iis-client/`, and the IIS
server is `Signal.Server/`.
