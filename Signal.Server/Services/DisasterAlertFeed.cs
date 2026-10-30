using System.Text.Json;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed record DisasterAlertEvent(string Id, string NotificationKey, string Kind, string Source, string Place,
    DateTime TimeUtc, DateTime UpdatedAtUtc, double Latitude, double Longitude, double DistanceKm, string Url,
    double? Magnitude = null, double? DepthKm = null, string? AlertLevel = null, string? Description = null);
public sealed record DisasterAlertResult(DisasterAlertEvent[] Events, string[] Warnings, DateTime CheckedAtUtc, string Source);

public sealed class DisasterAlertFeed(EarthquakeFeed earthquakes, DisasterFeed disasters, AzureMapsWeatherService? weather = null)
{
    public static readonly string[] Kinds = ["earthquake", "flood", "storm", "wildfire", "volcano", "drought", "weather"];
    public static int Level(string? level) => level switch { "green" => 0, "orange" => 1, "red" => 2, _ => -1 };
    public static string Label(string kind) => kind switch
    {
        "earthquake" => "Earthquake",
        "flood" => "Flood",
        "storm" => "Tropical cyclone",
        "wildfire" => "Wildfire",
        "volcano" => "Volcanic activity",
        "drought" => "Drought",
        "weather" => "Severe weather",
        _ => "Disaster"
    };

    public static string[] DeviceKinds(EarthquakeDevice device)
    {
        try { return (JsonSerializer.Deserialize<string[]>(device.HazardKindsJson) ?? []).Where(Kinds.Contains).Distinct().ToArray(); }
        catch (JsonException) { return ["earthquake"]; }
    }

    public static DisasterAlertEvent[] Nearby(IEnumerable<DisasterEvent> events, EarthquakeDevice device, DateTime now)
    {
        var kinds = DeviceKinds(device);
        return events.Where(e => kinds.Contains(e.Kind) && Level(e.AlertLevel) >= Level(device.MinimumAlertLevel)
                && Level(e.AlertLevel) >= 0 && (e.UpdatedAtUtc ?? e.TimeUtc) >= now.AddHours(-24)
                && (e.UpdatedAtUtc ?? e.TimeUtc) <= now && e.TimeUtc <= now)
            .Select(e => new DisasterAlertEvent(e.Id, $"{e.Id}:{e.Episode}:{e.AlertLevel}", e.Kind, e.Source, e.Title,
                e.TimeUtc, e.UpdatedAtUtc ?? e.TimeUtc, e.Latitude, e.Longitude,
                EarthquakeFeed.DistanceKm(device.Latitude, device.Longitude, e.Latitude, e.Longitude), e.Url,
                AlertLevel: e.AlertLevel, Description: e.Description))
            .Where(e => e.DistanceKm <= device.RadiusKm).OrderBy(e => e.UpdatedAtUtc).ToArray();
    }

    public async Task<DisasterAlertResult> GetAsync(EarthquakeDevice device, CancellationToken ct)
    {
        var kinds = DeviceKinds(device);
        var now = DateTime.UtcNow;

        async Task<(DisasterAlertEvent[] Events, string? Warning)> Quakes()
        {
            if (!kinds.Contains("earthquake")) return ([], null);
            try
            {
                var feed = await earthquakes.GetAsync(device.Latitude, device.Longitude, ct);
                return (EarthquakeFeed.Nearby(feed, device, now).Select(e => new DisasterAlertEvent(e.Id, e.Id, "earthquake", e.Source,
                    e.Place, e.TimeUtc, e.TimeUtc, e.Latitude, e.Longitude, e.DistanceKm, e.Url, e.Magnitude, e.DepthKm)).ToArray(), null);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or JsonException or TaskCanceledException)
            { return ([], "Earthquake feed unavailable. Retrying in one minute."); }
        }

        async Task<(DisasterAlertEvent[] Events, string? Warning)> OtherDisasters()
        {
            if (!kinds.Any(kind => kind != "earthquake" && kind != "weather")) return ([], null);
            try { return (Nearby(await disasters.GetAsync(ct), device, now), null); }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or System.Xml.XmlException or TaskCanceledException)
            { return ([], "GDACS disaster feed unavailable. Retrying in one minute."); }
        }

        async Task<(DisasterAlertEvent[] Events, string? Warning)> WeatherAlerts()
        {
            if (!kinds.Contains("weather") || weather is null || !weather.Enabled) return ([], null);
            try
            {
                var result = await weather.GetAlertsAsync(device.Latitude, device.Longitude, ct);
                if (!result.Available) return ([], null);
                var alerts = result.Alerts.Select(a =>
                {
                    var alertLevel = a.Level.ToLowerInvariant().Contains("warning") ? "red" : "orange";
                    return new DisasterAlertEvent(
                        Id: $"azure:weather:{a.Id}",
                        NotificationKey: $"weather:{a.Id}:{a.Level}",
                        Kind: "weather",
                        Source: string.IsNullOrWhiteSpace(a.Source) ? "Azure Maps Weather" : a.Source,
                        Place: string.IsNullOrWhiteSpace(a.AreaName) ? "Local area" : a.AreaName,
                        TimeUtc: (a.EffectiveTime ?? DateTimeOffset.UtcNow).UtcDateTime,
                        UpdatedAtUtc: (a.EffectiveTime ?? DateTimeOffset.UtcNow).UtcDateTime,
                        Latitude: device.Latitude,
                        Longitude: device.Longitude,
                        DistanceKm: 0,
                        Url: "/#weather-alerts",
                        AlertLevel: alertLevel,
                        Description: string.IsNullOrWhiteSpace(a.Headline) ? a.Description : a.Headline);
                }).Where(e => Level(e.AlertLevel) >= Level(device.MinimumAlertLevel)).ToArray();
                return (alerts, null);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or JsonException or TaskCanceledException)
            { return ([], "Azure Maps weather alerts temporarily unavailable."); }
        }

        var quakeTask = Quakes();
        var disasterTask = OtherDisasters();
        var weatherTask = WeatherAlerts();
        await Task.WhenAll(quakeTask, disasterTask, weatherTask);
        var q = await quakeTask;
        var d = await disasterTask;
        var w = await weatherTask;

        var sources = new[]
        {
            kinds.Contains("earthquake") ? (EarthquakeFeed.UseGeoNet(device.Latitude, device.Longitude) ? "GeoNet" : "USGS") : null,
            kinds.Any(k => k != "earthquake" && k != "weather") ? "GDACS" : null,
            kinds.Contains("weather") && weather?.Enabled == true ? "Azure Maps Weather" : null
        }.OfType<string>();

        return new DisasterAlertResult(
            q.Events.Concat(d.Events).Concat(w.Events).OrderBy(e => e.UpdatedAtUtc).ToArray(),
            new[] { q.Warning, d.Warning, w.Warning }.OfType<string>().ToArray(),
            DateTime.UtcNow,
            string.Join(" + ", sources));
    }
}
