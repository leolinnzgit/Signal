using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;

namespace Signal.Server.Services;

public sealed class EarthquakeMonitor(IServiceScopeFactory scopes, ILogger<EarthquakeMonitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
            using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
            do
            {
                try { await CheckAsync(stoppingToken); }
                catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                { logger.LogWarning(ex, "Disaster monitoring failed; retrying next minute."); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    public async Task CheckAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var database = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
        var feed = scope.ServiceProvider.GetRequiredService<DisasterAlertFeed>();
        var push = scope.ServiceProvider.GetRequiredService<PushNotificationService>();
        var now = DateTime.UtcNow;
        var devices = await database.EarthquakeDevices.AsNoTracking()
            .Where(d => d.LocationUpdatedAtUtc >= now.AddHours(-24) && d.PushEndpoint != "").ToArrayAsync(ct);
        foreach (var device in devices)
        {
            try
            {
                var result = await feed.GetAsync(device, ct);
                foreach (var warning in result.Warnings) logger.LogWarning("Disaster device {DeviceId}: {Warning}", device.Id, warning);
                HashSet<string> seen;
                try { seen = (JsonSerializer.Deserialize<string[]>(device.SeenJson) ?? []).ToHashSet(); }
                catch (JsonException) { seen = []; }
                foreach (var e in result.Events.Where(e => !seen.Contains(e.NotificationKey)))
                {
                    if (await push.SendDisasterAsync(device.UserId, device.PushEndpoint, e, ct) > 0) seen.Add(e.NotificationKey);
                }
                // Update only the deduplication field so a concurrent GPS update cannot be overwritten.
                // Keep successful deliveries through source outages so recovery cannot repeat old alerts.
                var retained = seen.TakeLast(2000).ToArray();
                var json = JsonSerializer.Serialize(retained);
                await database.EarthquakeDevices.Where(d => d.Id == device.Id).ExecuteUpdateAsync(
                    setters => setters.SetProperty(d => d.SeenJson, json), ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            { logger.LogWarning(ex, "Could not check disaster device {DeviceId}.", device.Id); }
        }
        // Expired locations are removed rather than retained indefinitely.
        await database.EarthquakeDevices.Where(d => d.LocationUpdatedAtUtc < now.AddDays(-7)).ExecuteDeleteAsync(ct);
    }
}
