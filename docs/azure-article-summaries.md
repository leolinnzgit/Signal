# Azure article summaries

Open **Configure Signal Summaries.cmd** in the repository directory. It has the
Signal Language resource endpoint prefilled and prompts for Key 1 without
displaying it. The helper validates the credentials, preserves other production
settings and stores `AzureLanguage:Endpoint` and `AzureLanguage:Key` only in
`C:\sites\SignalHost\appsettings.Production.json`. Do not commit that file.

For a different installation, run `scripts/Configure-SignalSummaries.ps1` with
`-Endpoint` and `-SitePath`. Development can use .NET user secrets with the same
configuration names. Environment variables are `AzureLanguage__Endpoint` and
`AzureLanguage__Key`. Existing Speech settings are independent and unchanged.

Opening a readable article prepares an Azure AI Language abstractive summary
from the extracted article text and displays it above the full article. Summary
audio starts automatically using the existing recorded narration engine. If a
browser blocks autoplay, tap its Play control. Choose **Read full article** to
switch narration; changing modes or closing the reader stops the previous audio.
The explicit full-news playback action continues to start full article audio.

Summaries are cached in server memory for 24 hours by the extracted text. Updated
text generates a new summary. Restarting the server clears that cache. Publishers
that block article extraction cannot receive full-text summaries. Azure errors
leave the article available and offer a retry. No cloud calls occur without
configured credentials. Text summarization is requested in English or Simplified
Chinese based on the article's text; unsupported languages may be rejected by
Azure. The original is available alongside the AI summary.

Implementation follows [Microsoft's asynchronous summarization API](https://learn.microsoft.com/en-us/azure/ai-services/language-service/summarization/how-to/summarize)
using the stable `2023-04-01` version. Summary requests require authentication,
the application's CSRF token and account rate limiting. API credentials remain
on the server; article text is submitted to Azure with `loggingOptOut` enabled.
