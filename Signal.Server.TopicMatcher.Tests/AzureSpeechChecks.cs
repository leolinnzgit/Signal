using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class AzureSpeechChecks
{
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static async Task RunLiveAsync()
    {
        var path = Environment.GetEnvironmentVariable("SIGNAL_AZURE_TEST_CONFIG") ?? @"C:\sites\SignalHost\appsettings.Production.json";
        using var configuration = JsonDocument.Parse(await File.ReadAllTextAsync(path));
        var settings = configuration.RootElement.GetProperty("Speech").Deserialize<AzureSpeechOptions>()!;
        settings.Validate();
        Assert(settings.Enabled, "The live Speech configuration must select Azure.");
        var synth = new LiveSynthesizer(new AzureSpeechSynthesizer(Options.Create(settings)));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var directory = Path.Combine(Path.GetTempPath(), "SignalAzureLive-" + Guid.NewGuid().ToString("N"));
        try
        {
            using var client = new HttpClient();
            var renderer = new AzureSpeechAudioRenderer(Options.Create(settings), client, synth, directory);
            var disabled = Options.Create(new KokoroSpeechOptions { Provider = settings.Provider });
            var service = new HeadlineAudioService(renderer, new KokoroAudioRenderer(disabled, new UnusedKokoroWorker(), directory));
            var request = new HeadlineAudioRequest(["Signal audio is ready.", "語音已準備好。", "Signal audio is ready."], 3,
                Voices: new Dictionary<string, string> { ["en"] = "kokoro/bf_emma", ["zh"] = "kokoro/zf_xiaobei" });
            Assert(await service.TryPrepareInBackgroundAsync(request, timeout.Token), "Live Azure could not save its background recording.");
            var recording = await service.GenerateAsync(request, timeout.Token);
            Assert(service.EngineName == "azure-neural" && HeadlineAudioHealthCheck.IsCompleteRecording(recording, 3, 3),
                "Live Azure did not produce complete English and Chinese narration after switching from Kokoro.");
            await service.GenerateAsync(request with { Seconds = 6 }, timeout.Token);
            Assert(synth.Calls == 1, "Live replay did not reuse the cached Azure clips.");
            Console.WriteLine("Live Azure passed background preparation, English/Chinese audio, stale Kokoro voice fallback, timing, duplicate reuse and cached playback.");
        }
        finally { if (Directory.Exists(directory)) { foreach (var file in Directory.GetFiles(directory)) File.Delete(file); Directory.Delete(directory); } }
    }

    public static async Task RunAsync()
    {
        new AzureSpeechOptions().Validate();
        foreach (var settings in new[] {
            new AzureSpeechOptions { Provider = "Azure" },
            new AzureSpeechOptions { Provider = "Azure", Key = "valid-length-test-key", Region = "example.com/path" },
            new AzureSpeechOptions { Provider = "Azure", Key = "invalid key with spaces", Region = "australiaeast" },
        })
        {
            try { settings.Validate(); throw new Exception("Invalid Azure configuration was accepted."); }
            catch (HeadlineAudioUnavailableException exception) when (exception.Code == "configuration") { }
        }
        CheckIncompleteAudio();
        var directory = Path.Combine(Path.GetTempPath(), "SignalAzureTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var settings = new AzureSpeechOptions { Provider = "Azure", Key = "test-key-that-is-not-a-real-credential", Region = "australiaeast" };
            var handler = new VoiceHandler();
            using var client = new HttpClient(handler);
            var synth = new FakeSynthesizer();
            var renderer = new AzureSpeechAudioRenderer(Options.Create(settings), client, synth, directory);
            var service = new HeadlineAudioService(renderer);
            var voices = await service.GetVoicesAsync(CancellationToken.None);
            Assert(voices.Count == 4 && !voices.Any(voice => voice.Id.Contains(':')) && service.EngineName == "azure-neural", "The picker included preview, HD or unsupported voices.");
            Assert(AzureSpeechAudioRenderer.ChooseVoice(voices, "en-NZ", false, "en-US-GuyNeural", settings.EnglishVoice).Id == "en-US-GuyNeural"
                && AzureSpeechAudioRenderer.ChooseVoice(voices, "en-NZ", false, "old-windows-voice", settings.EnglishVoice).Id == "en-NZ-MollyNeural"
                && AzureSpeechAudioRenderer.ChooseVoice(voices, "zh-CN", true, "en-US-GuyNeural", settings.ChineseVoice).Id == "zh-TW-HsiaoChenNeural", "Voice selection or language fallback failed.");
            var titles = new[] { "<script>News & \"quotes\" 🚀.</script>", "今天的新聞。", "<script>News & \"quotes\" 🚀.</script>" };
            var recording = await service.GenerateAsync(new HeadlineAudioRequest(titles, 3), CancellationToken.None);
            Assert(HeadlineAudioHealthCheck.IsCompleteRecording(recording, 3, 3) && synth.Calls == 1 && synth.Clips == 2 && handler.Calls == 1
                && synth.Texts.Contains(titles[0] + ".") && synth.Voices[0] == "en-NZ-MollyNeural" && synth.Voices[1] == "zh-TW-HsiaoChenNeural"
                && BitConverter.ToInt32(recording.Wave, 4) == recording.Wave.Length - 8 && BitConverter.ToInt32(recording.Wave, 40) == recording.Wave.Length - 44,
                "Neural batching lost text, voices, bookmarks, timing or duplicate reuse.");
            Assert(recording.Wave.AsSpan(44, 19_200).SequenceEqual(recording.Wave.AsSpan(44 + (int)(recording.Starts[2] * 32_000), 19_200)), "Duplicate clips differed.");
            var warm = await service.GenerateAsync(new HeadlineAudioRequest(titles, 6), CancellationToken.None);
            Assert(synth.Calls == 1 && warm.Starts[1] == 6 && handler.Calls == 1, "Replaying or changing the gap made another cloud request.");
            var reopened = new AzureSpeechAudioRenderer(Options.Create(settings), client, synth, directory);
            await reopened.GenerateAsync(new HeadlineAudioRequest(titles, 3), CancellationToken.None);
            Assert(synth.Calls == 1, "Azure clips were not reused after reopening the cache.");
            await service.GenerateAsync(new HeadlineAudioRequest([titles[0]], 3, Voices: new Dictionary<string, string> { ["en"] = "en-US-GuyNeural" }), CancellationToken.None);
            Assert(synth.Calls == 2 && synth.Voices.Last() == "en-US-GuyNeural", "A new neural voice reused the old recording.");
            var unique = Enumerable.Range(0, 50).Select(index => $"Headline {index}: " + new string('a', 100)).ToArray();
            var before = synth.Calls;
            var batch = await service.GenerateAsync(new HeadlineAudioRequest(unique, 3), CancellationToken.None);
            Assert(HeadlineAudioHealthCheck.IsCompleteRecording(batch, 50, 3) && synth.Calls - before == 2 && synth.LargestBatchCharacters <= 4_000 && synth.LargestBatchClips <= 50,
                "A long briefing exceeded cloud batching limits or lost timing.");
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            synth.Hold = entered;
            using var abort = new CancellationTokenSource();
            var cancelled = service.GenerateAsync(new HeadlineAudioRequest(["Cancel this new headline"], 3), abort.Token);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); abort.Cancel();
            try { await cancelled; throw new Exception("Azure synthesis ignored cancellation."); } catch (OperationCanceledException) { }
            synth.Hold = null;
            await service.GenerateAsync(new HeadlineAudioRequest(["Read after cancellation"], 3), CancellationToken.None);
            synth.Failure = new HeadlineAudioUnavailableException("quota", "Azure request limit reached.");
            try { await service.GenerateAsync(new HeadlineAudioRequest(["Quota test"], 3), CancellationToken.None); throw new Exception("A quota error was silently replaced by Windows speech."); }
            catch (HeadlineAudioUnavailableException exception) when (exception.Code == "quota") { }
            synth.Failure = null;
            await service.GenerateAsync(new HeadlineAudioRequest(["Quota test"], 3), CancellationToken.None);
            await CheckBackgroundPriorityAsync(renderer, synth, titles[0]);
            var optedOut = new HeadlineAudioService(new AzureSpeechAudioRenderer(Options.Create(new AzureSpeechOptions {
                Provider = "Azure", Prewarm = false, Key = settings.Key, Region = settings.Region
            }), client, synth, directory));
            Assert(!await optedOut.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Disabled background request"], 3), default),
                "Azure preparation ignored its explicit opt-out.");
            var blockedCache = Path.Combine(directory, "blocked-cache");
            File.WriteAllText(blockedCache, "A file cannot contain cache clips.");
            var cannotSave = new HeadlineAudioService(new AzureSpeechAudioRenderer(Options.Create(settings), client, synth, blockedCache));
            try { await cannotSave.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Unsaved Azure background clip"], 3), default); throw new Exception("An unsaved Azure clip was reported as prepared."); }
            catch (HeadlineAudioUnavailableException exception) when (exception.Code == "cache") { }
            handler.Status = HttpStatusCode.Unauthorized;
            var denied = new AzureSpeechAudioRenderer(Options.Create(settings), client, synth, directory);
            try { await denied.GetVoicesAsync(CancellationToken.None); throw new Exception("An invalid key was accepted."); }
            catch (HeadlineAudioUnavailableException exception) when (exception.Code == "voices") { Assert(!exception.ToString().Contains(settings.Key), "A credential escaped into a diagnosis."); }
        }
        finally { foreach (var file in Directory.GetFiles(directory)) File.Delete(file); Directory.Delete(directory); }
        Console.WriteLine("Azure neural recordings passed voices, escaped SSML, bookmark timing, batching, cache reuse, cancellation and quota checks without cloud calls.");
    }

    private static async Task CheckBackgroundPriorityAsync(AzureSpeechAudioRenderer renderer, FakeSynthesizer synth, string cachedTitle)
    {
        var service = new HeadlineAudioService(renderer);
        synth.Hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var background = service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Azure background story"], 3), default);
        await synth.Hold.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var before = synth.Calls;
        var ready = await service.GenerateAsync(new HeadlineAudioRequest([cachedTitle], 6), default);
        Assert(!background.IsCompleted && synth.Calls == before && HeadlineAudioHealthCheck.IsCompleteRecording(ready, 1, 6),
            "Cached Azure playback waited for or cancelled background synthesis.");
        synth.Hold = null;
        var foreground = await service.GenerateAsync(new HeadlineAudioRequest(["Azure requested story"], 3), default);
        Assert(!await background && HeadlineAudioHealthCheck.IsCompleteRecording(foreground, 1, 3), "Azure playback did not preempt background preparation.");
        Assert(!await service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Azure between HTTP batches"], 3), default),
            "Azure background work restarted between playback batches.");
        Assert(await service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest([cachedTitle], 3), default), "Azure background work did not reuse a ready clip.");
        service = new HeadlineAudioService(renderer);
        synth.Hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var stop = new CancellationTokenSource();
        background = service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Azure shutdown story"], 3), stop.Token);
        await synth.Hold.Task.WaitAsync(TimeSpan.FromSeconds(2));
        stop.Cancel();
        try { await background; throw new Exception("Azure background synthesis ignored shutdown."); } catch (OperationCanceledException) { }
        synth.Hold = null;
    }

    private static void CheckIncompleteAudio()
    {
        var pcm = Enumerable.Repeat((byte)1, 44_800).ToArray();
        var complete = AzureSpeechAudioRenderer.SplitClips(new AzureSpeechBatch(pcm,
            new Dictionary<string, ulong> { ["clip-0-start"] = 0, ["clip-1-start"] = 7_000_000 }), 2);
        Assert(complete.Length == 2 && complete.All(clip => clip.Length == 22_400)
            && complete.SelectMany(clip => clip).SequenceEqual(pcm), "Start-only bookmarks lost or truncated narration.");
        foreach (var marks in new[] {
            new Dictionary<string, ulong>(),
            new Dictionary<string, ulong> { ["clip-0-start"] = 0 },
            new Dictionary<string, ulong> { ["clip-0-start"] = 0, ["clip-1-start"] = 0 },
            new Dictionary<string, ulong> { ["clip-0-start"] = 5_000_000, ["clip-1-start"] = 1_000_000 },
            new Dictionary<string, ulong> { ["clip-0-start"] = 0, ["clip-1-start"] = 20_000_000 },
        })
        {
            try { AzureSpeechAudioRenderer.SplitClips(new AzureSpeechBatch(pcm, marks), 2); throw new Exception("Incomplete Azure audio was accepted."); }
            catch (InvalidOperationException) { }
        }
        try { AzureSpeechAudioRenderer.SplitClips(new AzureSpeechBatch(new byte[19_200], new Dictionary<string, ulong> { ["clip-0-start"] = 0, ["clip-0-end"] = 6_000_000 }), 1); throw new Exception("Silent Azure audio was accepted."); }
        catch (InvalidOperationException) { }
    }

    private sealed class VoiceHandler : HttpMessageHandler
    {
        public int Calls;
        public HttpStatusCode Status = HttpStatusCode.OK;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Calls++;
            Assert(request.RequestUri?.Host == "australiaeast.tts.speech.microsoft.com" && request.RequestUri.AbsolutePath == "/cognitiveservices/voices/list"
                && request.Headers.Contains("Ocp-Apim-Subscription-Key"), "The voice endpoint was not authenticated at the trusted host.");
            var data = new[] {
                new { ShortName = "en-NZ-MollyNeural", Locale = "en-NZ", DisplayName = "Molly", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "en-US-GuyNeural", Locale = "en-US", DisplayName = "Guy", Gender = "Male", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "zh-TW-HsiaoChenNeural", Locale = "zh-TW", DisplayName = "HsiaoChen", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "zh-CN-XiaoxiaoNeural", Locale = "zh-CN", DisplayName = "Xiaoxiao", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "en-US-Ava:DragonHDLatestNeural", Locale = "en-US", DisplayName = "Ava HD", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "en-US-PreviewNeural", Locale = "en-US", DisplayName = "Preview", Gender = "Female", VoiceType = "Neural", Status = "Preview" },
                new { ShortName = "fr-FR-DeniseNeural", Locale = "fr-FR", DisplayName = "Denise", Gender = "Female", VoiceType = "Neural", Status = "GA" },
            };
            return Task.FromResult(new HttpResponseMessage(Status) { Content = new StringContent(JsonSerializer.Serialize(data)) });
        }
    }

    private sealed class FakeSynthesizer : IAzureSpeechSynthesizer
    {
        public int Calls, Clips, LargestBatchCharacters, LargestBatchClips;
        public readonly List<string> Texts = [], Voices = [];
        public TaskCompletionSource? Hold;
        public Exception? Failure;
        public async Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken token)
        {
            Calls++;
            if (Hold is { } entered) { entered.SetResult(); await Task.Delay(Timeout.Infinite, token); }
            if (Failure is not null) throw Failure;
            XNamespace ns = "http://www.w3.org/2001/10/synthesis";
            var voices = XDocument.Parse(ssml).Root!.Elements(ns + "voice").ToArray();
            LargestBatchClips = Math.Max(LargestBatchClips, voices.Length);
            var characters = 0;
            var marks = new Dictionary<string, ulong>();
            using var pcm = new MemoryStream();
            foreach (var voice in voices)
            {
                var text = string.Concat(voice.Nodes().OfType<XText>().Select(node => node.Value));
                characters += text.Length; Clips++; Texts.Add(text); Voices.Add(voice.Attribute("name")!.Value);
                marks[voice.Elements(ns + "bookmark").First().Attribute("mark")!.Value] = (ulong)(pcm.Length / 32_000d * TimeSpan.TicksPerSecond);
                var value = (byte)(SHA256.HashData(Encoding.UTF8.GetBytes(text + Voices.Last()))[0] % 254 + 1);
                pcm.Write(Enumerable.Repeat(value, 19_200).ToArray());
                pcm.Write(new byte[3_200]);
            }
            LargestBatchCharacters = Math.Max(LargestBatchCharacters, characters);
            return new AzureSpeechBatch(pcm.ToArray(), marks);
        }
    }

    private sealed class LiveSynthesizer(IAzureSpeechSynthesizer inner) : IAzureSpeechSynthesizer
    {
        public int Calls;
        public Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken token) { Calls++; return inner.SynthesizeAsync(ssml, token); }
    }

    private sealed class UnusedKokoroWorker : IKokoroSpeechWorker
    {
        public Task<byte[][]> GenerateAsync(IReadOnlyList<KokoroClip> clips, CancellationToken token, bool background = false)
            => throw new Exception("Azure narration invoked Kokoro.");
    }
}
