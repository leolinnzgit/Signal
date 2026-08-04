using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-reader")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleReaderController(
    ArticleReaderService articleReader,
    ILogger<ArticleReaderController> logger) : ControllerBase
{
    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve([FromQuery] string url, CancellationToken cancellationToken)
    {
        try
        {
            return Ok(new { url = await articleReader.ResolveUrlAsync(url, cancellationToken) });
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { url, error = exception.Message });
        }
        catch (Exception exception)
        {
            logger.LogInformation(exception, "Could not resolve the publisher URL for {ArticleUrl}.", url);
            return Ok(new { url });
        }
    }

    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string url, CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await articleReader.ReadAsync(url, cancellationToken));
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { available = false, reason = exception.Message });
        }
        catch (InvalidOperationException exception)
        {
            logger.LogInformation(exception, "Article exceeded Signal Reader limits.");
            return Ok(new
            {
                available = false,
                reason = "This article is too large for Signal Reader.",
            });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Signal Reader could not prepare {ArticleUrl}.", url);
            return Ok(new
            {
                available = false,
                reason = "The publisher blocked extraction or the article is temporarily unavailable.",
            });
        }
    }
}
