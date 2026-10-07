using System.Text.Json;

namespace Signal.Server.Services;

public sealed class HeadlineAudioHealthCheck(HeadlineAudioService audio, IWebHostEnvironment environment, ILogger<HeadlineAudioHealthCheck> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var succeeded = false;
        string? error = null;
        try
        {
            var titles = Enumerable.Range(0, 50).Select(index => index % 2 == 0 ? "Signal audio is ready." : "語音已準備好。").ToArray();
            var recording = await audio.GenerateAsync(new HeadlineAudioRequest(titles, 3), stoppingToken);
            var duration = (recording.Wave.Length - 44) / 32_000d;
            succeeded = recording.Starts.Length == titles.Length && recording.Starts[0] == 0 && duration >= recording.Starts[^1] + 3
                && recording.Starts.Zip(recording.Starts.Skip(1)).All(pair => pair.Second - pair.First >= 3)
                && Enumerable.Range(0, titles.Length).All(index =>
                {
                    var start = 44 + (int)(recording.Starts[index] * 32_000);
                    var end = index + 1 < titles.Length ? 44 + (int)(recording.Starts[index + 1] * 32_000) : recording.Wave.Length;
                    return recording.Wave.AsSpan(start, end - start).IndexOfAnyExcept((byte)0) >= 0;
                });
            if (!succeeded) throw new InvalidOperationException("The startup speech check returned an empty recording.");
            logger.LogInformation("Headline audio startup check passed using the isolated speech worker.");
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        catch (Exception exception)
        {
            error = exception.ToString();
            logger.LogWarning(exception, "Headline audio startup check failed.");
        }
        try
        {
            // Private production evidence: run with the actual IIS identity,
            // without exposing diagnostics or requiring a user's login cookie.
            var path = Path.Combine(environment.ContentRootPath, "App_Data", "headline-audio-health.json");
            await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new { Succeeded = succeeded, Engine = "isolated-process", Headlines = 50, CompletedAt = DateTimeOffset.UtcNow, Error = error }), stoppingToken);
        }
        catch (Exception exception) { logger.LogWarning(exception, "Could not save the private audio health check."); }
    }
}
