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
    IOptions<AzureMapsOptions> mapsOptions) : ControllerBase
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

        if (latitude.HasValue && longitude.HasValue && EarthquakeFeed.ValidLocation(latitude.Value, longitude.Value))
        {
            userLat = latitude.Value;
            userLon = longitude.Value;
        }
        else
        {
            var device = await database.EarthquakeDevices.AsNoTracking()
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
        var quakeTask = LoadEarthquakes();
        var disasterTask = LoadDisasters();
        await Task.WhenAll(quakeTask, disasterTask);
        var events = await quakeTask;
        var disasterEvents = await disasterTask;
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
            warnings,
            userLocation = userLat.HasValue && userLon.HasValue
                ? new { latitude = userLat.Value, longitude = userLon.Value, radiusKm }
                : null,
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
