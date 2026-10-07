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
            var recording = await audio.GenerateAsync(new HeadlineAudioRequest(["Signal audio is ready.", "語音已準備好。"], 3), stoppingToken);
            succeeded = recording.Starts.Length == 2 && recording.Wave.Length > 44 && recording.Wave.Skip(44).Any(sample => sample != 0);
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
            await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new { Succeeded = succeeded, Engine = "isolated-process", CompletedAt = DateTimeOffset.UtcNow, Error = error }), stoppingToken);
        }
        catch (Exception exception) { logger.LogWarning(exception, "Could not save the private audio health check."); }
    }
}
