using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/market")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class MarketController(
    MarketDataService marketData,
    SignalDbContext database,
    UserManager<ApplicationUser> userManager,
    ILogger<MarketController> logger) : ControllerBase
{
    public sealed record MarketWatchlistRequest(MarketWatchlistTopicInput[]? Items, int MaxQuotes = 5, bool IncludeSparklines = false);
    public sealed record MarketWatchlistResponse(bool Configured, MarketQuote[] Quotes);

    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string topic,
        [FromQuery] string? symbol,
        CancellationToken cancellationToken,
        [FromQuery] bool sparkline = false,
        [FromQuery] bool optional = false)
    {
        try
        {
            var quote = await marketData.GetForTopicAsync(topic, symbol, cancellationToken, sparkline);
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
            // Automatic topic enrichment is optional. Report the unavailable
            // quote explicitly instead of turning every headline into an HTTP error.
            if (optional || string.IsNullOrWhiteSpace(symbol))
                return Ok(new { matched = false, topic, status = "plan-required", message = exception.Message });
            logger.LogInformation(exception, "Market pricing requires a higher provider plan for topic {Topic}.", topic);
            return StatusCode(StatusCodes.Status402PaymentRequired, new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Market pricing failed for topic {Topic}.", topic);
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Market pricing is temporarily unavailable." });
        }
    }

    [HttpPost("watchlist")]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> Watchlist(
        [FromBody] MarketWatchlistRequest? request,
        CancellationToken cancellationToken)
    {
        if (!marketData.IsConfigured)
        {
            return Ok(new MarketWatchlistResponse(false, []));
        }

        try
        {
            var quotes = await marketData.GetWatchlistAsync(
                request?.Items,
                request?.MaxQuotes ?? 5,
                cancellationToken,
                request?.IncludeSparklines ?? false);
            return Ok(new MarketWatchlistResponse(true, quotes));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Market watchlist lookup failed.");
            return Ok(new MarketWatchlistResponse(true, []));
        }
    }

    [HttpGet("portfolio")]
    public async Task<IActionResult> GetPortfolio(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        var portfolioItems = PreferencesController.DeserializeMarketPortfolio(preferences?.MarketPortfolioJson);
        if (portfolioItems.Length == 0)
        {
            return Ok(new
            {
                configured = marketData.IsConfigured,
                items = Array.Empty<object>(),
                hasAlerts = false
            });
        }

        if (!marketData.IsConfigured)
        {
            return Ok(new
            {
                configured = false,
                items = portfolioItems.Select(item => new
                {
                    item.Symbol,
                    item.DisplayName,
                    item.AlertThresholdPercent,
                    item.AlertEnabled,
                    isAlertTriggered = false,
                    alertDirection = (string?)null,
                    quote = (MarketQuote?)null
                }),
                hasAlerts = false
            });
        }

        var quotes = await marketData.GetWatchlistAsync(
            portfolioItems.Select(p => new MarketWatchlistTopicInput(p.DisplayName, p.Symbol)).ToArray(),
            portfolioItems.Length,
            cancellationToken,
            includeSparklines: true);

        var items = portfolioItems.Select(item =>
        {
            var matchedQuote = quotes.FirstOrDefault(q =>
                string.Equals(q.Symbol, item.Symbol, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(q.Topic, item.DisplayName, StringComparison.OrdinalIgnoreCase));

            var isTriggered = matchedQuote is not null
                && item.AlertEnabled
                && Math.Abs(matchedQuote.PercentChange) >= item.AlertThresholdPercent;

            return new
            {
                item.Symbol,
                item.DisplayName,
                item.AlertThresholdPercent,
                item.AlertEnabled,
                isAlertTriggered = isTriggered,
                alertDirection = matchedQuote is null ? null : (matchedQuote.PercentChange >= 0 ? "up" : "down"),
                quote = matchedQuote
            };
        }).ToArray();

        return Ok(new
        {
            configured = true,
            items,
            hasAlerts = items.Any(i => i.isAlertTriggered)
        });
    }

    [HttpPost("portfolio")]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> SavePortfolio(
        [FromBody] MarketPortfolioItemRequest[]? items,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var normalized = PreferencesController.NormalizeMarketPortfolio(items);
        var json = JsonSerializer.Serialize(normalized);

        var preferences = await database.UserNewsPreferences
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        if (preferences is null)
        {
            preferences = new UserNewsPreferences { UserId = userId, MarketPortfolioJson = json };
            database.UserNewsPreferences.Add(preferences);
        }
        else
        {
            preferences.MarketPortfolioJson = json;
            preferences.UpdatedAtUtc = DateTimeOffset.UtcNow;
        }

        await database.SaveChangesAsync(cancellationToken);
        return await GetPortfolio(cancellationToken);
    }

    public sealed record MacroCorrelationStory(
        string Title,
        string Url,
        string Source,
        string ImpactType);

    public sealed record MarketSentimentAsset(
        string Symbol,
        string Name,
        string Sector,
        decimal Price,
        decimal ChangePercent,
        string SentimentTone,
        MacroCorrelationStory[] Attributions);

    public sealed record MarketSentimentMatrixRequest(
        MarketWatchlistTopicInput[]? Items,
        string[]? Headlines,
        string? SectorFilter = null);

    public sealed record MarketSentimentMatrixResponse(
        bool Configured,
        MarketSentimentAsset[] Assets,
        string MacroHeadline);

    [HttpPost("matrix")]
    [RequestSizeLimit(32_768)]
    public async Task<IActionResult> GetSentimentMatrix(
        [FromBody] MarketSentimentMatrixRequest? request,
        CancellationToken cancellationToken)
    {
        var headlines = request?.Headlines ?? [];

        // Benchmark cross-asset watchlist
        var benchmarkItems = new[]
        {
            new MarketWatchlistTopicInput("NZX 50 Index", "NZ50"),
            new MarketWatchlistTopicInput("Auckland Airport", "AIA"),
            new MarketWatchlistTopicInput("Meridian Energy", "MEL"),
            new MarketWatchlistTopicInput("Spark New Zealand", "SPK"),
            new MarketWatchlistTopicInput("Apple Inc.", "AAPL"),
            new MarketWatchlistTopicInput("Microsoft Corp.", "MSFT"),
            new MarketWatchlistTopicInput("NVIDIA Corp.", "NVDA"),
            new MarketWatchlistTopicInput("NZD / USD", "NZDUSD"),
            new MarketWatchlistTopicInput("Brent Crude Oil", "BRENT")
        };

        var queryItems = (request?.Items is { Length: > 0 } userItems ? userItems : benchmarkItems).Take(12).ToArray();

        var quotes = marketData.IsConfigured
            ? await marketData.GetWatchlistAsync(queryItems, queryItems.Length, cancellationToken, includeSparklines: false)
            : [];

        var quoteMap = quotes.ToDictionary(
            q => q.Symbol,
            q => q,
            StringComparer.OrdinalIgnoreCase);

        var assets = new List<MarketSentimentAsset>();
        foreach (var item in queryItems)
        {
            var symbol = item.Symbol?.Trim().ToUpperInvariant() ?? item.Topic.Trim().ToUpperInvariant();
            quoteMap.TryGetValue(symbol, out var q);

            var price = q?.Price ?? 100.0m;
            var change = q?.PercentChange ?? 0.0m;

            var sector = symbol switch
            {
                "NZ50" or "AIA" or "MEL" or "SPK" or "FPH" => "NZ Equities",
                "AAPL" or "MSFT" or "NVDA" or "GOOG" or "AMZN" => "Global Tech",
                "BRENT" or "XAU" or "WTI" => "Commodities",
                "NZDUSD" or "AUDUSD" or "EURUSD" => "FX & Rates",
                _ => "Core Equities"
            };

            var attributions = new List<MacroCorrelationStory>();
            foreach (var h in headlines.Take(10))
            {
                if (string.IsNullOrWhiteSpace(h)) continue;
                var lower = h.ToLowerInvariant();
                var isMatch = lower.Contains(item.Topic.ToLowerInvariant()) ||
                              lower.Contains(symbol.ToLowerInvariant()) ||
                              (sector == "NZ Equities" && (lower.Contains("nzx") || lower.Contains("rbnz") || lower.Contains("economy"))) ||
                              (sector == "Global Tech" && (lower.Contains("tech") || lower.Contains("ai") || lower.Contains("cloud"))) ||
                              (sector == "Commodities" && (lower.Contains("oil") || lower.Contains("energy") || lower.Contains("gold"))) ||
                              (sector == "FX & Rates" && (lower.Contains("dollar") || lower.Contains("rates") || lower.Contains("inflation")));

                if (isMatch)
                {
                    var impact = change > 0 ? "bullish" : (change < 0 ? "headwind" : "neutral");
                    attributions.Add(new MacroCorrelationStory(h, "", "Signal Wire", impact));
                    if (attributions.Count >= 2) break;
                }
            }

            var tone = change > 0.5m ? "bullish" : (change < -0.5m ? "bearish" : "neutral");
            assets.Add(new MarketSentimentAsset(
                symbol,
                item.Topic,
                sector,
                price,
                change,
                tone,
                attributions.ToArray()));
        }

        var upCount = assets.Count(a => a.ChangePercent > 0);
        var downCount = assets.Count(a => a.ChangePercent < 0);
        var macroHeadline = upCount > downCount
            ? "Risk-on sentiment led by strength across benchmark growth and equities."
            : (downCount > upCount ? "Defensive rotation with cautious positioning across risk assets." : "Mixed cross-asset consolidation with balanced sector flows.");

        return Ok(new MarketSentimentMatrixResponse(
            marketData.IsConfigured,
            assets.ToArray(),
            macroHeadline));
    }
}
