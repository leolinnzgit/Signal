# Signal Reader extraction

The IIS server first fetches the public HTTPS article and compares publisher JSON-LD
article text with a Readability-based DOM extraction using SmartReader. Short
metadata excerpts no longer prevent HTML extraction. If those results are too
short, the reader checks the page's actual paragraph containers.

If static extraction still finds fewer than 300 characters, Signal renders the
page with Playwright and retries the same extraction. On Windows this uses the
installed Microsoft Edge browser, with no personal browser profile or login
cookies. Edge must be installed for the IIS account to launch it. On other
platforms, install Playwright Chromium after building the server:

```powershell
powershell -File Signal.Server/bin/Debug/net10.0/playwright.ps1 install chromium
```

Browser rendering is limited to two concurrent pages, 25 seconds per request,
60 resource requests and 8 MB of fetched resource text. Resources are fetched
through an HTTP client with manual, validated redirects. Requests to internal
addresses, WebSockets, downloads and non-GET requests are blocked. DNS addresses
are checked again when connecting. Each extraction is limited to 80 paragraphs
and 30,000 characters. Successful results are cached for 30 minutes, failures
for five minutes.

Subscription metadata, paywall previews and HTTP access denials return an
explanation and the original publisher link. They do not trigger browser
rendering. A parser failure now says it could not find enough article text,
rather than assuming the publisher blocked it. Some articles will still need
the original page, especially when login, bot verification or unsupported
publisher scripts are required.

Run the extraction regression checks:

```powershell
dotnet run --project Signal.Server.TopicMatcher.Tests -- --article-reader-only
```

Run the real browser fixture, including JavaScript rendering and private-address
redirect rejection (requires Edge on Windows or installed Chromium elsewhere):

```powershell
dotnet run --project Signal.Server.TopicMatcher.Tests -- --article-reader-browser
```
