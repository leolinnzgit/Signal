using System.Text;
using System.Globalization;
using System.IO.Compression;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Signal.Server.Services;

internal static class HeadlineAudioChecks
{
    public static async Task RunAsync()
    {
        CheckFemaleVoices();
        CheckClipCache();
        CheckHealthTiming();
        await CheckCompressionAsync();
        foreach (var request in new[]
        {
            new HeadlineAudioRequest([]), new HeadlineAudioRequest([""]),
            new HeadlineAudioRequest(["Headline"], 5),
            new HeadlineAudioRequest([new string('a', 1_001)]),
            new HeadlineAudioRequest(Enumerable.Repeat("Headline", 201).ToArray()),
            new HeadlineAudioRequest(Enumerable.Repeat(new string('a', 1_000), 21).ToArray()),
        })
        {
            try { HeadlineAudioService.Validate(request); throw new Exception("Invalid audio briefing was accepted."); }
            catch (ArgumentException) { }
        }
        if (HeadlineAudioService.Validate(new HeadlineAudioRequest(["  A   headline\n"])).Single() != "A headline")
            throw new Exception("Audio titles were not normalized.");
        if (OperatingSystem.IsWindows())
        {
            await CheckQueueRecoveryAsync();
            var service = new HeadlineAudioService();
            var audio = await service.GenerateAsync(new HeadlineAudioRequest(["Science news from New Zealand.", "今天的科學新聞。"], 3), CancellationToken.None);
            var wave = audio.Wave;
            if (Encoding.ASCII.GetString(wave, 0, 4) != "RIFF" || Encoding.ASCII.GetString(wave, 8, 8) != "WAVEfmt "
                || BitConverter.ToInt32(wave, 4) != wave.Length - 8 || BitConverter.ToInt32(wave, 40) != wave.Length - 44
                || BitConverter.ToInt32(wave, 24) != 16_000 || BitConverter.ToInt16(wave, 34) != 16)
                throw new Exception("The synthesized briefing is not a valid PCM WAV track.");
            if (audio.Starts.Length != 2 || audio.Starts[0] != 0 || audio.Starts[1] < 3
                || (wave.Length - 44) / 32_000d < audio.Starts[1] + 3)
                throw new Exception("Audio timing did not contain both headlines and their display gaps.");
            if (!wave.Skip(44).Any(value => value != 0)) throw new Exception("Narration was silent.");
            var batch = await service.GenerateAsync(new HeadlineAudioRequest(Enumerable.Range(0, 50).Select(index => index % 2 == 0 ? "A science headline from New Zealand." : "今天的科學新聞。").ToArray(), 3), CancellationToken.None);
            if (batch.Starts.Length != 50 || batch.Starts.Zip(batch.Starts.Skip(1)).Any(pair => pair.Second - pair.First < 3)
                || (batch.Wave.Length - 44) / 32_000d < batch.Starts[^1] + 3)
                throw new Exception("A complete English/Chinese audio batch lost headlines or timing.");
            var unique = new HeadlineAudioRequest(Enumerable.Range(0, 10).Select(index => $"Audio cache check {Guid.NewGuid():N}, headline {index}.").ToArray(), 3);
            var timer = System.Diagnostics.Stopwatch.StartNew();
            var cold = await service.GenerateAsync(unique, CancellationToken.None);
            var coldMilliseconds = timer.ElapsedMilliseconds;
            timer.Restart();
            var warm = await service.GenerateAsync(unique with { Seconds = 6 }, CancellationToken.None);
            if (warm.Starts.Length != 10 || warm.Starts.Zip(warm.Starts.Skip(1)).Any(pair => pair.Second - pair.First < 6)
                || !cold.Wave.AsSpan(44, 32_000).SequenceEqual(warm.Wave.AsSpan(44, 32_000)))
                throw new Exception("Cached speech did not preserve narration across display intervals.");
            Console.WriteLine($"10 new headlines prepared in {coldMilliseconds} ms; cached headlines in {timer.ElapsedMilliseconds} ms.");
            using var compressed = new MemoryStream();
            using (var gzip = new GZipStream(compressed, CompressionLevel.Fastest, leaveOpen: true)) gzip.Write(batch.Wave);
            Console.WriteLine($"Actual 50-headline WAV transfer: {batch.Wave.Length:N0} bytes to {compressed.Length:N0} bytes with gzip.");
            if (Environment.GetEnvironmentVariable("SIGNAL_AUDIO_TEST_OUTPUT") is { Length: > 0 } output)
            {
                await File.WriteAllBytesAsync(output, wave);
                await File.WriteAllTextAsync(output + ".json", System.Text.Json.JsonSerializer.Serialize(audio.Starts));
            }
        }
        Console.WriteLine("Screen-off audio passed validation, English/Chinese synthesis and continuous WAV timing checks.");
    }

    private static void CheckFemaleVoices()
    {
        var voices = new[]
        {
            new HeadlineAudioVoice("male-nz", CultureInfo.GetCultureInfo("en-NZ"), "Male"),
            new HeadlineAudioVoice("female-gb", CultureInfo.GetCultureInfo("en-GB"), "Female"),
            new HeadlineAudioVoice("male-cn", CultureInfo.GetCultureInfo("zh-CN"), "Male"),
            new HeadlineAudioVoice("female-tw", CultureInfo.GetCultureInfo("zh-TW"), "Female"),
        };
        if (HeadlineAudioService.ChooseVoice(voices, "en-NZ", false)?.Id != "female-gb"
            || HeadlineAudioService.ChooseVoice(voices, "zh-CN", true)?.Id != "female-tw"
            || HeadlineAudioService.ChooseVoice(voices.Take(1), "en-NZ", false)?.Id != "male-nz"
            || HeadlineAudioService.ChooseVoice(voices.Take(2), "zh-TW", true) is not null)
            throw new Exception("Female voice preference or language fallback failed.");
        Console.WriteLine("Female voices are preferred independently for English and Chinese.");
    }

    private static void CheckHealthTiming()
    {
        var positions = new int[50];
        var length = 0;
        for (var index = 0; index < positions.Length; index++)
        {
            positions[index] = length;
            length += index % 2 == 0 ? 96_000 : 98_880;
        }
        var wave = new byte[44 + length];
        foreach (var position in positions) wave[44 + position] = 1;
        var recording = new HeadlineAudio(wave, positions.Select(position => position / 32_000d).ToArray());
        if (!HeadlineAudioHealthCheck.IsCompleteRecording(recording, 50, 3))
            throw new Exception("Floating timestamp rounding rejected a complete recording.");
        wave[44 + positions[25]] = 0;
        if (HeadlineAudioHealthCheck.IsCompleteRecording(recording, 50, 3)
            || HeadlineAudioHealthCheck.IsCompleteRecording(recording with { Starts = recording.Starts[..49] }, 50, 3))
            throw new Exception("The audio health check accepted silent or missing headlines.");
        Console.WriteLine("Audio health timing accepts exact sample gaps and rejects silent or incomplete recordings.");
    }

    private static void CheckClipCache()
    {
        var directory = Path.Combine(Path.GetTempPath(), "SignalAudioCacheTest-" + Guid.NewGuid().ToString("N"));
        try
        {
            var cache = new HeadlineAudioClipCache(directory, maximumBytes: 4);
            var calls = 0;
            byte[] Render() { calls++; return [1, 2, 3, 4]; }
            cache.GetOrCreate("female", "Headline.", Render);
            var reopened = new HeadlineAudioClipCache(directory, maximumBytes: 4);
            if (!reopened.GetOrCreate("female", "Headline.", Render).SequenceEqual(new byte[] { 1, 2, 3, 4 }) || calls != 1)
                throw new Exception("Cached speech was not reused after reopening the cache.");
            var first = Directory.GetFiles(directory).Single();
            File.WriteAllBytes(first, new byte[4]);
            cache.GetOrCreate("female", "Headline.", Render);
            if (calls != 2) throw new Exception("Silent cached speech was not repaired.");
            File.SetLastWriteTimeUtc(first, DateTime.UtcNow.AddDays(-8));
            cache.GetOrCreate("female", "Headline.", Render);
            if (calls != 3) throw new Exception("Expired cached speech was reused.");
            cache.GetOrCreate("male", "Headline.", Render);
            cache.GetOrCreate("female", "Different headline.", Render);
            if (calls != 5) throw new Exception("Different voices or headlines shared a cache entry.");
            cache.Prune();
            if (Directory.GetFiles(directory, "*.pcm").Sum(path => new FileInfo(path).Length) > 4)
                throw new Exception("Audio cache size limit was not enforced.");
            foreach (var path in Directory.GetFiles(directory)) File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddDays(-8));
            cache.Prune();
            if (Directory.GetFiles(directory).Length != 0) throw new Exception("Expired audio cache entries were not pruned.");
            File.WriteAllText(Path.Combine(directory, "blocked"), "file");
            if (!new HeadlineAudioClipCache(Path.Combine(directory, "blocked")).GetOrCreate("female", "Headline.", Render).SequenceEqual(new byte[] { 1, 2, 3, 4 }))
                throw new Exception("Unavailable cache prevented speech playback.");
        }
        finally
        {
            if (Directory.Exists(directory))
            {
                foreach (var path in Directory.GetFiles(directory)) File.Delete(path);
                Directory.Delete(directory);
            }
        }
        Console.WriteLine("Audio clips survived cache reopening, isolated voices, repaired silence, expired, pruned and bypassed an unavailable cache.");
    }

    private static async Task CheckCompressionAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddHeadlineAudioCompression();
        await using var app = builder.Build();
        // Exercise the production HTTPS compression branch over a local test socket.
        app.Use((context, next) => { context.Request.Scheme = "https"; return next(context); });
        app.UseResponseCompression();
        var pcm = new byte[320_000];
        pcm[0] = 1;
        app.MapGet("/audio", () => Results.File(pcm, "audio/wav"));
        app.MapGet("/json", () => Results.Json(new { Value = new string('a', 1_000) }));
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
        foreach (var encoding in new[] { "gzip", "br" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/audio");
            request.Headers.AcceptEncoding.ParseAdd(encoding);
            using var response = await client.SendAsync(request);
            var compressed = await response.Content.ReadAsByteArrayAsync();
            if (!response.Content.Headers.ContentEncoding.Contains(encoding) || compressed.Length >= pcm.Length / 2)
                throw new Exception("Audio download was not compressed.");
            using var source = new MemoryStream(compressed);
            using Stream decoder = encoding == "br" ? new BrotliStream(source, CompressionMode.Decompress) : new GZipStream(source, CompressionMode.Decompress);
            using var decoded = new MemoryStream();
            await decoder.CopyToAsync(decoded);
            if (!decoded.ToArray().SequenceEqual(pcm)) throw new Exception("Compression changed the recording.");
            Console.WriteLine($"Audio {encoding} round-trip: {pcm.Length:N0} bytes to {compressed.Length:N0} bytes.");
        }
        client.DefaultRequestHeaders.AcceptEncoding.ParseAdd("gzip");
        using var json = await client.GetAsync("/json");
        if (json.Content.Headers.ContentEncoding.Count != 0) throw new Exception("Non-audio responses were compressed.");
        await app.StopAsync();
    }

    private static async Task CheckQueueRecoveryAsync()
    {
        var request = new HeadlineAudioRequest(["Test headline"], 3);
        var result = new HeadlineAudio(new byte[46], [0]);
        var pending = new TaskCompletionSource<HeadlineAudio>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var timed = new HeadlineAudioService((_, _) => ++calls == 1 ? pending.Task : Task.FromResult(result), TimeSpan.FromMilliseconds(40), TimeSpan.FromSeconds(1));
        try { await timed.GenerateAsync(request, CancellationToken.None); throw new Exception("A hung speech job did not time out."); }
        catch (HeadlineAudioUnavailableException exception) when (exception.Code == "timeout") { }
        if (await timed.GenerateAsync(request, CancellationToken.None) != result)
            throw new Exception("A timed-out speech job retained the audio queue.");

        calls = 0;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new HeadlineAudioService((_, _) => { if (++calls > 1) return Task.FromResult(result); entered.SetResult(); return pending.Task; }, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(1));
        using var abort = new CancellationTokenSource();
        var running = cancelled.GenerateAsync(request, abort.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        abort.Cancel();
        try { await running; throw new Exception("Closing a briefing did not cancel its audio job."); }
        catch (OperationCanceledException) { }
        if (await cancelled.GenerateAsync(request, CancellationToken.None) != result)
            throw new Exception("A cancelled speech job retained the audio queue.");

        calls = 0;
        entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var queued = new HeadlineAudioService((_, _) => { if (++calls > 1) return Task.FromResult(result); entered.SetResult(); return pending.Task; }, TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(40));
        running = queued.GenerateAsync(request, CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        try { await queued.GenerateAsync(request, CancellationToken.None); throw new Exception("A busy queue did not return a bounded response."); }
        catch (HeadlineAudioUnavailableException exception) when (exception.Code == "busy") { }
        pending.SetResult(result);
        await running;
        if (await queued.GenerateAsync(request, CancellationToken.None) != result)
            throw new Exception("The audio queue did not recover after a busy response.");
        Console.WriteLine("Audio queue recovered from stuck jobs, client cancellation and concurrent requests.");
    }
}
