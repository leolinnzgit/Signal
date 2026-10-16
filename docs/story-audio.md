# Listening to individual stories

Each news item has a speaker button labelled **Listen to this news**. It opens
Signal Reader and starts reading the extracted article. If the full text is
unavailable, Signal offers the headline and feed summary, or just the headline
when no summary was provided.

On PCs, headline playback and article narration default to **Recorded audio**.
Phones retain recorded audio as their article default. Users can choose
**Browser voice** or **Recorded audio** in the reader. Recorded audio supports
the existing screen-off playback and device media controls.

At the end of an autoplay headline briefing, Signal says “All caught up. You've
reached the end of your audio briefing.” Browser voice uses the selected voice
and speed. Recorded briefings include the announcement in the audio track, so
it also plays with the screen off. Muted browser briefings finish silently.

Headline playback shows a stock quote for the current headline's followed topics,
including when playback starts from **All topics**. Saved ticker overrides apply
in both audio modes. Quotes update as the briefing advances; topics without a
stock match do not retain the previous company's price. Quotes are reused for
five minutes and refreshed during longer briefings.

Run `node tests/briefing-market.test-browser.mjs` to check quote lookup, automatic
headline transitions, recorded playback, saved tickers, and the All topics
dashboard path. Set `SIGNAL_PLAYWRIGHT_MODULE` to the host's Playwright module
and `SIGNAL_BROWSER_CHANNEL=msedge` when needed.

The **Reading voice** section starts hidden. Select **Show** to choose or preview
a voice, and **Hide** to collapse it. Hiding the section stops any voice preview
without stopping the main narration; saved voice choices are retained.

Browser voice uses the saved browser voice and speed preferences. Its player
supports Play/Pause, Stop, Previous/Next section, voice choice and speaking speed.
Closing the reader or changing the audio mode stops that player. Long text is
read in short chunks, with automatic English/Chinese voice selection.

Both audio modes highlight the current spoken section in the reader. **Follow
reading** keeps that section in view as narration advances; turn it off in the
reader toolbar to browse freely while listening. Pausing keeps the current text
highlighted, and finishing or stopping clears it. Scrolling respects the device's
reduced-motion preference and does not move keyboard focus.

Validate the client with `npm run iis:typecheck` and `npm run test:client`.

## Azure neural recordings

Recorded audio uses Windows voices until an alternative provider is configured. With
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

## Prepare audio when news arrives

With Azure (the primary speech provider) enabled, newly saved news
automatically queues background recordings. Azure preparation is enabled by
default without changing the production key, region, or voice settings.
Headlines are prepared first; Signal then extracts each readable full article and
prepares the same parts used by Listen (up to 900 characters). The briefing's
closing announcement is also cached. When extraction is
unavailable, it prepares the title and feed summary. Saving news and refreshing
topics do not wait for synthesis. The default English/Chinese voices are used;
choosing another voice prepares that recording when requested.

Azure requests prepare several article parts at a time and save clips in the
existing seven-day, 256 MiB disk cache, with lossless compression to save space.
Headline playback assembles cached clips
with the selected gaps without another synthesis request. The article player
serves complete cached articles as WAV recordings through its authenticated,
user-owned media URL; uncached stories continue to stream MP3 audio as it arrives.
Preparing new Azure text uses the configured Speech resource, including text
that the user may not subsequently listen to. Identical saved text and voices
reuse clips across users and server restarts.

A recorded playback request with missing clips cancels background preparation
and takes priority; ready cached playback
bypasses synthesis entirely. Background work waits five seconds after a foreground
request so consecutive article batches can finish without repeated interruptions.
Cancelled background parts remain queued for retry. Clips completed earlier are
retained in the shared seven-day, 256 MB cache.

The queue holds up to 128 stories, deduplicates identical news across users and
repeated saves, and discards older pending work when full. Restarting Signal
restores up to 128 recent stories seen in the last day. An article can still show
preparation progress if its background job has not finished, its cache expired,
or the user selects another voice. Background preparation requires the server to
remain running. Azure uses the configured cloud Speech resource.

Set `Speech:Prewarm` to `false` to disable Azure automatic preparation. Private
progress counters are saved in `App_Data/article-audio-preparation.json`; article
text and URLs are excluded from that status file.
