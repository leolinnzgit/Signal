using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/weather/alerts")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class WeatherAlertsController(
    SignalDbContext database,
    UserManager<ApplicationUser> users,
    AzureMapsWeatherService weatherService) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetAlerts(
        [FromQuery] double? latitude,
        [FromQuery] double? longitude,
        CancellationToken ct)
    {
        var coords = await ResolveCoordinatesAsync(latitude, longitude, ct);
        if (!coords.HasValue)
        {
            return Ok(new WeatherAlertsResult(false, "No valid weather location configured.", [], DateTime.UtcNow));
        }

        var result = await weatherService.GetAlertsAsync(coords.Value.Latitude, coords.Value.Longitude, ct);
        return Ok(result);
    }

    [HttpGet("/api/weather/conditions")]
    public async Task<IActionResult> GetConditions(
        [FromQuery] double? latitude,
        [FromQuery] double? longitude,
        CancellationToken ct)
    {
        var coords = await ResolveCoordinatesAsync(latitude, longitude, ct);
        if (!coords.HasValue)
        {
            return Ok(new WeatherConditions(false, "No valid weather location configured.", null, "", null, "", "", "", DateTime.UtcNow));
        }

        var result = await weatherService.GetConditionsAsync(coords.Value.Latitude, coords.Value.Longitude, ct);
        return Ok(result);
    }

    private async Task<(double Latitude, double Longitude)?> ResolveCoordinatesAsync(double? latitude, double? longitude, CancellationToken ct)
    {
        double? targetLat = latitude;
        double? targetLon = longitude;

        if (!targetLat.HasValue || !targetLon.HasValue || !EarthquakeFeed.ValidLocation(targetLat.Value, targetLon.Value))
        {
            var userId = users.GetUserId(User);
            if (userId is not null)
            {
                var preferences = await database.UserNewsPreferences.AsNoTracking()
                    .SingleOrDefaultAsync(p => p.UserId == userId, ct);

                if (preferences is not null && !string.IsNullOrWhiteSpace(preferences.WeatherLocationJson))
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(preferences.WeatherLocationJson);
                        if (doc.RootElement.TryGetProperty("latitude", out var latProp) &&
                            doc.RootElement.TryGetProperty("longitude", out var lonProp) &&
                            latProp.TryGetDouble(out var lat) && lonProp.TryGetDouble(out var lon) &&
                            EarthquakeFeed.ValidLocation(lat, lon))
                        {
                            targetLat = lat;
                            targetLon = lon;
                        }
                    }
                    catch (JsonException) { }
                }
            }
        }

        if (targetLat.HasValue && targetLon.HasValue)
        {
            return (targetLat.Value, targetLon.Value);
        }

        return null;
    }
}
