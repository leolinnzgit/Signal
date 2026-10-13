using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Playwright;
using Signal.Server.Services;
using System.Text.Json;

internal static class ArticleAudioStreamLiveChecks
{
    internal static async Task RunAsync()
    {
        var path = Environment.GetEnvironmentVariable("SIGNAL_AZURE_TEST_CONFIG") ?? @"C:\sites\SignalHost\appsettings.Production.json";
        using var configuration = JsonDocument.Parse(await File.ReadAllTextAsync(path));
        var options = Options.Create(configuration.RootElement.GetProperty("Speech").Deserialize<AzureSpeechOptions>()!);
        options.Value.Validate();
        using var client = new HttpClient();
        var synth = new AzureSpeechSynthesizer(options);
        var held = new HeldStream(synth);
        var renderer = new AzureSpeechAudioRenderer(options, client, synth, Path.GetTempPath());
        var streams = new ArticleAudioStreamService(renderer, held);
        var session = await streams.CreateAsync("browser-check", new HeadlineAudioRequest([
            string.Concat(Enumerable.Repeat("Signal can start reading before the whole article is ready. Listen while the rest of the speech is generated. ", 8)),
            string.Concat(Enumerable.Repeat("語音串流測試。現在可以先聽新聞，不需要等待整篇文章完成。", 8)),
            string.Concat(Enumerable.Repeat("The next paragraph continues the streamed article without waiting for a complete file. ", 8))
        ], 3), CancellationToken.None);
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        await using var server = builder.Build();
        server.Urls.Add("http://127.0.0.1:0");
        server.MapGet("/", () => Results.Content($"<audio id='audio' controls preload='auto' src='/audio/{session.Id}'></audio>", "text/html"));
        server.MapGet("/replay", () => Results.File(session.Recording!, "audio/mpeg", enableRangeProcessing: true));
        server.MapGet($"/audio/{session.Id}", async (HttpContext context) =>
        {
            context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            context.Response.ContentType = "audio/mpeg";
            context.Response.Headers.AcceptRanges = "none";
            if (!session.TryStart()) return;
            await streams.WriteAsync(session, context.Response.Body, context.RequestAborted);
        });
        await server.StartAsync();
        try
        {
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new() { Channel = "msedge", Headless = true });
            var page = await browser.NewPageAsync();
            await page.GotoAsync(server.Urls.Single(), new() { WaitUntil = WaitUntilState.DOMContentLoaded });
            await page.ClickAsync("audio");
            await page.EvaluateAsync("document.querySelector('audio').play()");
            await page.WaitForFunctionAsync("document.querySelector('audio').currentTime > 0.3", null, new() { Timeout = 30_000 });
            if (session.Status.Complete || !held.FirstAudioBeforeCompletion) throw new Exception("The browser waited for the complete recording before playback.");
            var played = await page.EvaluateAsync<double>("document.querySelector('audio').currentTime");
            held.Release.TrySetResult();
            var deadline = DateTimeOffset.UtcNow.AddSeconds(90);
            while (!session.Status.Complete && session.Status.Error is null && DateTimeOffset.UtcNow < deadline) await Task.Delay(100);
            if (!session.Status.Complete || session.Recording is not { Length: > 1000 } || session.Status.Starts.Length != 3)
                throw new Exception("The live MP3 stream did not finish: " + JsonSerializer.Serialize(new { session.Status, Bytes = session.Recording?.Length ?? 0 }));
            var position = await page.EvaluateAsync<double>("document.querySelector('audio').currentTime");
            await page.EvaluateAsync("document.querySelector('audio').pause(); document.querySelector('audio').src = '/replay'");
            await page.WaitForFunctionAsync("document.querySelector('audio').readyState >= 1 && Number.isFinite(document.querySelector('audio').duration)", null, new() { Timeout = 10_000 });
            var nativeDuration = await page.EvaluateAsync<double>("document.querySelector('audio').duration");
            if (Math.Abs(nativeDuration - session.Status.Duration) > 0.5 || nativeDuration <= session.Status.Starts[^1])
                throw new Exception("The browser lost audio or timing between MP3 cloud batches.");
            await page.EvaluateAsync("position => { const audio = document.querySelector('audio'); audio.currentTime = position; return audio.play(); }", position);
            await page.WaitForFunctionAsync("position => document.querySelector('audio').currentTime > position + 0.2", position, new() { Timeout = 10_000 });
            Console.WriteLine($"Live native browser MP3 playback reached {played:F2}s before HTTP completion; English/Chinese streaming, multiple cloud batches, timestamps and complete replay passed ({nativeDuration:F2}s).");
        }
        finally { held.Release.TrySetResult(); await server.StopAsync(); }
    }

    private sealed class HeldStream(IAzureSpeechStreamer inner) : IAzureSpeechStreamer
    {
        internal readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal bool FirstAudioBeforeCompletion;
        public async Task<TimeSpan> StreamAsync(string ssml, Func<byte[], CancellationToken, Task> write, Action<string, ulong> bookmark, CancellationToken token)
        {
            var finished = false;
            var result = await inner.StreamAsync(ssml, async (bytes, cancellation) =>
            {
                if (!finished && bytes.Length > 0) FirstAudioBeforeCompletion = true;
                await write(bytes, cancellation);
            }, bookmark, token);
            finished = true;
            await Release.Task.WaitAsync(token);
            return result;
        }
    }
}
