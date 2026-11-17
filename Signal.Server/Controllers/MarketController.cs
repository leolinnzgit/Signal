using System.Globalization;
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

    public sealed record StockNewsSeriesSummary(
        string Symbol,
        string Name,
        string Exchange,
        string Currency,
        string Topic,
        int ArticleCount,
        decimal LatestPrice,
        decimal LatestPercentChange);

    public sealed record StockNewsChartEvent(
        string Title,
        string Url,
        string Source,
        DateTime PublishedAtUtc,
        DateTime RecordedAtUtc,
        string Symbol,
        string Name,
        string Exchange,
        string Currency,
        decimal Price,
        decimal Change,
        decimal PercentChange,
        string QuoteTime,
        bool? IsMarketOpen,
        bool IsRecordedSnapshot,
        string[] Topics);

    public sealed record StockNewsPricePoint(
        string Timestamp,
        decimal Price,
        string SourceType);

    public sealed record StockNewsGraphResponse(
        bool Configured,
        string ActiveSymbol,
        string ActiveName,
        string ActiveExchange,
        string ActiveCurrency,
        string ActiveTopic,
        StockNewsSeriesSummary[] AvailableSeries,
        StockNewsPricePoint[] PricePoints,
        StockNewsChartEvent[] Events);

    [HttpGet("news-graph")]
    public async Task<IActionResult> GetNewsGraph(
        [FromQuery] string? topic = null,
        [FromQuery] string? symbol = null,
        [FromQuery] int days = 30,
        CancellationToken cancellationToken = default)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var boundedDays = Math.Clamp(days, 1, 365);
        var cutoff = DateTime.UtcNow.AddDays(-boundedDays);

        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        var followedTopics = DeserializeStringList(preferences?.TopicsJson);
        var tickerOverrides = MarketDataService.DeserializeTickerOverrides(preferences?.TickerOverridesJson);

        var quotedArticles = await database.StoredNewsArticles
            .AsNoTracking()
            .Where(item => item.UserId == userId
                && item.MarketQuotesJson != "[]"
                && item.PublishedAtUtc >= cutoff)
            .OrderByDescending(item => item.PublishedAtUtc)
            .Take(5000)
            .Select(item => new StoredGraphArticleProjection(
                item.Title,
                item.Url,
                item.Source,
                item.PublishedAtUtc,
                DeserializeStringList(item.TopicsJson),
                MarketDataService.DeserializeMarketQuotes(item.MarketQuotesJson)))
            .ToArrayAsync(cancellationToken);

        var seriesMap = BuildRecordedSeriesMap(quotedArticles);

        // Include followed stock topics / overrides even before any snapshots have been stamped.
        var missingFollowed = followedTopics
            .Where(t => tickerOverrides.ContainsKey(t) || marketData.IsKnownOrCachedStockTopic(t))
            .Where(t => !seriesMap.Values.Any(s => string.Equals(s.Topic, t, StringComparison.OrdinalIgnoreCase)))
            .ToArray();
        if (marketData.IsConfigured && missingFollowed.Length > 0)
        {
            var resolvedFollowed = await marketData.ResolveQuotesForTopicsAsync(
                missingFollowed,
                tickerOverrides,
                DateTime.UtcNow,
                cancellationToken);
            foreach (var q in resolvedFollowed.Values)
            {
                var symKey = q.Symbol.Trim().ToUpperInvariant();
                if (symKey.Length > 0 && !seriesMap.ContainsKey(symKey))
                {
                    seriesMap[symKey] = new StockNewsSeriesSummary(
                        symKey,
                        q.Name,
                        q.Exchange,
                        q.Currency,
                        q.Topic,
                        0,
                        q.Price,
                        q.PercentChange);
                }
            }
        }

        var requestedTopic = (topic ?? "").Trim();
        var requestedRawSymbol = (symbol ?? "").Trim();
        MarketTickerParser.TryParse(requestedRawSymbol, out var parsedTicker);
        var requestedSymbol = parsedTicker?.Symbol ?? requestedRawSymbol.ToUpperInvariant();
        var requestedQualified = parsedTicker?.QualifiedSymbol ?? (requestedRawSymbol.Length > 0 ? requestedRawSymbol.ToUpperInvariant() : "");

        var availableSeries = seriesMap.Values
            .OrderByDescending(s => s.ArticleCount)
            .ThenBy(s => s.Symbol, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (requestedTopic.Length == 0 && requestedSymbol.Length == 0)
        {
            if (availableSeries.Length > 0)
            {
                requestedSymbol = availableSeries[0].Symbol;
                requestedTopic = availableSeries[0].Topic;
            }
            else if (missingFollowed.Length > 0)
            {
                requestedTopic = missingFollowed[0];
            }
        }

        if (requestedTopic.Length == 0 && requestedSymbol.Length > 0 && seriesMap.TryGetValue(requestedSymbol, out var matchedBySym))
        {
            requestedTopic = matchedBySym.Topic;
        }

        if (requestedSymbol.Length == 0 && requestedTopic.Length > 0)
        {
            var matchedByTopic = availableSeries.FirstOrDefault(s =>
                string.Equals(s.Topic, requestedTopic, StringComparison.OrdinalIgnoreCase));
            if (matchedByTopic is not null)
                requestedSymbol = matchedByTopic.Symbol;
        }

        if (requestedQualified.Length == 0 && requestedTopic.Length > 0 && tickerOverrides.TryGetValue(requestedTopic, out var overrideVal))
            requestedQualified = overrideVal;
        else if (requestedQualified.Length == 0 && requestedSymbol.Length > 0)
        {
            requestedQualified = seriesMap.TryGetValue(requestedSymbol, out var existingSeries) && existingSeries.Exchange.Length > 0
                ? $"{existingSeries.Symbol}:{existingSeries.Exchange}"
                : requestedSymbol;
        }

        MarketQuote? liveQuote = null;
        HistoricalPriceBar[] historicalBars = [];
        if (marketData.IsConfigured && (requestedTopic.Length > 0 || requestedQualified.Length > 0))
        {
            var lookupTopic = requestedTopic.Length > 0 ? requestedTopic : requestedSymbol;
            var lookupSymbol = requestedQualified.Length > 0 ? requestedQualified : null;
            try
            {
                liveQuote = await marketData.GetForTopicAsync(lookupTopic, lookupSymbol, cancellationToken, includeSparkline: false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Keep serving stored snapshots even if live quote lookup fails.
            }

            historicalBars = await marketData.GetHistoricalBarsAsync(
                lookupTopic,
                lookupSymbol,
                Math.Clamp(boundedDays + 10, 14, 365),
                cancellationToken);
        }

        seriesMap.TryGetValue(
            (liveQuote?.Symbol ?? requestedSymbol).Trim().ToUpperInvariant(),
            out var summary);

        var activeSymbol = (liveQuote?.Symbol ?? summary?.Symbol ?? requestedSymbol).Trim().ToUpperInvariant();
        var activeName = liveQuote?.Name ?? summary?.Name ?? (requestedTopic.Length > 0 ? requestedTopic : activeSymbol);
        var activeExchange = liveQuote?.Exchange ?? summary?.Exchange ?? parsedTicker?.Exchange ?? "";
        var activeCurrency = liveQuote?.Currency ?? summary?.Currency ?? "";
        var activeTopic = requestedTopic.Length > 0 ? requestedTopic : (summary?.Topic ?? activeName);

        var symbolQuotePattern = activeSymbol.Length > 0 ? $"%\"{activeSymbol}\"%" : "";
        var topicPattern = activeTopic.Length > 0 ? $"%{activeTopic}%" : "";
        var cleanName = CleanSeriesDisplayName(activeName);
        var namePattern = cleanName.Length >= 3 ? $"%{cleanName}%" : "";
        var symbolTitlePattern = activeSymbol.Length >= 2 ? $"%{activeSymbol}%" : "";

        var matchingArticles = (activeSymbol.Length == 0 && activeTopic.Length == 0)
            ? []
            : await database.StoredNewsArticles
                .AsNoTracking()
                .Where(item => item.UserId == userId && item.PublishedAtUtc >= cutoff && (
                    (symbolQuotePattern.Length > 0 && EF.Functions.Like(item.MarketQuotesJson, symbolQuotePattern))
                    || (topicPattern.Length > 0 && (EF.Functions.Like(item.TopicsJson, topicPattern) || EF.Functions.Like(item.Title, topicPattern)))
                    || (namePattern.Length > 0 && (EF.Functions.Like(item.TopicsJson, namePattern) || EF.Functions.Like(item.Title, namePattern)))
                    || (symbolTitlePattern.Length > 0 && EF.Functions.Like(item.Title, symbolTitlePattern))))
                .OrderByDescending(item => item.PublishedAtUtc)
                .Take(600)
                .Select(item => new StoredGraphArticleProjection(
                    item.Title,
                    item.Url,
                    item.Source,
                    item.PublishedAtUtc,
                    DeserializeStringList(item.TopicsJson),
                    MarketDataService.DeserializeMarketQuotes(item.MarketQuotesJson)))
                .ToArrayAsync(cancellationToken);

        var parsedDated = historicalBars
            .Select(bar => (Point: new MarketPricePoint(bar.Utc.ToString("O", CultureInfo.InvariantCulture), bar.Close), Utc: bar.Utc))
            .Where(item => item.Point.Price > 0)
            .OrderBy(item => item.Utc)
            .ToArray();

        var events = new List<StockNewsChartEvent>();
        foreach (var article in matchingArticles.OrderBy(item => item.PublishedAtUtc))
        {
            var recorded = article.MarketQuotes.FirstOrDefault(q =>
                activeSymbol.Length > 0 && string.Equals(q.Symbol, activeSymbol, StringComparison.OrdinalIgnoreCase));

            if (recorded is not null && recorded.Price > 0)
            {
                var publishedUtc = DateTime.SpecifyKind(article.PublishedAtUtc, DateTimeKind.Utc);
                var recordedUtc = DateTime.SpecifyKind(recorded.RecordedAtUtc, DateTimeKind.Utc);
                var effective = (historicalBars.Length > 0 && recordedUtc > publishedUtc.AddHours(6))
                    ? (MarketDataService.FindHistoricalQuoteAt(
                        publishedUtc,
                        liveQuote,
                        historicalBars,
                        recorded.Topic.Length > 0 ? recorded.Topic : activeTopic,
                        recorded.Symbol,
                        recorded.Name.Length > 0 ? recorded.Name : activeName,
                        recorded.Exchange.Length > 0 ? recorded.Exchange : activeExchange,
                        recorded.Currency.Length > 0 ? recorded.Currency : activeCurrency) ?? recorded)
                    : recorded;

                events.Add(new StockNewsChartEvent(
                    article.Title,
                    article.Url,
                    article.Source,
                    publishedUtc,
                    DateTime.SpecifyKind(effective.RecordedAtUtc, DateTimeKind.Utc),
                    effective.Symbol,
                    effective.Name.Length > 0 ? effective.Name : activeName,
                    effective.Exchange.Length > 0 ? effective.Exchange : activeExchange,
                    effective.Currency.Length > 0 ? effective.Currency : activeCurrency,
                    effective.Price,
                    effective.Change,
                    effective.PercentChange,
                    effective.QuoteTime,
                    effective.IsMarketOpen,
                    IsRecordedSnapshot: true,
                    article.Topics));
                continue;
            }

            if (!ArticleMatchesStock(article, activeTopic, activeSymbol, activeName))
                continue;

            var alignedQuote = MarketDataService.FindHistoricalQuoteAt(
                article.PublishedAtUtc,
                liveQuote,
                historicalBars,
                activeTopic,
                activeSymbol,
                activeName,
                activeExchange,
                activeCurrency);
            var alignedPrice = alignedQuote?.Price ?? AlignPriceToTimestamp(article.PublishedAtUtc, parsedDated, liveQuote?.Price ?? 0m);
            if (alignedPrice <= 0) continue;

            events.Add(new StockNewsChartEvent(
                article.Title,
                article.Url,
                article.Source,
                DateTime.SpecifyKind(article.PublishedAtUtc, DateTimeKind.Utc),
                DateTime.SpecifyKind(article.PublishedAtUtc, DateTimeKind.Utc),
                activeSymbol,
                activeName,
                activeExchange,
                activeCurrency,
                alignedPrice,
                alignedQuote?.Change ?? 0m,
                alignedQuote?.PercentChange ?? 0m,
                alignedQuote?.QuoteTime ?? "",
                alignedQuote?.IsMarketOpen,
                IsRecordedSnapshot: false,
                article.Topics));
        }

        var pricePoints = new List<(DateTimeOffset Utc, int Priority, StockNewsPricePoint Point)>();
        foreach (var item in parsedDated)
        {
            if (item.Utc >= cutoff.AddDays(-1))
                pricePoints.Add((item.Utc, 0, new StockNewsPricePoint(item.Point.Timestamp, item.Point.Price, "historical-close")));
        }
        foreach (var ev in events)
        {
            var utc = new DateTimeOffset(DateTime.SpecifyKind(ev.PublishedAtUtc, DateTimeKind.Utc));
            pricePoints.Add((
                utc,
                1,
                new StockNewsPricePoint(utc.ToString("O", CultureInfo.InvariantCulture), ev.Price, ev.IsRecordedSnapshot ? "news-snapshot" : "news-aligned")));
        }

        var orderedPoints = pricePoints
            .OrderBy(item => item.Utc)
            .ThenBy(item => item.Priority)
            .Select(item => item.Point)
            .ToArray();

        return Ok(new StockNewsGraphResponse(
            marketData.IsConfigured,
            activeSymbol,
            activeName,
            activeExchange,
            activeCurrency,
            activeTopic,
            availableSeries,
            orderedPoints,
            events.ToArray()));
    }

    private sealed record StoredGraphArticleProjection(
        string Title,
        string Url,
        string Source,
        DateTime PublishedAtUtc,
        string[] Topics,
        ArticleMarketQuote[] MarketQuotes);

    private static Dictionary<string, StockNewsSeriesSummary> BuildRecordedSeriesMap(
        IEnumerable<StoredGraphArticleProjection> articles)
    {
        var grouped = new Dictionary<string, (ArticleMarketQuote LatestQuote, DateTime LatestTime, int Count)>(
            StringComparer.OrdinalIgnoreCase);

        foreach (var article in articles)
        {
            var seenInArticle = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var quote in article.MarketQuotes)
            {
                if (string.IsNullOrWhiteSpace(quote.Symbol) || quote.Price <= 0) continue;
                var symbol = quote.Symbol.Trim().ToUpperInvariant();
                if (!seenInArticle.Add(symbol)) continue;

                var timestamp = quote.RecordedAtUtc > article.PublishedAtUtc
                    ? quote.RecordedAtUtc
                    : article.PublishedAtUtc;

                if (!grouped.TryGetValue(symbol, out var entry))
                {
                    grouped[symbol] = (quote, timestamp, 1);
                }
                else
                {
                    var latestQuote = timestamp >= entry.LatestTime ? quote : entry.LatestQuote;
                    var latestTime = timestamp >= entry.LatestTime ? timestamp : entry.LatestTime;
                    grouped[symbol] = (latestQuote, latestTime, entry.Count + 1);
                }
            }
        }

        var result = new Dictionary<string, StockNewsSeriesSummary>(StringComparer.OrdinalIgnoreCase);
        foreach (var (symbol, value) in grouped)
        {
            result[symbol] = new StockNewsSeriesSummary(
                symbol,
                value.LatestQuote.Name,
                value.LatestQuote.Exchange,
                value.LatestQuote.Currency,
                value.LatestQuote.Topic,
                value.Count,
                value.LatestQuote.Price,
                value.LatestQuote.PercentChange);
        }
        return result;
    }

    private static bool ArticleMatchesStock(
        StoredGraphArticleProjection article,
        string activeTopic,
        string activeSymbol,
        string activeName)
    {
        if (activeTopic.Length > 0 && article.Topics.Any(t => string.Equals(t, activeTopic, StringComparison.OrdinalIgnoreCase)))
            return true;
        if (activeTopic.Length >= 2 && TopicMatcher.Matches(article.Title, activeTopic))
            return true;
        if (activeSymbol.Length >= 2 && TopicMatcher.Matches(article.Title, activeSymbol))
            return true;
        if (activeName.Length >= 3 && !string.Equals(activeName, activeSymbol, StringComparison.OrdinalIgnoreCase)
            && TopicMatcher.Matches(article.Title, activeName))
            return true;
        return false;
    }

    private static decimal AlignPriceToTimestamp(
        DateTime publishedAtUtc,
        (MarketPricePoint Point, DateTimeOffset Utc)[] parsedDated,
        decimal fallbackPrice)
    {
        if (parsedDated.Length == 0) return fallbackPrice;
        var target = new DateTimeOffset(DateTime.SpecifyKind(publishedAtUtc, DateTimeKind.Utc));
        MarketPricePoint? onOrBefore = null;
        foreach (var item in parsedDated)
        {
            if (item.Utc <= target) onOrBefore = item.Point;
            else break;
        }
        return onOrBefore?.Price ?? parsedDated[0].Point.Price;
    }

    private static DateTimeOffset ParseChartTimestampUtc(string value)
    {
        if (DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var parsed))
            return parsed;
        return DateTimeOffset.MinValue;
    }

    private static string CleanSeriesDisplayName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "";
        var suffixes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "inc", "inc.", "corp", "corp.", "corporation", "ltd", "ltd.", "limited", "plc", "co", "co.",
            "company", "holdings", "group", "class", "a", "b", "common", "stock", "etf", "trust", "adr",
        };
        var parts = name
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Where(w => !suffixes.Contains(w.TrimEnd(',', '.')))
            .ToArray();
        return string.Join(' ', parts).Trim();
    }

    private static string[] DeserializeStringList(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }
}
