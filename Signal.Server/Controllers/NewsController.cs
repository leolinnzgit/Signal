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
    private const int MaxTextArticles = 20;
    private static readonly TimeSpan EnrichmentTimeout = TimeSpan.FromSeconds(15);

    [HttpGet]
    [Authorize(Policy = ApiKeyAuthenticationDefaults.NewsReadPolicy)]
    [EnableRateLimiting("news-extract")]
    public async Task<IActionResult> Get(
        [FromQuery(Name = "topic")] string[] requestedTopics,
        [FromServices] ArticleReaderService articleReader,
        [FromServices] MarketDataService marketData,
        [FromQuery] int limit = 20,
        [FromQuery] string provider = "google",
        [FromQuery] string? feed = null,
        [FromQuery] string? from = null,
        [FromQuery] string? to = null,
        [FromQuery] bool includeText = false,
        [FromQuery] bool includeMarketQuotes = false,
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

            if (result.Articles.Count > 0 && (includeText || includeMarketQuotes))
            {
                var articles = result.Articles.ToArray();
                var textTask = includeText ? LoadArticleTextAsync(articleReader, articles, cancellationToken) : Task.CompletedTask;
                var quotesTask = includeMarketQuotes
                    ? LoadMarketQuotesAsync(marketData, result.Articles, cancellationToken)
                    : Task.FromResult<Dictionary<long, ArticleMarketQuote[]>>([]);
                await Task.WhenAll(textTask, quotesTask);
                if (includeMarketQuotes)
                {
                    var quotes = await quotesTask;
                    for (var index = 0; index < articles.Length; index++)
                        articles[index] = articles[index] with { MarketQuotes = quotes.GetValueOrDefault(index) ?? [] };
                }
                result = result with { Articles = articles };
            }

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

    private async Task LoadArticleTextAsync(
        ArticleReaderService articleReader, NewsArticle[] articles, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(EnrichmentTimeout);
        try
        {
            var indexes = Enumerable.Range(0, Math.Min(articles.Length, MaxTextArticles));
            await Parallel.ForEachAsync(indexes, new ParallelOptions
            {
                MaxDegreeOfParallelism = 4,
                CancellationToken = deadline.Token,
            }, async (index, token) =>
            {
                try
                {
                    var result = await articleReader.ReadAsync(articles[index].Url, token, storeSearchText: false);
                    if (result is { Available: true, Paywalled: false, Article.Paragraphs.Count: > 0 })
                        articles[index] = articles[index] with { FullText = string.Join("\n\n", result.Article.Paragraphs) };
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception exception)
                {
                    logger.LogDebug(exception, "Could not extract text for a News API article.");
                }
            });
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            // Return the articles already enriched before the deadline.
        }
    }

    private static async Task<Dictionary<long, ArticleMarketQuote[]>> LoadMarketQuotesAsync(
        MarketDataService marketData, IReadOnlyList<NewsArticle> articles, CancellationToken cancellationToken)
    {
        var candidates = articles.Select((article, index) => (
            Key: (long)index,
            article.Title,
            Topics: article.MatchedTopics?.ToArray() ?? [],
            PublishedAtUtc: article.PublishedAt.UtcDateTime)).ToArray();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(EnrichmentTimeout);
        try
        {
            return await marketData.ResolveQuotesForArticlesAsync(
                candidates, tickerOverrides: null, deadline.Token, historicalOnly: true);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            return [];
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
