# Signal Reader translation

Open an article in Signal Reader, choose a language under **Translate to**, and
select **Translate**. The title and full extracted article text are translated
with Azure Translator. **Show original** restores the publisher's text. You can
listen to the translated article using the reader's audio controls. The article
summary is shown in the original view.

Supported target languages are English, Simplified and Traditional Chinese,
Japanese, Korean, French, German, Spanish, Italian, Portuguese, Arabic and Hindi.
Azure detects the source language. Translation is requested only when selected;
opening a story does not translate it. Successful results are cached in server
memory for 24 hours, by text and target language. A server restart clears this cache.

## Configure the IIS deployment

Run `Configure Signal Translator.cmd` on the IIS machine. Enter the resource's
region identifier from Azure's **Keys and Endpoint** page (for example,
`australiaeast`), or leave it blank for a global Translator resource. Paste the
Translator key into the hidden prompt. The script validates a short translation
before saving only the `AzureTranslator` section in the deployment's private
`appsettings.Production.json`; other settings are preserved. The configuration
survives routine publication.

The default endpoint is `https://api.cognitive.microsofttranslator.com/`. To use
a custom Azure resource endpoint or a different IIS directory, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Configure-SignalTranslator.ps1 -Endpoint "https://your-resource.cognitiveservices.azure.com/" -SitePath "C:\sites\SignalHost"
```

For development, use .NET user secrets:

```powershell
dotnet user-secrets set "AzureTranslator:Key" "YOUR_KEY" --project Signal.Server
dotnet user-secrets set "AzureTranslator:Region" "YOUR_REGION" --project Signal.Server
```

Equivalent server environment variables are `AzureTranslator__Key`,
`AzureTranslator__Region`, and optional `AzureTranslator__Endpoint`. Credentials
are never sent to the browser. Without a key, Translate explains that Azure
Translator has not been configured and keeps the original article visible.
Articles whose full text cannot be extracted cannot be translated.

API reference: [Microsoft Azure Translator Translate](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate).
