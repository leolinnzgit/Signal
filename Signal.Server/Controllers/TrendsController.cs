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
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        try
        {
            var result = await trends.GetLatestAsync(cancellationToken);
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
