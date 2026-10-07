using System.Text;
using Signal.Server.Services;

internal static class HeadlineAudioChecks
{
    public static async Task RunAsync()
    {
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
            if (Environment.GetEnvironmentVariable("SIGNAL_AUDIO_TEST_OUTPUT") is { Length: > 0 } output)
            {
                await File.WriteAllBytesAsync(output, wave);
                await File.WriteAllTextAsync(output + ".json", System.Text.Json.JsonSerializer.Serialize(audio.Starts));
            }
        }
        Console.WriteLine("Screen-off audio passed validation, English/Chinese synthesis and continuous WAV timing checks.");
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
