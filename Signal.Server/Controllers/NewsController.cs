using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/news")]
public sealed class NewsController(NewsService newsService, ILogger<NewsController> logger) : ControllerBase
{
    [HttpGet]
    [Authorize(Policy = ApiKeyAuthenticationDefaults.NewsReadPolicy)]
    [EnableRateLimiting("news-extract")]
    public async Task<IActionResult> Get(
        [FromQuery(Name = "topic")] string[] requestedTopics,
        [FromQuery] int limit = 20,
        [FromQuery] string provider = "google",
        [FromQuery] string? feed = null,
        [FromQuery] string? from = null,
        [FromQuery] string? to = null,
        CancellationToken cancellationToken = default)
    {
        var topics = requestedTopics
            .Select(topic => topic.Trim())
            .Where(topic => topic.Length > 0)
            .Select(topic => topic[..Math.Min(topic.Length, 80)])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(20)
            .ToArray();
        if (topics.Length == 0) topics = ["Artificial intelligence"];

        if (!NewsDateRange.TryParse(from, to, out var dateRange, out var dateError))
            return BadRequest(new { error = dateError });

        limit = Math.Clamp(limit, 1, 500);
        provider = provider.Trim().ToLowerInvariant();

        try
        {
            var result = provider switch
            {
                "google" => await newsService.GetGoogleNewsAsync(topics, limit, dateRange, cancellationToken),
                "gdelt" => await newsService.GetGdeltNewsAsync(topics, limit, dateRange, cancellationToken),
                "all" => await newsService.GetCombinedNewsAsync(topics, limit, dateRange, cancellationToken),
                "rss" when !string.IsNullOrWhiteSpace(feed) =>
                    await newsService.GetPublisherFeedAsync(feed, topics, limit, dateRange, cancellationToken),
                "rss" => throw new ArgumentException("Choose a publisher RSS or Atom feed."),
                _ => throw new ArgumentException("Unknown news provider."),
            };

            Response.Headers.Vary = "Cookie, Authorization, X-API-Key";
            Response.Headers.CacheControl = User.HasClaim(claim => claim.Type == ApiKeyAuthenticationDefaults.KeyIdClaimType)
                ? "private, no-store"
                : "private, max-age=120";
            return Ok(result);
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "News provider {Provider} failed.", provider);
            var message = exception.Message.StartsWith("Publisher feed", StringComparison.Ordinal)
                ? exception.Message
                : "This news source is temporarily unavailable.";
            return StatusCode(StatusCodes.Status502BadGateway, new { error = message });
        }
    }

    [HttpPost("sources/diagnostics")]
    [Authorize]
    [EnableRateLimiting("account")]
    public async Task<IActionResult> RunDiagnostics(
        [FromBody] PreferencesController.SourceDiagnosticsRequest? request,
        CancellationToken cancellationToken)
    {
        var feedUrls = (request?.Feeds ?? []).Take(PreferencesController.MaxRssFeeds).ToArray();
        var results = await PreferencesController.DiagnoseFeedsAsync(newsService, feedUrls, cancellationToken);
        return Ok(new PreferencesController.SourceDiagnosticsResponse(results));
    }
}
