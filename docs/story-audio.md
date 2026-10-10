# Listening to individual stories

Each news item has a speaker button labelled **Listen to this news**. It opens
Signal Reader and starts reading the extracted article. If the full text is
unavailable, Signal offers the headline and feed summary, or just the headline
when no summary was provided.

On PCs with browser speech support, article narration defaults to **Browser
voice**, using the same saved voice and speed preferences as headline playback.
The player supports Play/Pause, Stop, Previous/Next section, voice choice and
speaking speed. Closing the reader or changing the audio mode stops that player.
Long text is read in short chunks, with automatic English/Chinese voice selection.

Phones retain recorded audio as their default. Users can choose **Browser voice**
or **Recorded audio** in the reader. Recorded audio supports the existing
screen-off playback and device media controls.

Validate the client with `npm run iis:typecheck` and `npm run test:client`.

## Azure neural recordings

Recorded audio uses the existing Windows voices until Azure is configured. With
`Speech:Provider` set to `Azure`, both full articles and screen-off headline
briefings use Azure's standard neural voices. Browser playback remains available.
The recording voice picker and its previews list the English and Chinese neural
voices offered by the configured Azure region. Saved Windows selections fall
back to the new defaults: Molly (New Zealand English) and HsiaoChen (Taiwan Chinese).
An exact match with a browser voice requires that Azure offers that same voice;
voice availability varies by browser and device.

1. Sign up at <https://azure.microsoft.com/free/> and open <https://portal.azure.com/>.
2. Create a **Speech** resource. Choose a resource group, name such as
   `signal-speech`, region, and **Free F0** if available. The free tier currently
   includes 500,000 neural text-to-speech characters per month. Standard S0 is paid.
3. Select **Review + create**, then **Create**. After deployment, go to the resource.
4. Open **Keys and Endpoint**. Find **Key 1** and the **Region** identifier.
5. On the Signal server PC, double-click **Configure Signal Speech.cmd** at the
   repository root. Enter the region, then paste Key 1 into its hidden prompt.
   The command verifies the key and voices before changing anything. It saves
   the settings in `C:\sites\SignalHost\appsettings.Production.json`, preserves
   other settings, and restarts Signal. The key stays out of the source and client.
6. Refresh Signal to clear any recording from the previous engine. In a story,
   select **Recorded audio** and use **Preview voice**.

The equivalent PowerShell command is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Configure-SignalSpeech.ps1"
```

For an alternate IIS directory, pass `-SitePath`. For different default voices,
pass `-EnglishVoice` and/or `-ChineseVoice` using Azure voice short names. Both
must be available standard neural English/Chinese voices in your chosen region.
ASP.NET Core can also read `Speech__Provider`, `Speech__Key`, `Speech__Region`,
`Speech__EnglishVoice`, and `Speech__ChineseVoice` from server environment variables.
For local development, use .NET user secrets rather than putting keys in source.

New clips are grouped into SSML requests (at most 4,000 characters and 50 voices),
with bookmarks to preserve exact speech boundaries. Repeated clips are reused
from the bounded, seven-day server cache; screen gaps are assembled locally.
Azure errors and quota exhaustion show a clear message and let the user choose
Browser voice. They do not silently switch to Windows narration. The free tier
also has a 20-requests-per-minute limit. Azure synthesis sends the text to Microsoft;
playing a cached recording does not require a new synthesis request.

References: [resource setup](https://microsoftlearning.github.io/mslearn-ai-language/Instructions/Exercises/07-speech.html?azure-portal=true),
[pricing](https://azure.microsoft.com/en-us/pricing/details/speech/),
[quotas](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits),
[SDK synthesis and bookmarks](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis?pivots=programming-language-csharp).

Run `dotnet run --project Signal.Server.TopicMatcher.Tests -- --azure-speech-only`
for the isolated cloud-adapter checks. They use a fake synthesizer and require no
account or billable calls. Actual Azure voice quality and the deployed IIS identity
must be checked after entering a real resource key.
