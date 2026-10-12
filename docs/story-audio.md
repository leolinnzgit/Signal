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

## Local Kokoro recordings

Double-click **Install Signal Kokoro.cmd** after publishing the updated server.
The script uses [uv](https://docs.astral.sh/uv/getting-started/installation/), a
private Python 3.12 environment, pinned packages and verified ONNX model downloads.
It tests English and Mandarin before setting `Speech:Provider` to `Kokoro` in the
private production configuration and restarting Signal. Existing settings,
including Azure credentials, are preserved. No account or API key is needed.

Refresh Signal and select **Recorded audio**. Defaults are Emma (British English)
and Xiaobei (Mandarin); the voice picker exposes the installed English and Mandarin
voices and supports previews. PCs still default to Browser voice. Kokoro provides
its own voices; the sound will differ from the browser voice.

Models and Python remain in `C:\sites\SignalHost\App_Data\Kokoro`, preserved by
deployment. Downloads require internet during setup; synthesis runs locally on CPU
and sends no article text to a speech service. There are no speech API fees.
The full precision model is used because it was substantially faster than the
quantized model on this server. It requires about 354 MB for model assets plus
Python and its packages; allow at least 1 GB during a fresh installation.

On the current server, example English and Mandarin clips took roughly 1.3 times
their spoken duration to prepare once the model loaded. Short requests also have
startup overhead. Articles are prepared in small batches with progress shown;
first preparation can take several minutes for a long story. A persistent worker
keeps the model warm, and the bounded seven-day clip cache reuses repeated text.
Recorded playback and screen-off controls work after preparation finishes.

Run `dotnet run --project Signal.Server.TopicMatcher.Tests -- --kokoro-only` for
adapter checks without models. Use `--kokoro-live` on a server with the default
installation to validate real English/Mandarin output and worker cancellation.
The installer also saves `sample-en.wav` and `sample-zh.wav` in the private runtime
folder for listening. Pass `-SitePath`, `-EnglishVoice`, `-ChineseVoice`, or
`-Threads` to `scripts/Install-SignalKokoro.ps1` to customize installation.

References: [Kokoro model](https://huggingface.co/hexgrad/Kokoro-82M),
[ONNX runtime adapter](https://github.com/thewh1teagle/kokoro-onnx),
[pinned model release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1).

### Prepare audio when news arrives

With Kokoro enabled, newly saved news automatically queues background recordings.
Headlines are prepared first; Signal then extracts each readable full article and
prepares the same 300-character parts used by Listen. When extraction is
unavailable, it prepares the title and feed summary. Saving news and refreshing
topics do not wait for synthesis. The default English/Chinese voices are used;
choosing another voice prepares that recording when requested.

Kokoro already uses four CPU threads inside one synthesis process. Background
work runs at reduced Windows process priority. A playback request with missing
clips cancels background inference and takes priority; ready cached playback
bypasses synthesis entirely. Background work waits five seconds after a foreground
request so consecutive article batches can finish without repeated interruptions.
Cancelled background parts remain queued for retry. Clips completed earlier are
retained in the shared seven-day, 256 MB cache.

The queue holds up to 128 stories, deduplicates identical news across users and
repeated saves, and discards older pending work when full. Restarting Signal
restores up to 128 recent stories seen in the last day. An article can still show
preparation progress if its background job has not finished, its cache expired,
or the user selects another voice. Background preparation requires the server to
remain running and uses CPU while work is pending.

Set `Speech:KokoroPrewarm` to `false` to disable automatic preparation. Private
progress counters are saved in `App_Data/article-audio-preparation.json`; article
text and URLs are excluded from that status file.
