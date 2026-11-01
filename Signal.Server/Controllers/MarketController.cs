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
    public MarketController(MarketDataService marketData, ILogger<MarketController> logger)
        : this(marketData, null!, null!, logger)
    {
    }

    public sealed record MarketWatchlistRequest(MarketWatchlistTopicInput[]? Items, int MaxQuotes = 5, bool IncludeSparklines = false);
    public sealed record MarketWatchlistResponse(bool Configured, MarketQuote[] Quotes);

    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string topic,
        [FromQuery] string? symbol,
        CancellationToken cancellationToken,
        [FromQuery] bool sparkline = false)
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
}
