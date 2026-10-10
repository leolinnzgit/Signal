using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class KokoroSpeechChecks
{
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    public static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "SignalKokoroTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var settings = Options.Create(new KokoroSpeechOptions { Provider = "Kokoro", KokoroDirectory = root });
            var worker = new FakeWorker();
            var renderer = new KokoroAudioRenderer(settings, worker, root);
            try { renderer.GetVoices(); throw new Exception("Missing Kokoro installation was accepted."); }
            catch (HeadlineAudioUnavailableException exception) when (exception.Code == "configuration") { }
            File.WriteAllBytes(Path.Combine(root, "kokoro-v1.0.onnx"), [1]);
            File.WriteAllBytes(Path.Combine(root, "voices-v1.0.bin"), [1]);
            File.WriteAllText(Path.Combine(root, "voices.json"), JsonSerializer.Serialize(new[] {
                new NarrationVoice("kokoro/bf_emma", "Emma (Kokoro)", "en-GB", "Female"),
                new NarrationVoice("kokoro/am_adam", "Adam (Kokoro)", "en-US", "Male"),
                new NarrationVoice("kokoro/zf_xiaobei", "Xiaobei (Kokoro)", "zh-CN", "Female"),
            }));
            using var client = new HttpClient();
            var disabled = Options.Create(new AzureSpeechOptions());
            var azure = new AzureSpeechAudioRenderer(disabled, client, new AzureSpeechSynthesizer(disabled), Path.Combine(root, "AzureCache"));
            var service = new HeadlineAudioService(azure, renderer);
            Assert(service.EngineName == "kokoro-local" && service.MaximumBatchCharacters == 300 && (await service.GetVoicesAsync(default)).Count == 3, "Local engine metadata or voice selection failed.");
            var titles = new[] { "A full news sentence", "今天的 Signal 新聞。", "A full news sentence" };
            var preferences = new Dictionary<string, string> { ["en"] = "Old Windows voice", ["zh"] = "kokoro/am_adam" };
            var audio = await service.GenerateAsync(new HeadlineAudioRequest(titles, 3, Voices: preferences), default);
            Assert(HeadlineAudioHealthCheck.IsCompleteRecording(audio, 3, 3) && worker.Calls == 1 && worker.Clips.Count == 2
                && worker.Clips[0] == new KokoroClip("bf_emma", titles[0] + ".") && worker.Clips[1] == new KokoroClip("zf_xiaobei", titles[1]), "Language selection, punctuation, text preservation, duplicates or WAV timing failed.");
            await service.GenerateAsync(new HeadlineAudioRequest(titles, 6), default);
            await new KokoroAudioRenderer(settings, worker, root).GenerateAsync(new HeadlineAudioRequest(titles, 3), default);
            Assert(worker.Calls == 1, "Cached local clips were not reused after changing gaps or reopening.");
            await service.GenerateAsync(new HeadlineAudioRequest([titles[0]], 3, Voices: new Dictionary<string, string> { ["en"] = "kokoro/am_adam" }), default);
            Assert(worker.Calls == 2 && worker.Clips.Last().Voice == "am_adam", "Changing voice reused the previous recording.");
            var before = worker.Calls;
            var longTitles = Enumerable.Range(0, 20).Select(index => $"News {index}: " + new string('a', 140)).ToArray();
            var longAudio = await service.GenerateAsync(new HeadlineAudioRequest(longTitles, 3), default);
            Assert(HeadlineAudioHealthCheck.IsCompleteRecording(longAudio, 20, 3) && worker.Calls - before > 1 && worker.LargestBatch <= 1000, "Local batching exceeded its limit or lost clips.");
            worker.Hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var cancel = new CancellationTokenSource();
            var cancelled = service.GenerateAsync(new HeadlineAudioRequest(["Cancel this recording"], 3), cancel.Token);
            await worker.Hold.Task.WaitAsync(TimeSpan.FromSeconds(2)); cancel.Cancel();
            try { await cancelled; throw new Exception("Local synthesis ignored cancellation."); } catch (OperationCanceledException) { }
            worker.Hold = null;
            worker.Failure = new InvalidOperationException("Local model failed");
            try { await service.GenerateAsync(new HeadlineAudioRequest(["Failed recording"], 3), default); throw new Exception("A local failure silently changed providers."); }
            catch (InvalidOperationException exception) when (exception.Message == "Local model failed") { }
            worker.Failure = null;
            await service.GenerateAsync(new HeadlineAudioRequest(["Failed recording"], 3), default);
            await CheckBackgroundPriorityAsync(azure, renderer, worker, titles[0]);
            var blockedCache = Path.Combine(root, "blocked-cache");
            File.WriteAllText(blockedCache, "A file cannot contain cache files.");
            var cannotSave = new HeadlineAudioService(azure, new KokoroAudioRenderer(settings, worker, root, blockedCache));
            try { await cannotSave.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Unsaved background recording"], 3), default); throw new Exception("An unsaved recording was reported as prepared."); }
            catch (HeadlineAudioUnavailableException exception) when (exception.Code == "cache") { }
        }
        finally { Directory.Delete(root, recursive: true); }
        Console.WriteLine("Kokoro passed voice selection, language fallback, complete text, PCM timing, batching, persistent cache, cancellation and error recovery checks.");
    }

    private static async Task CheckBackgroundPriorityAsync(AzureSpeechAudioRenderer azure, KokoroAudioRenderer renderer, FakeWorker worker, string cachedTitle)
    {
        var service = new HeadlineAudioService(azure, renderer);
        worker.Hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var background = service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Prefetch a new story"], 3), default);
        await worker.Hold.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(worker.BackgroundFlags.Last(), "Background synthesis did not request reduced CPU priority.");
        worker.Hold = null;
        var foreground = await service.GenerateAsync(new HeadlineAudioRequest(["A user requested this story"], 3), default);
        Assert(!await background && HeadlineAudioHealthCheck.IsCompleteRecording(foreground, 1, 3) && !worker.BackgroundFlags.Last(), "Playback did not preempt background synthesis and restore normal priority.");
        Assert(!await service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Between HTTP batches"], 3), default), "Background synthesis restarted between foreground HTTP batches.");

        service = new HeadlineAudioService(azure, renderer);
        worker.Hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var stop = new CancellationTokenSource();
        background = service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest(["Another background story"], 3), stop.Token);
        await worker.Hold.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var before = worker.Calls;
        var cached = await service.GenerateAsync(new HeadlineAudioRequest([cachedTitle], 6), default);
        Assert(!background.IsCompleted && worker.Calls == before && HeadlineAudioHealthCheck.IsCompleteRecording(cached, 1, 6), "Cached playback waited for or cancelled background work.");
        stop.Cancel();
        try { await background; throw new Exception("Background preparation ignored shutdown."); } catch (OperationCanceledException) { }
        worker.Hold = null;
        Assert(await service.TryPrepareInBackgroundAsync(new HeadlineAudioRequest([cachedTitle], 3), default), "A cached clip could not be reused by background preparation.");
        Console.WriteLine("Background speech passed foreground preemption, CPU priority, cached playback bypass, batch cooldown and shutdown checks.");
    }

    public static async Task RunLiveAsync()
    {
        var root = Environment.GetEnvironmentVariable("SIGNAL_KOKORO_TEST_DIRECTORY") ?? @"C:\sites\SignalHost\App_Data\Kokoro";
        var settings = Options.Create(new KokoroSpeechOptions { Provider = "Kokoro", KokoroDirectory = root });
        using var worker = new KokoroSpeechWorker(settings, new HostEnvironment());
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var clips = await worker.GenerateAsync([new("bf_emma", "Signal is ready."), new("zf_xiaobei", "Signal 新聞已準備好。")], deadline.Token, background: true);
        Assert(clips.Length == 2 && clips.All(clip => clip.Length > 3200 && clip.Length % 2 == 0 && clip.Any(value => value != 0)), "Real English/Mandarin PCM was empty.");
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(250));
        try { await worker.GenerateAsync([new("bf_emma", "Cancel a long recording. " + new string('a', 500))], cancel.Token); throw new Exception("The Python worker ignored cancellation."); }
        catch (OperationCanceledException) { }
        var restarted = await worker.GenerateAsync([new("bf_emma", "The voice is ready again.")], deadline.Token);
        Assert(restarted[0].Length > 3200 && restarted[0].Any(value => value != 0), "The Python worker did not recover after cancellation.");
        Console.WriteLine("Live Kokoro passed real English/Mandarin synthesis, binary framing, resampling, process cancellation and restart.");
    }

    private sealed class FakeWorker : IKokoroSpeechWorker
    {
        public int Calls, LargestBatch;
        public readonly List<KokoroClip> Clips = [];
        public readonly List<bool> BackgroundFlags = [];
        public TaskCompletionSource? Hold;
        public Exception? Failure;
        public async Task<byte[][]> GenerateAsync(IReadOnlyList<KokoroClip> clips, CancellationToken token, bool background = false)
        {
            BackgroundFlags.Add(background);
            Calls++; Clips.AddRange(clips); LargestBatch = Math.Max(LargestBatch, clips.Sum(clip => clip.Text.Length));
            if (Hold is { } entered) { entered.SetResult(); await Task.Delay(Timeout.Infinite, token); }
            if (Failure is not null) throw Failure;
            return clips.Select((_, index) => Enumerable.Repeat((byte)(index + 1), 19200).ToArray()).ToArray();
        }
    }
    private sealed class HostEnvironment : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "Signal";
        public string EnvironmentName { get; set; } = "Testing";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public string WebRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    }
}
