using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/trends")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class TrendsController(
    GoogleTrendsService trends,
    ILogger<TrendsController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string? regions,
        [FromQuery] int count = GoogleTrendsService.DefaultTrendsPerRegion,
        CancellationToken cancellationToken = default)
    {
        if (count is < 1 or > GoogleTrendsService.MaximumTrendsPerRegion)
            return BadRequest(new { error = $"Choose between 1 and {GoogleTrendsService.MaximumTrendsPerRegion} trends per region." });

        var regionCodes = string.IsNullOrWhiteSpace(regions)
            ? null
            : regions.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (regionCodes is { Length: > 0 })
        {
            var supportedCodes = GoogleTrendsService.AvailableRegions
                .Select(region => region.Code)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (regionCodes.Any(code => !supportedCodes.Contains(code)))
                return BadRequest(new { error = "One or more selected Google Trends regions are not supported." });
        }

        try
        {
            var result = await trends.GetLatestAsync(regionCodes, count, cancellationToken);
            Response.Headers.CacheControl = "private, max-age=300";
            return Ok(result);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Google Trends could not be refreshed.");
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Google Trends is temporarily unavailable." });
        }
    }
}
