using System.Text.Json;

namespace Signal.Server.Services;

public sealed class HeadlineAudioHealthCheck(HeadlineAudioService audio, IWebHostEnvironment environment, ILogger<HeadlineAudioHealthCheck> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var succeeded = false;
        string? error = null;
        IReadOnlyList<NarrationVoice> voiceChoices = [];
        try
        {
            var titles = Enumerable.Range(0, 50).Select(index => index % 2 == 0 ? "Signal audio is ready." : "語音已準備好。").ToArray();
            voiceChoices = await audio.GetVoicesAsync(stoppingToken);
            // Exercise explicit selections with the IIS identity as well as
            // discovering the same choices offered by the authenticated API.
            var preferences = new Dictionary<string, string>();
            foreach (var language in new[] { "en", "zh" })
            {
                var selected = voiceChoices.LastOrDefault(voice => voice.Language.StartsWith(language, StringComparison.OrdinalIgnoreCase) && voice.Gender.Equals("Female", StringComparison.OrdinalIgnoreCase));
                if (selected is not null) preferences[language] = selected.Id;
            }
            var recording = await audio.GenerateAsync(new HeadlineAudioRequest(titles, 3, Voices: preferences), stoppingToken);
            succeeded = IsCompleteRecording(recording, titles.Length, 3);
            if (!succeeded) throw new InvalidOperationException("The startup speech check returned an empty recording.");
            logger.LogInformation("Headline audio startup check passed using {Engine}.", audio.EngineName);
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
            await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new { Succeeded = succeeded, Engine = audio.EngineName, Headlines = 50, VoiceChoices = voiceChoices, CompletedAt = DateTimeOffset.UtcNow, Error = error }), stoppingToken);
        }
        catch (Exception exception) { logger.LogWarning(exception, "Could not save the private audio health check."); }
    }

    internal static bool IsCompleteRecording(HeadlineAudio recording, int headlines, int seconds)
    {
        var pcmBytes = recording.Wave.Length - 44;
        if (headlines <= 0 || seconds <= 0 || pcmBytes <= 0 || recording.Starts.Length != headlines
            || recording.Starts[0] != 0 || recording.Starts.Any(start => !double.IsFinite(start) || start < 0 || start > pcmBytes / 32_000d))
            return false;
        // Compare sample positions: subtracting floating timestamps can turn an
        // exact three-second gap into 2.999999999999986 and falsely fail health.
        var starts = recording.Starts.Select(start => (int)Math.Round(start * 32_000)).ToArray();
        return pcmBytes - starts[^1] >= seconds * 32_000L
            && starts.Zip(starts.Skip(1)).All(pair => pair.Second - pair.First >= seconds * 32_000L)
            && Enumerable.Range(0, headlines).All(index =>
            {
                var start = 44 + starts[index];
                var end = index + 1 < headlines ? 44 + starts[index + 1] : recording.Wave.Length;
                return recording.Wave.AsSpan(start, end - start).IndexOfAnyExcept((byte)0) >= 0;
            });
    }
}
