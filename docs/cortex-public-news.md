# Cortex public news

Signal can add up to five ranked public-news matches to Cortex. It combines
keyword matching with vectors generated on the IIS host. The pilot uses the
RNZ national, business and technology feeds and the BBC world, business and
technology feeds. It starts with the stories currently in those feeds and
accumulates a rolling window of up to 30 days, capped at 1,500 articles by default.
The shared index receives the article title, publisher, date, URL, feed summary
and vector. Account history is still searched through the existing Cortex path.

## Enable on IIS

1. In the Azure portal, create an Azure AI Search service using the **Free**
   tier, or use your existing Free service. Under its Keys page, locate one
   admin key and create a query key for Signal. Leave paid add-ons disabled.
2. Install Signal's pinned CPU model on the IIS host from the repository root.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-SignalCortexNewsModel.ps1
   ```

   The script verifies both downloads and places them under the site's
   `App_Data\cortex-news-model` directory, which is preserved during publication.
3. Merge the following section into the site's `appsettings.Production.json`.
   Use the actual endpoint and keys in IIS configuration. Keep them out of Git.

   ```json
   {
     "CortexNews": {
       "Enabled": true,
       "Endpoint": "https://YOUR-SERVICE.search.windows.net",
       "QueryKey": "YOUR-QUERY-KEY",
       "AdminKey": "YOUR-ADMIN-KEY"
     }
   }
   ```

4. Restart the Signal IIS application and open Cortex. The worker creates
   `signal-cortex-news-v1` and refreshes it every 30 minutes. Wait for the
   first refresh to finish. Check the Azure index's document count and Signal's
   refresh logs if no results appear.

The pilot uses the existing IIS CPU and Azure's Free search capacity. It makes
no Azure OpenAI requests. Set `Enabled` to `false` and restart Signal to return
to the existing Cortex results while you diagnose any issues. Azure search
failures and timeouts also fall back to the existing results automatically.

## Verify search quality

Compare the first five public-news matches with the current Cortex news matches.
Use a plain-language query for a topic in the feeds, such as “Why are shipping
costs rising?”, and use a recent named entity or ticker, such as “NVDA”. Check
whether the results link to relevant reporting even when the wording differs.
If the feeds lack coverage of a sample topic, use a current story and test a
paraphrase for it. Check publisher, publication date, links, latency and Azure
index size before widening the feed list.

The server checks can verify the request contract and the real CPU model without
an Azure key. Pass the content root containing the downloaded model.

```powershell
dotnet run --project Signal.Server.TopicMatcher.Tests -- --cortex-news-only "C:\sites\SignalHost"
```
