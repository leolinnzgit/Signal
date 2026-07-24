using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/news")]
public sealed class NewsController(NewsService newsService, ILogger<NewsController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery(Name = "topic")] string[] requestedTopics,
        [FromQuery] int limit = 20,
        [FromQuery] string provider = "google",
        [FromQuery] string? feed = null,
        CancellationToken cancellationToken = default)
    {
        var topics = requestedTopics
            .Select(topic => topic.Trim())
            .Where(topic => topic.Length > 0)
            .Select(topic => topic[..Math.Min(topic.Length, 80)])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (topics.Length == 0) topics = ["Artificial intelligence"];
        limit = Math.Clamp(limit, 20, 500);
        provider = provider.Trim().ToLowerInvariant();

        try
        {
            var result = provider switch
            {
                "google" => await newsService.GetGoogleNewsAsync(topics[0], limit, cancellationToken),
                "gdelt" => await newsService.GetGdeltNewsAsync(topics, limit, cancellationToken),
                "rss" when !string.IsNullOrWhiteSpace(feed) =>
                    await newsService.GetPublisherFeedAsync(feed, topics[0], limit, cancellationToken),
                "rss" => throw new ArgumentException("Choose a publisher RSS or Atom feed."),
                _ => throw new ArgumentException("Unknown news provider."),
            };

            Response.Headers.CacheControl = "private, max-age=120";
            return Ok(result);
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
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
}
