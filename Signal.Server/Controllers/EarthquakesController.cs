using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/earthquakes")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class EarthquakesController(
    SignalDbContext database,
    UserManager<ApplicationUser> users,
    EarthquakeFeed feed,
    DisasterFeed disasters,
    DisasterAlertFeed alerts,
    IOptions<AzureMapsOptions> mapsOptions,
    AzureMapsWeatherService? weather = null) : ControllerBase
{
    [HttpGet("config")]
    public IActionResult Config()
    {
        return Ok(new
        {
            azureMapsConfigured = mapsOptions.Value.Enabled,
            subscriptionKey = mapsOptions.Value.Enabled ? mapsOptions.Value.SubscriptionKey : ""
        });
    }

    [HttpGet("map-feed")]
    public async Task<IActionResult> MapFeed(
        [FromQuery] double? latitude,
        [FromQuery] double? longitude,
        [FromQuery] string? source,
        CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        double? userLat = null;
        double? userLon = null;
        double radiusKm = 300;
        EarthquakeDevice? device = null;

        if (latitude.HasValue && longitude.HasValue && EarthquakeFeed.ValidLocation(latitude.Value, longitude.Value))
        {
            userLat = latitude.Value;
            userLon = longitude.Value;
        }
        else
        {
            device = await database.EarthquakeDevices.AsNoTracking()
                .Where(d => d.UserId == userId)
                .OrderByDescending(d => d.LocationUpdatedAtUtc)
                .FirstOrDefaultAsync(ct);
            if (device is not null)
            {
                userLat = device.Latitude;
                userLon = device.Longitude;
                radiusKm = device.RadiusKm;
            }
        }

        device ??= await database.EarthquakeDevices.AsNoTracking()
            .Where(d => d.UserId == userId)
            .OrderByDescending(d => d.LocationUpdatedAtUtc)
            .FirstOrDefaultAsync(ct);

        bool geoNet = source?.ToLowerInvariant() switch
        {
            "geonet" => true,
            "usgs" => false,
            _ => !userLat.HasValue || !userLon.HasValue || EarthquakeFeed.UseGeoNet(userLat.Value, userLon.Value)
        };

        var warnings = new List<string>();
        async Task<Earthquake[]> LoadEarthquakes()
        {
            try { return await feed.GetFeedAsync(geoNet, ct); }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or JsonException or TaskCanceledException)
            { lock (warnings) warnings.Add("Earthquake feed unavailable. Retry to check for updates."); return []; }
        }
        async Task<DisasterEvent[]> LoadDisasters()
        {
            try { return await disasters.GetAsync(ct); }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or System.Xml.XmlException or TaskCanceledException)
            { lock (warnings) warnings.Add("GDACS disaster feed unavailable. Retry to check floods and other disasters."); return []; }
        }
        async Task<(object[] Alerts, string? Warning)> LoadWeather()
        {
            if (!userLat.HasValue || !userLon.HasValue || weather is null || !weather.Enabled)
                return ([], null);
            try
            {
                var result = await weather.GetAlertsAsync(userLat.Value, userLon.Value, ct);
                if (!result.Available) return ([], null);
                var items = result.Alerts.Select(a =>
                {
                    var alertLevel = a.Level.ToLowerInvariant().Contains("warning") ? "red" : "orange";
                    return (object)new
                    {
                        id = $"azure:weather:{a.Id}",
                        kind = "weather",
                        title = string.IsNullOrWhiteSpace(a.Headline) ? a.Description : a.Headline,
                        place = string.IsNullOrWhiteSpace(a.AreaName) ? "Local area" : a.AreaName,
                        source = string.IsNullOrWhiteSpace(a.Source) ? "Azure Maps Weather" : a.Source,
                        alertLevel,
                        description = a.Description,
                        timeUtc = (a.EffectiveTime ?? DateTimeOffset.UtcNow).UtcDateTime,
                        distanceKm = 0.0
                    };
                }).ToArray();
                return (items, null);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or JsonException or TaskCanceledException)
            {
                return ([], "Azure Maps weather alerts temporarily unavailable.");
            }
        }
        async Task<object?> LoadActiveAlert()
        {
            if (device is null) return null;
            try
            {
                var alertResult = await alerts.GetAsync(device, ct);
                var top = alertResult.Events
                    .Where(e => (e.UpdatedAtUtc >= DateTime.UtcNow.AddHours(-24) || e.TimeUtc >= DateTime.UtcNow.AddHours(-24)))
                    .OrderByDescending(e => e.Kind == "earthquake" ? ((e.Magnitude ?? 0) >= 6.0 ? 3 : (e.Magnitude ?? 0) >= 4.5 ? 2 : 1) : (e.AlertLevel == "red" ? 3 : e.AlertLevel == "orange" ? 2 : 1))
                    .ThenByDescending(e => e.UpdatedAtUtc)
                    .FirstOrDefault();
                if (top is null) return null;
                var msg = PushNotificationService.DisasterMessage(top);
                return new
                {
                    id = top.Id,
                    tag = msg.Tag,
                    title = msg.Title,
                    body = msg.Body,
                    url = msg.Url,
                    kind = top.Kind,
                    alertLevel = top.AlertLevel ?? (top.Kind == "earthquake" ? ((top.Magnitude ?? 0) >= 6.0 ? "red" : (top.Magnitude ?? 0) >= 4.5 ? "orange" : "green") : "green"),
                    place = top.Place,
                    distanceKm = top.DistanceKm,
                    receivedAt = new DateTimeOffset(top.UpdatedAtUtc).ToUnixTimeMilliseconds()
                };
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                return null;
            }
        }

        var quakeTask = LoadEarthquakes();
        var disasterTask = LoadDisasters();
        var weatherTask = LoadWeather();
        var activeAlertTask = LoadActiveAlert();
        await Task.WhenAll(quakeTask, disasterTask, weatherTask, activeAlertTask);
        var events = await quakeTask;
        var disasterEvents = await disasterTask;
        var (weatherEvents, weatherWarning) = await weatherTask;
        if (weatherWarning is not null) lock (warnings) warnings.Add(weatherWarning);
        var activeAlert = await activeAlertTask;

        if (userLat.HasValue && userLon.HasValue)
        {
            disasterEvents = disasterEvents.Select(e => e with
            {
                DistanceKm = EarthquakeFeed.DistanceKm(userLat.Value, userLon.Value, e.Latitude, e.Longitude)
            }).OrderBy(e => e.DistanceKm).ToArray();
            events = events.Select(e => e with
            {
                DistanceKm = EarthquakeFeed.DistanceKm(userLat.Value, userLon.Value, e.Latitude, e.Longitude)
            }).OrderBy(e => e.DistanceKm).ToArray();
        }

        return Ok(new
        {
            azureMapsConfigured = mapsOptions.Value.Enabled,
            subscriptionKey = mapsOptions.Value.Enabled ? mapsOptions.Value.SubscriptionKey : "",
            source = geoNet ? "GeoNet" : "USGS",
            events,
            disasters = disasterEvents,
            weather = weatherEvents,
            activeAlert,
            warnings,
            userLocation = userLat.HasValue && userLon.HasValue
                ? new { latitude = userLat.Value, longitude = userLon.Value, radiusKm }
                : null,
            checkedAtUtc = DateTime.UtcNow
        });
    }

    [HttpGet("active")]
    [HttpGet("/api/disasters/active")]
    public async Task<IActionResult> ActiveDisaster(CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        var device = await database.EarthquakeDevices.AsNoTracking()
            .Where(d => d.UserId == userId)
            .OrderByDescending(d => d.LocationUpdatedAtUtc)
            .FirstOrDefaultAsync(ct);
        if (device is null) return Ok(new { active = false, reason = "No registered disaster device" });
        if (device.LocationUpdatedAtUtc < DateTime.UtcNow.AddHours(-24))
            return Ok(new { active = false, reason = "Refresh your phone location to resume disaster monitoring." });

        var result = await alerts.GetAsync(device, ct);
        var top = result.Events
            .Where(e => (e.UpdatedAtUtc >= DateTime.UtcNow.AddHours(-24) || e.TimeUtc >= DateTime.UtcNow.AddHours(-24)))
            .OrderByDescending(e => e.Kind == "earthquake" ? ((e.Magnitude ?? 0) >= 6.0 ? 3 : (e.Magnitude ?? 0) >= 4.5 ? 2 : 1) : (e.AlertLevel == "red" ? 3 : e.AlertLevel == "orange" ? 2 : 1))
            .ThenByDescending(e => e.UpdatedAtUtc)
            .FirstOrDefault();

        if (top is null) return Ok(new { active = false, checkedAtUtc = DateTime.UtcNow });

        var msg = PushNotificationService.DisasterMessage(top);
        return Ok(new
        {
            active = true,
            alert = new
            {
                id = top.Id,
                tag = msg.Tag,
                title = msg.Title,
                body = msg.Body,
                url = msg.Url,
                kind = top.Kind,
                alertLevel = top.AlertLevel ?? (top.Kind == "earthquake" ? ((top.Magnitude ?? 0) >= 6.0 ? "red" : (top.Magnitude ?? 0) >= 4.5 ? "orange" : "green") : "green"),
                place = top.Place,
                distanceKm = top.DistanceKm,
                receivedAt = new DateTimeOffset(top.UpdatedAtUtc).ToUnixTimeMilliseconds()
            },
            source = result.Source,
            checkedAtUtc = DateTime.UtcNow
        });
    }

    [HttpPut("devices/{id:guid}")]
    [HttpPut("/api/disasters/devices/{id:guid}")]
    public async Task<IActionResult> Save(Guid id, EarthquakeDeviceRequest request, CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        if (request.HazardKinds is not null && (request.HazardKinds.Length < 1 || request.HazardKinds.Length > DisasterAlertFeed.Kinds.Length || request.HazardKinds.Any(k => !DisasterAlertFeed.Kinds.Contains(k)))
            || request.WeatherAlertThreshold is not null && request.WeatherAlertThreshold != "all" && request.WeatherAlertThreshold != "warnings"
            || request.MinimumAlertLevel is not null && DisasterAlertFeed.Level(request.MinimumAlertLevel) < 0)
            return BadRequest(new { error = "Choose at least one supported disaster type and a valid GDACS alert level." });
        if (!EarthquakeFeed.ValidLocation(request.Latitude, request.Longitude)
            || !double.IsFinite(request.RadiusKm) || request.RadiusKm is < 25 or > 1000
            || !double.IsFinite(request.MinimumMagnitude) || request.MinimumMagnitude is < 2 or > 8)
            return BadRequest(new { error = "Choose a valid location, distance (25–1000 km), and magnitude (2–8)." });
        var device = await database.EarthquakeDevices.FindAsync([id.ToString()], ct);
        if (device is not null && device.UserId != userId) return NotFound();
        if (device is null)
        {
            if (await database.EarthquakeDevices.CountAsync(d => d.UserId == userId, ct) >= 20)
                return BadRequest(new { error = "Too many earthquake devices are registered." });
            device = new EarthquakeDevice { Id = id.ToString(), UserId = userId, EnabledAtUtc = DateTime.UtcNow };
            database.EarthquakeDevices.Add(device);
        }
        device.Latitude = request.Latitude;
        device.Longitude = request.Longitude;
        device.RadiusKm = request.RadiusKm;
        device.MinimumMagnitude = request.MinimumMagnitude;
        if (request.HazardKinds is not null) device.HazardKindsJson = JsonSerializer.Serialize(request.HazardKinds.Distinct());
        if (request.MinimumAlertLevel is not null) device.MinimumAlertLevel = request.MinimumAlertLevel;
        if (request.WeatherAlertThreshold is not null) device.WeatherAlertThreshold = request.WeatherAlertThreshold;
        device.LocationUpdatedAtUtc = DateTime.UtcNow;
        // Only target an authenticated subscription owned by this account.
        device.PushEndpoint = !string.IsNullOrEmpty(request.PushEndpoint)
            && await database.UserPushSubscriptions.AnyAsync(s => s.UserId == userId && s.Endpoint == request.PushEndpoint, ct)
            ? request.PushEndpoint : "";
        await database.SaveChangesAsync(ct);
        return Ok(new { device.LocationUpdatedAtUtc, backgroundPush = device.PushEndpoint.Length > 0 });
    }

    [HttpGet("devices/{id:guid}")]
    public async Task<IActionResult> Check(Guid id, CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        var device = await database.EarthquakeDevices.AsNoTracking().SingleOrDefaultAsync(d => d.Id == id.ToString() && d.UserId == userId, ct);
        if (device is null) return NotFound();
        if (device.LocationUpdatedAtUtc < DateTime.UtcNow.AddHours(-24))
            return StatusCode(409, new { error = "Refresh your phone location to resume earthquake monitoring." });
        try
        {
            var events = await feed.GetAsync(device.Latitude, device.Longitude, ct);
            return Ok(new { events = EarthquakeFeed.Nearby(events, device, DateTime.UtcNow), checkedAtUtc = DateTime.UtcNow,
                source = EarthquakeFeed.UseGeoNet(device.Latitude, device.Longitude) ? "GeoNet" : "USGS" });
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return StatusCode(503, new { error = "Earthquake feed unavailable. Retrying in one minute." }); }
    }

    [HttpDelete("devices/{id:guid}")]
    [HttpDelete("/api/disasters/devices/{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        await database.EarthquakeDevices.Where(d => d.Id == id.ToString() && d.UserId == userId).ExecuteDeleteAsync(ct);
        return NoContent();
    }

    [HttpGet("/api/disasters/devices/{id:guid}")]
    public async Task<IActionResult> CheckDisasters(Guid id, CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        var device = await database.EarthquakeDevices.AsNoTracking().SingleOrDefaultAsync(d => d.Id == id.ToString() && d.UserId == userId, ct);
        if (device is null) return NotFound();
        if (device.LocationUpdatedAtUtc < DateTime.UtcNow.AddHours(-24))
            return StatusCode(409, new { error = "Refresh your phone location to resume disaster monitoring." });
        return Ok(await alerts.GetAsync(device, ct));
    }
}

public sealed record EarthquakeDeviceRequest(double Latitude, double Longitude, double RadiusKm, double MinimumMagnitude, string? PushEndpoint,
    string[]? HazardKinds = null, string? MinimumAlertLevel = null, string? WeatherAlertThreshold = null);
