namespace Signal.Server.Services;

public sealed class ExecutiveBriefingBackgroundService(
    IServiceScopeFactory scopeFactory,
    ILogger<ExecutiveBriefingBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(12), stoppingToken);
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(45));
            do
            {
                await CheckDueBriefingsAsync(stoppingToken);
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    private async Task CheckDueBriefingsAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var service = scope.ServiceProvider.GetRequiredService<ExecutiveBriefingDeliveryService>();
            await service.ProcessDueScheduledBriefingsAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Background executive briefing scheduler tick failed.");
        }
    }
}
