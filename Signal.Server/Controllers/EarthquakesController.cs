using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/earthquakes")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class EarthquakesController(SignalDbContext database, UserManager<ApplicationUser> users, EarthquakeFeed feed) : ControllerBase
{
    [HttpPut("devices/{id:guid}")]
    public async Task<IActionResult> Save(Guid id, EarthquakeDeviceRequest request, CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
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
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        var userId = users.GetUserId(User)!;
        await database.EarthquakeDevices.Where(d => d.Id == id.ToString() && d.UserId == userId).ExecuteDeleteAsync(ct);
        return NoContent();
    }
}

public sealed record EarthquakeDeviceRequest(double Latitude, double Longitude, double RadiusKm, double MinimumMagnitude, string? PushEndpoint);
