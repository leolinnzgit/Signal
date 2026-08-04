using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/market")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class MarketController(
    MarketDataService marketData,
    ILogger<MarketController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string topic,
        [FromQuery] string? symbol,
        CancellationToken cancellationToken)
    {
        try
        {
            var quote = await marketData.GetForTopicAsync(topic, symbol, cancellationToken);
            Response.Headers.CacheControl = "private, max-age=60";
            if (quote is not null) return Ok(new { matched = true, quote });

            return Ok(new
            {
                matched = false,
                topic,
                status = "not-found",
                message = "No confident public stock match was found.",
            });
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (MarketDataNotConfiguredException exception)
        {
            logger.LogInformation(exception, "Market pricing was requested before it was configured.");
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = exception.Message });
        }
        catch (MarketDataPlanRequiredException exception)
        {
            logger.LogInformation(exception, "Market pricing requires a higher provider plan for topic {Topic}.", topic);
            return StatusCode(StatusCodes.Status402PaymentRequired, new { error = exception.Message });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Market pricing failed for topic {Topic}.", topic);
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Market pricing is temporarily unavailable." });
        }
    }
}
