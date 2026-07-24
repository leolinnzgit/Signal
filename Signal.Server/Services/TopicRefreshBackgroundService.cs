using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;

namespace Signal.Server.Services;

public sealed class TopicRefreshBackgroundService(
    IServiceScopeFactory scopeFactory,
    ILogger<TopicRefreshBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
            do
            {
                await RefreshDueUsersAsync(stoppingToken);
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    private async Task RefreshDueUsersAsync(CancellationToken cancellationToken)
    {
        string[] userIds;
        await using (var discoveryScope = scopeFactory.CreateAsyncScope())
        {
            var database = discoveryScope.ServiceProvider.GetRequiredService<SignalDbContext>();
            var now = DateTime.UtcNow;
            userIds = await database.TopicRefreshStates
                .AsNoTracking()
                .Where(item => item.NextRefreshAtUtc != null && item.NextRefreshAtUtc <= now)
                .Select(item => item.UserId)
                .Distinct()
                .Take(25)
                .ToArrayAsync(cancellationToken);
        }

        foreach (var userId in userIds)
        {
            try
            {
                await using var refreshScope = scopeFactory.CreateAsyncScope();
                var service = refreshScope.ServiceProvider.GetRequiredService<TopicRefreshService>();
                await service.RefreshDueAsync(userId, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Scheduled topic refresh failed for user {UserId}.", userId);
            }
        }
    }
}
