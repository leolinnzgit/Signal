using System.Net;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class SharedArticleAudioChecks
{
    private static readonly string[] Locales = ["en-NZ", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "fr-FR", "de-DE", "es-ES", "it-IT", "pt-BR", "ar-SA", "hi-IN"];
    private static readonly string[] Languages = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "fr", "de", "es", "it", "pt", "ar", "hi"];
    internal static async Task RunLiveAsync()
    {
        using var config = JsonDocument.Parse(await File.ReadAllTextAsync(Environment.GetEnvironmentVariable("SIGNAL_AZURE_TEST_CONFIG")
            ?? @"C:\sites\SignalHost\appsettings.Production.json"));
        var options = Options.Create(config.RootElement.GetProperty("Speech").Deserialize<AzureSpeechOptions>()!);
        var synth = new LiveStream(new AzureSpeechSynthesizer(options));
        using var client = new HttpClient();
        var directory = Path.GetFullPath("work/shared-azure-live");
        var renderer = new AzureSpeechAudioRenderer(options, client, new AzureSpeechSynthesizer(options), directory);
        var service = new SharedArticleAudioService(renderer, synth, directory);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        foreach (var (language, title, paragraph) in new[] {
            ("en", "Signal shared story audio.", "This saved story can be heard without signing in."),
            ("zh-Hans", "Signal 分享新闻语音。", "收件人可以聆听保存的中文新闻，无需登录。"),
            ("fr", "Audio des articles partagés.", "Cet article conserve sa traduction française.")
        })
        {
            var article = new SharedNewsArticle { Title = title, Language = language, ParagraphsJson = JsonSerializer.Serialize(new[] { paragraph }) };
            var recording = await service.PrepareAsync(article, timeout.Token);
            using var output = new MemoryStream();
            await service.WriteAsync(recording, output, timeout.Token);
            Require(output.Length > 1000 && SharedArticleAudioService.IsCached(recording), "Live Azure did not produce a complete cached MP3.");
            var calls = synth.Calls;
            using var replay = new MemoryStream();
            await service.WriteAsync(recording, replay, timeout.Token);
            Require(synth.Calls == calls && output.ToArray().SequenceEqual(replay.ToArray()), "Live replay generated another cloud recording.");
        }
        Console.WriteLine("Live Azure shared narration passed English, Simplified Chinese, French, complete MP3 generation and cached replay.");
    }

    private sealed class LiveStream(IAzureSpeechStreamer inner) : IAzureSpeechStreamer
    {
        internal int Calls;
        public Task<TimeSpan> StreamAsync(string ssml, Func<byte[], CancellationToken, Task> write, Action<string, ulong> bookmark, CancellationToken token)
        { Calls++; return inner.StreamAsync(ssml, write, bookmark, token); }
    }
    internal static async Task RunAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SignalSharedAudio-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var options = Options.Create(new AzureSpeechOptions { Provider = "Azure", Key = "fake-key-for-shared-audio-tests", Region = "eastus" });
            using var client = new HttpClient(new Voices());
            var renderer = new AzureSpeechAudioRenderer(options, client, new AzureSpeechSynthesizer(options), directory);
            var synth = new FakeStream();
            var service = new SharedArticleAudioService(renderer, synth, directory);
            var article = new SharedNewsArticle { Id = new string('a', 48), UserId = "owner", Title = "中文 <标题> & 引号。", Language = "zh-Hans", ParagraphsJson = JsonSerializer.Serialize(new[] { "第一段。", "第二段。" }) };
            foreach (var (language, locale) in Languages.Zip(Locales))
            {
                var prepared = await service.PrepareAsync(withLanguage(language), CancellationToken.None);
                Require(prepared.Clips.All(clip => clip.Voice == locale + "-TestNeural"), "A translation was read with a voice from another language or Chinese script.");
            }
            Require((await renderer.GetVoicesAsync(CancellationToken.None)).Count == 3, "Expanded Azure catalog changed the English/Chinese account voice picker.");
            var recording = await service.PrepareAsync(article, CancellationToken.None);
            using var output = new MemoryStream();
            var writing = service.WriteAsync(recording, output, CancellationToken.None);
            await synth.FirstBytes.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Require(output.Length > 0 && !writing.IsCompleted && !SharedArticleAudioService.IsCached(recording), "Playback waited for the complete article or offered a partial cache.");
            using var duplicate = new MemoryStream();
            var duplicateWriting = service.WriteAsync(recording, duplicate, CancellationToken.None);
            synth.Release.TrySetResult();
            await Task.WhenAll(writing, duplicateWriting);
            Require(synth.Calls == 1 && output.ToArray().SequenceEqual(duplicate.ToArray()) && SharedArticleAudioService.IsCached(recording), "Concurrent visitors regenerated the same recording or lost bytes.");
            Require(synth.Texts.SequenceEqual(new[] { article.Title, "第一段。", "第二段。" }), "Azure narration did not preserve the saved title and paragraph order.");
            var reopened = new SharedArticleAudioService(renderer, synth, directory);
            using var replay = new MemoryStream();
            await reopened.WriteAsync(recording, replay, CancellationToken.None);
            Require(synth.Calls == 1 && output.ToArray().SequenceEqual(replay.ToArray()), "Reopening the service lost the persisted MP3 cache.");
            var otherLanguage = await service.PrepareAsync(withLanguage("zh-Hant"), CancellationToken.None);
            Require(recording.Path != otherLanguage.Path, "Different languages or voices reused the wrong MP3.");
            var longArticle = new SharedNewsArticle { Title = "Long story", Language = "fr", ParagraphsJson = JsonSerializer.Serialize(new[] { string.Concat(Enumerable.Repeat("文🙂", 20_000)) }) };
            var longRecording = await service.PrepareAsync(longArticle, CancellationToken.None);
            using var longOutput = new MemoryStream();
            await service.WriteAsync(longRecording, longOutput, CancellationToken.None);
            Require(synth.LargestCharacters <= 1500 && longRecording.Clips.All(clip => !char.IsHighSurrogate(clip.Text[^1]))
                && string.Concat(longRecording.Clips.Skip(1).Select(clip => clip.Text)) == string.Concat(Enumerable.Repeat("文🙂", 20_000)), "Long saved translations exceeded a batch or lost Unicode text.");
            var failure = await service.PrepareAsync(new SharedNewsArticle { Title = "Fail", Language = "en", ParagraphsJson = "[]" }, CancellationToken.None);
            synth.Fail = true;
            try { await service.WriteAsync(failure, Stream.Null, CancellationToken.None); throw new Exception("Failed Azure synthesis was accepted."); }
            catch (HeadlineAudioUnavailableException) { }
            Require(!SharedArticleAudioService.IsCached(failure) && Directory.GetFiles(directory, "*.tmp").Length == 0, "A failed stream left a partial recording.");
            synth.Fail = false;
            synth.Reset();
            using var abort = new CancellationTokenSource();
            var cancelling = service.WriteAsync(failure, Stream.Null, abort.Token);
            await synth.FirstBytes.Task.WaitAsync(TimeSpan.FromSeconds(3));
            abort.Cancel();
            try { await cancelling; throw new Exception("Closing playback did not cancel Azure."); } catch (OperationCanceledException) { }
            Require(!SharedArticleAudioService.IsCached(failure) && Directory.GetFiles(directory, "*.tmp").Length == 0, "Cancelled audio became a cached recording.");
            synth.Release.TrySetResult();

            using var connection = new SqliteConnection("Data Source=:memory:");
            await connection.OpenAsync();
            await using var database = new SignalDbContext(new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options);
            await database.Database.EnsureCreatedAsync();
            database.Users.Add(new ApplicationUser { Id = "owner", UserName = "owner" });
            database.SharedNewsArticles.Add(article);
            await database.SaveChangesAsync();
            var controller = new SharedArticleAudioController(database, service, NullLogger<SharedArticleAudioController>.Instance)
            { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            var calls = synth.Calls;
            Require(await controller.Read("unknown", CancellationToken.None) is NotFoundResult && synth.Calls == calls, "Unknown links triggered Azure generation.");
            var result = await controller.Read(article.Id, CancellationToken.None);
            Require(result is PhysicalFileResult { EnableRangeProcessing: true, ContentType: "audio/mpeg" }
                && synth.Calls == calls, "Anonymous replay did not serve cached, seekable MP3.");
            controller.Request.Method = "HEAD";
            Require(await controller.Read(article.Id, CancellationToken.None) is OkResult && synth.Calls == calls, "A HEAD probe triggered synthesis.");
            File.SetLastWriteTimeUtc(recording.Path, DateTime.UtcNow.AddDays(-31));
            Require(!SharedArticleAudioService.IsCached(recording), "An expired shared recording remained available indefinitely.");
            service.Prune();
            Require(!File.Exists(recording.Path) && await database.SharedNewsArticles.AnyAsync(item => item.Id == article.Id),
                "Cache eviction deleted the saved story or retained its expired MP3.");
            using var regenerated = new MemoryStream();
            await service.WriteAsync(recording, regenerated, CancellationToken.None);
            Require(SharedArticleAudioService.IsCached(recording) && regenerated.Length > 0 && synth.Calls == calls + 1,
                "An evicted shared recording could not be regenerated from its saved story.");
            Console.WriteLine("Shared Azure audio passed all translation languages, native streaming, exact saved text, concurrent reuse, persisted replay, long Unicode batches, failures, cancellation, anonymous seekable playback and unknown-link protection.");

            SharedNewsArticle withLanguage(string language) => new() { Title = article.Title, Language = language, ParagraphsJson = article.ParagraphsJson };
        }
        finally
        {
            foreach (var file in Directory.GetFiles(directory)) File.Delete(file);
            Directory.Delete(directory);
        }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class Voices : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(Locales.Select(locale => new {
                ShortName = locale + "-TestNeural", Locale = locale, DisplayName = "Test", Gender = "Female", VoiceType = "Neural", Status = "GA" }))) });
    }
    private sealed class FakeStream : IAzureSpeechStreamer
    {
        internal TaskCompletionSource FirstBytes = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly List<string> Texts = [];
        internal int Calls, LargestCharacters;
        internal bool Fail;
        internal void Reset() { FirstBytes = new(TaskCreationOptions.RunContinuationsAsynchronously); Release = new(TaskCreationOptions.RunContinuationsAsynchronously); }
        public async Task<TimeSpan> StreamAsync(string ssml, Func<byte[], CancellationToken, Task> write, Action<string, ulong> bookmark, CancellationToken token)
        {
            Calls++;
            if (Fail) throw new HeadlineAudioUnavailableException("quota", "Fake Azure quota failure.");
            XNamespace ns = "http://www.w3.org/2001/10/synthesis";
            var texts = XDocument.Parse(ssml).Root!.Elements(ns + "voice").Select(voice => string.Concat(voice.Nodes().OfType<XText>().Select(node => node.Value))).ToArray();
            Texts.AddRange(texts);
            LargestCharacters = Math.Max(LargestCharacters, texts.Sum(text => text.Length));
            await write([0xff, 0xf3, 0x48, 0xc4], token);
            FirstBytes.TrySetResult();
            await Release.Task.WaitAsync(token);
            return TimeSpan.FromSeconds(texts.Length);
        }
    }
}
