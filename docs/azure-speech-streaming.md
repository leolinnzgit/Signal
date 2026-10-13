# Azure article audio

When Azure Speech is configured, full-article **Recorded audio** starts a native
MP3 stream. Playback can begin before the article finishes generating. The
**Prepare recording instead** button retains the existing WAV preparation path.
Headline briefings keep their existing pacing and complete WAV recording.

The client creates a session with an authenticated, CSRF-protected POST to
`/api/article-audio-stream`. Its audio element loads the returned same-origin
URL directly. Azure SDK `Synthesizing` events are flushed to that response;
JavaScript polls only paragraph timestamps, completion, and errors. Azure keys
stay on the server. Each session requires the same signed-in user for audio and
status requests.

Completed MP3 streams support byte ranges and replay without another synthesis
request. Sessions last 30 minutes, with at most two per user and eight per
server, and a 16 MiB audio limit each. Closing an unfinished stream disconnects
the native request and cancels synthesis. The server bounds cloud batches and
stream buffering. Stream errors offer retry and the recording fallback.

The private IIS `App_Data/headline-audio-health.json` includes `StreamSucceeded`
and `StreamBytes` from real English/Chinese MP3 synthesis during startup.

Validation commands:

```powershell
npm run iis:typecheck
npm run test:client
dotnet run --project Signal.Server.TopicMatcher.Tests
dotnet run --project Signal.Server.TopicMatcher.Tests -- --azure-stream-live
```

The opt-in live test reads the private IIS Speech settings (or the path in
`SIGNAL_AZURE_TEST_CONFIG`), uses a headless Edge browser, and verifies playback
before HTTP completion, multiple cloud batches, and final audio duration.

See [Microsoft's SDK streaming guidance](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-lower-speech-synthesis-latency#streaming).
