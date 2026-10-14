namespace Signal.Server.Services;

public sealed class AudioCacheMaintenanceService(IWebHostEnvironment environment, SharedArticleAudioService shared,
    ILogger<AudioCacheMaintenanceService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var clips = new HeadlineAudioClipCache(Path.Combine(environment.ContentRootPath, "App_Data", "HeadlineAudioClips"));
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
            await clips.CompactLegacyAsync(stoppingToken);
            using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
            do { clips.Prune(); shared.Prune(); }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception exception) { logger.LogWarning(exception, "Audio cache maintenance stopped."); }
    }
}
