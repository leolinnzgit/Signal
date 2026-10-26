using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/weather")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class WeatherController(WeatherLocationService locations) : ControllerBase
{
    [HttpGet("location")]
    public async Task<IActionResult> Location([FromQuery] double? latitude, [FromQuery] double? longitude, CancellationToken ct)
    {
        if (!latitude.HasValue || !longitude.HasValue || !EarthquakeFeed.ValidLocation(latitude.Value, longitude.Value))
            return BadRequest(new { error = "Choose valid latitude and longitude coordinates." });
        try { return Ok(new { name = await locations.GetAsync(latitude.Value, longitude.Value, ct) }); }
        catch (Exception error) when (!ct.IsCancellationRequested && error is HttpRequestException or JsonException or OperationCanceledException)
        {
            return StatusCode(503, new { error = "The town name is temporarily unavailable." });
        }
    }
}
