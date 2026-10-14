using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Data;
using Signal.Server.Controllers;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class ArticleAudioPreparationChecks
{
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    internal static void Run()
    {
        var queue = new ArticleAudioPreparationQueue(2);
        var a = new ArticleAudioPreparationJob("https://example.com/a", "A", "");
        var b = new ArticleAudioPreparationJob("https://example.com/b", "B", "");
        var c = new ArticleAudioPreparationJob("https://example.com/c", "C", "");
        Assert(queue.Enqueue(a) && queue.Enqueue(b) && !queue.Enqueue(new(b.Url, b.Title, b.Summary)), "A duplicate article occupied the queue.");
        queue.Enqueue(c);
        Assert(queue.Count == 2 && queue.Take() == b, "Queue overflow did not stay bounded or discard older work.");
        b.Article = true;
        queue.Resume(b);
        Assert(queue.Take() == c && queue.Take() == b, "Headline preparation did not go ahead of article paragraphs.");
        queue.Complete(b);
        Assert(!queue.Enqueue(new(b.Url, b.Title, b.Summary)), "Completed articles were repeatedly scheduled.");
        Assert(queue.Enqueue(new(b.Url, b.Title, "Changed summary")), "New article text was incorrectly deduplicated.");
        var active = queue.Take()!;
        for (var index = 0; index < 100; index++) queue.Enqueue(new("https://example.com/" + index, "News " + index, ""));
        queue.Resume(active);
        Assert(queue.Count == 2, "Resuming interrupted work exceeded the queue bound.");

        queue = new ArticleAudioPreparationQueue();
        a.Article = a.Extracted = true;
        b.Article = b.Extracted = true;
        queue.Enqueue(a); queue.Enqueue(b);
        Assert(queue.Take() == a, "New jobs did not start in arrival order.");
        queue.Resume(a);
        Assert(queue.Take() == b && queue.Take() == a, "New headlines did not precede an active article.");
        queue.Resume(b); queue.Resume(a);
        Assert(queue.Take() == a, "Article parts were interleaved before the current story could finish.");

        var fixture = JsonSerializer.Deserialize<BoundaryFixture>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "article-narration.json")),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        var parts = ArticleNarrationParts.Split(fixture.Title, fixture.Paragraphs);
        Assert(parts.SequenceEqual(fixture.Parts) && parts.All(part => part.Length <= 300), "Background chunks differed from the JavaScript reader cache boundaries.");
        Assert(parts.All(part => !char.IsLowSurrogate(part[0]) && !char.IsHighSurrogate(part[^1])), "A background chunk broke a Unicode character.");
        Assert(ArticleNarrationParts.Split("", ["Headline only"]).SequenceEqual(["Headline only"]), "Headline-only fallback repeated its title.");
        Console.WriteLine("Background article preparation passed bounded queue, duplicate reuse, headline priority, article completion order and shared English/Chinese/Unicode chunk boundaries.");
    }
    internal static async Task RunHostedAsync(bool useAzure = false)
    {
        var root = Path.Combine(Path.GetTempPath(), "SignalPrewarmTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllBytes(Path.Combine(root, "kokoro-v1.0.onnx"), [1]);
            File.WriteAllBytes(Path.Combine(root, "voices-v1.0.bin"), [1]);
            File.WriteAllText(Path.Combine(root, "voices.json"), JsonSerializer.Serialize(new[] {
                new NarrationVoice("kokoro/bf_emma", "Emma", "en-GB", "Female"),
                new NarrationVoice("kokoro/zf_xiaobei", "Xiaobei", "zh-CN", "Female") }));
            var settings = Options.Create(new KokoroSpeechOptions { Provider = useAzure ? "Azure" : "Kokoro", KokoroDirectory = root });
            var worker = new RecordingWorker();
            var renderer = new KokoroAudioRenderer(settings, worker, root);
            using var client = new HttpClient(new ReaderHandler());
            using var memory = new MemoryCache(new MemoryCacheOptions());
            var reader = new ArticleReaderService(client, memory, NullLogger<ArticleReaderService>.Instance);
            var azureSettings = Options.Create(new AzureSpeechOptions { Provider = useAzure ? "Azure" : "Windows", Key = "test-key-for-background-preparation", Region = "eastus" });
            var cloud = new RecordingAzureSynth();
            var azure = new AzureSpeechAudioRenderer(azureSettings, client, cloud, Path.Combine(root, "Azure"));
            var audio = new HeadlineAudioService(azure, renderer);
            using var connection = new SqliteConnection("Data Source=:memory:");
            await connection.OpenAsync();
            var services = new ServiceCollection();
            services.AddDbContext<SignalDbContext>(configuration => configuration.UseSqlite(connection));
            services.AddScoped(_ => reader);
            await using var provider = services.BuildServiceProvider();
            await using (var scope = provider.CreateAsyncScope())
            {
                var database = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
                await database.Database.EnsureCreatedAsync();
                database.Users.Add(new ApplicationUser { Id = "prewarm-user", UserName = "prewarm-test" });
                database.StoredNewsArticles.AddRange(
                    new StoredNewsArticle { UserId = "prewarm-user", Url = "https://93.184.216.34/story", Title = "Automatically prepared news", Summary = "Feed excerpt" },
                    new StoredNewsArticle { UserId = "prewarm-user", Url = "https://93.184.216.34/blocked", Title = "無法擷取的新聞", Summary = "Feed summary remains readable." });
                await database.SaveChangesAsync();
            }
            using var preparation = new ArticleAudioPreparationService(provider.GetRequiredService<IServiceScopeFactory>(), audio, settings,
                new HostEnvironment { ContentRootPath = root }, NullLogger<ArticleAudioPreparationService>.Instance);
            preparation.Enqueue("https://93.184.216.34/story", "Automatically prepared news", "Feed excerpt");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            await preparation.StartAsync(deadline.Token);
            var statusPath = Path.Combine(root, "App_Data", "article-audio-preparation.json");
            while (true)
            {
                await Task.Delay(100, deadline.Token);
                if (!File.Exists(statusPath)) continue;
                try
                {
                    await using var stream = new FileStream(statusPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    using var status = await JsonDocument.ParseAsync(stream, cancellationToken: deadline.Token);
                    if (status.RootElement.GetProperty("PreparedArticles").GetInt32() != 2) continue;
                    Assert(status.RootElement.GetProperty("FailedArticles").GetInt32() == 0, "The automatic preparation service failed a job.");
                    break;
                }
                catch (IOException) { /* The status file is replaced atomically on Windows. */ }
            }
            await preparation.StopAsync(deadline.Token);
            var extracted = await reader.ReadAsync("https://93.184.216.34/story", deadline.Token);
            Assert(extracted.Available, "The hosted fixture did not expose a full article.");
            var parts = ArticleNarrationParts.Split("Automatically prepared news", extracted.Article!.Paragraphs, audio.ArticlePartLength);
            var clips = useAzure ? cloud.Texts : worker.Clips.Select(clip => clip.Text).ToList();
            var before = clips.Count;
            var ready = await audio.GenerateAsync(new HeadlineAudioRequest(parts, 3), deadline.Token);
            var fallback = await audio.GenerateAsync(new HeadlineAudioRequest(ArticleNarrationParts.Split("無法擷取的新聞", ["Feed summary remains readable."], audio.ArticlePartLength), 3), deadline.Token);
            await audio.GenerateAsync(new HeadlineAudioRequest(["Automatically prepared news", "無法擷取的新聞", HeadlineAudioService.BriefingCompleteMessage], 6), deadline.Token);
            Assert((useAzure ? cloud.Texts.Count : worker.Clips.Count) == before && HeadlineAudioHealthCheck.IsCompleteRecording(ready, parts.Length, 3)
                && HeadlineAudioHealthCheck.IsCompleteRecording(fallback, 2, 3), "Listen regenerated automatically prepared full article or summary clips.");
            Assert(clips.TakeWhile(text => text != "無法擷取的新聞。").All(text => text is "Automatically prepared news." or HeadlineAudioService.BriefingCompleteMessage), "Article text was rendered before new headlines.");
            Assert(clips.Count(text => text == "Automatically prepared news.") == 1, "Startup restoration duplicated an already queued story.");
            if (useAzure)
            {
                var streams = new ArticleAudioStreamService(azure, new AzureSpeechSynthesizer(azureSettings));
                var session = await streams.CreateAsync("owner", new HeadlineAudioRequest(parts, 3), deadline.Token);
                Assert(session.Status.Complete && session.ContentType == "audio/wav" && session.Recording!.SequenceEqual(ready.Wave)
                    && !session.TryStart() && streams.Find("other", session.Id) is null, "The article player regenerated prewarmed audio or lost owner isolation.");
                var controller = new ArticleAudioStreamController(streams, NullLogger<ArticleAudioStreamController>.Instance) {
                    ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                        User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "owner")], "test")) } }
                };
                var playback = await controller.Audio(session.Id, deadline.Token) as FileContentResult;
                Assert(playback is { ContentType: "audio/wav", EnableRangeProcessing: true } && playback.FileContents.SequenceEqual(ready.Wave),
                    "Cached article playback lost WAV content type or seekable media support.");
                var alternate = await streams.CreateAsync("owner", new HeadlineAudioRequest(parts, 3,
                    Voices: new Dictionary<string, string> { ["en"] = "en-US-GuyNeural" }), deadline.Token);
                Assert(!alternate.Status.Complete && alternate.Recording is null && alternate.ContentType == "audio/mpeg",
                    "A changed voice reused another voice's prewarmed article.");
                Assert(worker.Clips.Count == 0, "Azure preparation invoked the local speech engine.");
            }
            Console.WriteLine($"Hosted {audio.EngineName} prewarming restored saved news, prepared full text, summaries and briefing completion, and served playback entirely from cache.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class RecordingAzureSynth : IAzureSpeechSynthesizer
    {
        internal readonly List<string> Texts = [];
        public Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken token)
        {
            XNamespace ns = "http://www.w3.org/2001/10/synthesis";
            var clips = XDocument.Parse(ssml).Root!.Elements(ns + "voice").ToArray();
            var marks = new Dictionary<string, ulong>();
            foreach (var (clip, index) in clips.Select((clip, index) => (clip, index)))
            {
                Texts.Add(string.Concat(clip.Nodes().OfType<XText>().Select(text => text.Value)));
                marks[$"clip-{index}-start"] = (ulong)index * 6_000_000;
            }
            return Task.FromResult(new AzureSpeechBatch(Enumerable.Repeat((byte)1, clips.Length * 19200).ToArray(), marks));
        }
    }

    private sealed class RecordingWorker : IKokoroSpeechWorker
    {
        internal readonly List<KokoroClip> Clips = [];
        public Task<byte[][]> GenerateAsync(IReadOnlyList<KokoroClip> clips, CancellationToken token, bool background = false)
        {
            Assert(background, "Automatic preparation used foreground CPU priority.");
            Clips.AddRange(clips);
            return Task.FromResult(clips.Select(_ => Enumerable.Repeat((byte)1, 19200).ToArray()).ToArray());
        }
    }
    private sealed class ReaderHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.RequestUri!.AbsolutePath == "/cognitiveservices/voices/list")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new[] {
                    new { ShortName = "en-NZ-MollyNeural", Locale = "en-NZ", DisplayName = "Molly", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                    new { ShortName = "en-US-GuyNeural", Locale = "en-US", DisplayName = "Guy", Gender = "Male", VoiceType = "Neural", Status = "GA" },
                    new { ShortName = "zh-TW-HsiaoChenNeural", Locale = "zh-TW", DisplayName = "HsiaoChen", Gender = "Female", VoiceType = "Neural", Status = "GA" }
                })) });
            var blocked = request.RequestUri!.AbsolutePath == "/blocked";
            var paragraph = "Researchers published a detailed report about changes in their community. The report explains the evidence and discusses what the findings mean, including the next steps for people in the region.";
            var html = "<html><body><article>" + string.Concat(Enumerable.Range(1, 5).Select(index => $"<p>Section {index}. {string.Join(' ', Enumerable.Repeat(paragraph, 4))}</p>")) + "</article></body></html>";
            return Task.FromResult(new HttpResponseMessage(blocked ? HttpStatusCode.Forbidden : HttpStatusCode.OK) { Content = new StringContent(html, Encoding.UTF8, "text/html") });
        }
    }
    private sealed class HostEnvironment : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "Signal";
        public string EnvironmentName { get; set; } = "Testing";
        public string ContentRootPath { get; set; } = "";
        public string WebRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    }
    private sealed record BoundaryFixture(string Title, string[] Paragraphs, string[] Parts);
}
