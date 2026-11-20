using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class MarketDataOptions
{
    public const string SectionName = "MarketData";
    public string ApiKey { get; set; } = "";
}

public sealed class MarketDataNotConfiguredException : Exception
{
    public MarketDataNotConfiguredException() : base("Market pricing is not configured.")
    {
    }
}

public sealed class MarketDataPlanRequiredException(string message, Exception? innerException = null)
    : Exception(message, innerException)
{
}

public sealed record MarketQuote(
    string Topic,
    string Symbol,
    string Name,
    string Exchange,
    string Currency,
    decimal Price,
    decimal Change,
    decimal PercentChange,
    string QuoteTime,
    bool? IsMarketOpen,
    string Provider,
    decimal[]? Sparkline = null,
    decimal? ExtendedPrice = null,
    decimal? ExtendedChange = null,
    decimal? ExtendedPercentChange = null,
    string? ExtendedQuoteTime = null,
    string? ExtendedSession = null);

public sealed record MarketWatchlistTopicInput(string Topic, string? Symbol = null);

public sealed record MarketPricePoint(string Timestamp, decimal Price);

public sealed record HistoricalPriceBar(
    DateTimeOffset Utc,
    string QuoteTime,
    decimal Open,
    decimal Close,
    decimal Change,
    decimal PercentChange);

public sealed class MarketDataService(
    HttpClient httpClient,
    IMemoryCache cache,
    IOptions<MarketDataOptions> options)
{
    private static readonly IReadOnlyDictionary<string, string> KnownSymbols =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Adobe"] = "ADBE",
            ["Alibaba"] = "BABA",
            ["Alphabet"] = "GOOGL",
            ["AMD"] = "AMD",
            ["Amazon"] = "AMZN",
            ["Apple"] = "AAPL",
            ["Arm"] = "ARM",
            ["Broadcom"] = "AVGO",
            ["Coinbase"] = "COIN",
            ["Dow Jones"] = "DIA",
            ["Google"] = "GOOGL",
            ["IBM"] = "IBM",
            ["Intel"] = "INTC",
            ["Meta"] = "META",
            ["Microsoft"] = "MSFT",
            ["Nasdaq"] = "QQQ",
            ["Netflix"] = "NFLX",
            ["NVIDIA"] = "NVDA",
            ["Oracle"] = "ORCL",
            ["Palantir"] = "PLTR",
            ["S&P 500"] = "SPY",
            ["SP500"] = "SPY",
            ["Salesforce"] = "CRM",
            ["SpaceX"] = "SPCX",
            ["Space X"] = "SPCX",
            ["Starbucks"] = "SBUX",
            ["Taiwan Semiconductor"] = "TSM",
            ["Tesla"] = "TSLA",
            ["TSMC"] = "TSM",
        };

    private static readonly IReadOnlyDictionary<string, string> KnownNzxSymbols =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Air New Zealand"] = "AIR",
            ["Auckland Airport"] = "AIA",
            ["Auckland International Airport"] = "AIA",
            ["Contact Energy"] = "CEN",
            ["Fisher & Paykel Healthcare"] = "FPH",
            ["Fletcher Building"] = "FBU",
            ["Infratil"] = "IFT",
            ["Mainfreight"] = "MFT",
            ["Mercury NZ"] = "MCY",
            ["Meridian Energy"] = "MEL",
            ["Spark New Zealand"] = "SPK",
            ["The a2 Milk Company"] = "ATM",
            ["The Warehouse Group"] = "WHS",
        };

    private static readonly HashSet<string> SupportedInstrumentTypes =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "American Depositary Receipt",
            "Common Stock",
            "Depositary Receipt",
            "ETF",
            "Global Depositary Receipt",
            "REIT",
        };

    public bool IsConfigured => !string.IsNullOrWhiteSpace(options.Value.ApiKey);

    public async Task<MarketQuote?> GetForTopicAsync(
        string requestedTopic,
        string? tickerOverride,
        CancellationToken cancellationToken,
        bool includeSparkline = false)
    {
        var topic = NormalizeDisplayText(requestedTopic, 80);
        if (topic.Length == 0) throw new ArgumentException("Choose a topic.");
        if (!IsConfigured) throw new MarketDataNotConfiguredException();

        var normalizedOverride = MarketTickerParser.ParseOptional(tickerOverride);
        var match = normalizedOverride is null
            ? await FindMatchAsync(topic, cancellationToken)
            : new StockMatch(normalizedOverride.Symbol, "", normalizedOverride.Exchange);
        if (match is null) return null;

        var quoteCacheKey = $"market-quote:{match.Symbol}:{match.Exchange}".ToLowerInvariant();
        var restrictionCacheKey = quoteCacheKey + ":plan-required";
        if (cache.TryGetValue(restrictionCacheKey, out MarketDataPlanRequiredException? restriction) && restriction is not null)
            throw restriction;
        if (cache.TryGetValue(quoteCacheKey, out MarketQuote? cachedQuote) && cachedQuote is not null)
        {
            var resolved = cachedQuote with { Topic = topic };
            if (includeSparkline && resolved.Sparkline is null)
            {
                var spark = await TryGetSparklineAsync(match, cancellationToken);
                if (spark is not null)
                {
                    resolved = resolved with { Sparkline = spark };
                    cache.Set(quoteCacheKey, resolved, TimeSpan.FromMinutes(10));
                }
            }
            return resolved;
        }

        MarketQuote quote;
        try
        {
            quote = await RequestQuoteAsync(topic, match, cancellationToken);
        }
        catch (InvalidOperationException exception) when (IsPlanRestriction(exception))
        {
            var qualifiedSymbol = match.Exchange.Length > 0
                ? $"{match.Symbol}:{match.Exchange}"
                : match.Symbol;
            var planRequired = new MarketDataPlanRequiredException(
                match.Exchange.Equals("NZX", StringComparison.OrdinalIgnoreCase)
                    ? $"{qualifiedSymbol} is a valid NZX ticker, but NZX prices are not included in the configured Twelve Data plan."
                    : $"{qualifiedSymbol} is not available on the configured Twelve Data plan.",
                exception);
            cache.Set(restrictionCacheKey, planRequired, TimeSpan.FromMinutes(30));
            throw planRequired;
        }
        catch (InvalidOperationException exception) when (normalizedOverride is not null)
        {
            throw new ArgumentException("That ticker could not be verified.", exception);
        }
        if (includeSparkline)
        {
            var spark = await TryGetSparklineAsync(match, cancellationToken);
            if (spark is not null)
                quote = quote with { Sparkline = spark };
        }
        cache.Set(quoteCacheKey, quote, TimeSpan.FromMinutes(10));
        return quote;
    }

    public async Task<MarketQuote[]> GetWatchlistAsync(
        IReadOnlyList<MarketWatchlistTopicInput>? items,
        int maxQuotes,
        CancellationToken cancellationToken,
        bool includeSparklines = false)
    {
        if (!IsConfigured || items is null || items.Count == 0)
            return [];

        var boundedMax = Math.Clamp(maxQuotes, 1, 8);
        var seenTopics = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var fastCandidates = new List<(string Topic, string? Override)>();
        var discoveryCandidates = new List<(string Topic, string? Override)>();

        foreach (var raw in items.Take(24))
        {
            if (raw is null) continue;
            var topic = NormalizeDisplayText(raw.Topic, 80);
            if (topic.Length == 0 || !seenTopics.Add(topic)) continue;

            var overrideSymbol = string.IsNullOrWhiteSpace(raw.Symbol) ? null : raw.Symbol.Trim();
            if (overrideSymbol is not null)
            {
                fastCandidates.Add((topic, overrideSymbol));
            }
            else if (HasFastSymbolMatch(topic, out var knownOrCached))
            {
                if (knownOrCached)
                    fastCandidates.Add((topic, null));
            }
            else
            {
                discoveryCandidates.Add((topic, null));
            }
        }

        // Prioritize explicit overrides and known/cached symbols; allow up to 2 discovery lookups per watchlist refresh
        var ordered = fastCandidates.Concat(discoveryCandidates.Take(2)).ToArray();
        var results = new List<MarketQuote>(boundedMax);
        var seenSymbols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (topic, overrideSymbol) in ordered)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (results.Count >= boundedMax) break;

            try
            {
                var quote = await GetForTopicAsync(topic, overrideSymbol, cancellationToken);
                if (quote is null) continue;
                var symbolKey = $"{quote.Symbol}:{quote.Exchange}";
                if (seenSymbols.Add(symbolKey))
                    results.Add(quote);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Skip restricted, invalid, or transiently unavailable single symbols in watchlist mode
            }
        }

        var sorted = results
            .OrderByDescending(q => Math.Abs(q.PercentChange))
            .ThenBy(q => q.Symbol, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (!includeSparklines || sorted.Length == 0)
            return sorted;

        var uncachedFetches = 0;
        for (var i = 0; i < sorted.Length; i++)
        {
            var item = sorted[i];
            if (item.Sparkline is not null) continue;
            var sparkCacheKey = $"market-sparkline:{item.Symbol}:{item.Exchange}".ToLowerInvariant();
            if (cache.TryGetValue(sparkCacheKey, out decimal[]? cachedSpark))
            {
                if (cachedSpark is { Length: >= 2 })
                    sorted[i] = item with { Sparkline = cachedSpark };
                continue;
            }
            if (uncachedFetches >= 3) continue;
            uncachedFetches++;
            var fetchedSpark = await TryGetSparklineAsync(new StockMatch(item.Symbol, item.Name, item.Exchange), cancellationToken);
            if (fetchedSpark is { Length: >= 2 })
                sorted[i] = item with { Sparkline = fetchedSpark };
        }

        return sorted;
    }

    public static string[] ExtractKnownTopicsFromText(string? title, IEnumerable<string>? topics = null)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (topics is not null)
        {
            foreach (var raw in topics)
            {
                var cleaned = NormalizeDisplayText(raw, 80);
                if (cleaned.Length > 0 && seen.Add(cleaned))
                    result.Add(cleaned);
            }
        }

        if (!string.IsNullOrWhiteSpace(title))
        {
            foreach (var company in KnownSymbols.Keys.Concat(KnownNzxSymbols.Keys))
            {
                if (seen.Contains(company)) continue;
                if (TopicMatcher.Matches(title, company) && seen.Add(company))
                    result.Add(company);
            }
        }

        return result.ToArray();
    }

    public static ArticleMarketQuote ToArticleMarketQuote(MarketQuote quote, DateTime recordedAtUtc) =>
        new(
            NormalizeDisplayText(quote.Topic, 80),
            quote.Symbol.Trim().ToUpperInvariant(),
            NormalizeDisplayText(quote.Name, 160),
            quote.Exchange.Trim().ToUpperInvariant(),
            quote.Currency.Trim().ToUpperInvariant(),
            quote.Price,
            quote.Change,
            quote.PercentChange,
            NormalizeDisplayText(quote.QuoteTime, 64),
            quote.IsMarketOpen,
            recordedAtUtc,
            quote.ExtendedPrice is > 0 ? quote.ExtendedPrice : null,
            quote.ExtendedPrice is > 0 ? quote.ExtendedChange : null,
            quote.ExtendedPrice is > 0 ? quote.ExtendedPercentChange : null,
            quote.ExtendedPrice is > 0 && !string.IsNullOrWhiteSpace(quote.ExtendedQuoteTime)
                ? NormalizeDisplayText(quote.ExtendedQuoteTime, 64)
                : null,
            quote.ExtendedPrice is > 0 && !string.IsNullOrWhiteSpace(quote.ExtendedSession)
                ? NormalizeDisplayText(quote.ExtendedSession, 24)
                : null);

    public static ArticleMarketQuote[] DeserializeMarketQuotes(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            var items = JsonSerializer.Deserialize<ArticleMarketQuote[]>(json);
            if (items is null || items.Length == 0) return [];
            return items
                .Where(item => item is not null && !string.IsNullOrWhiteSpace(item.Symbol) && item.Price > 0)
                .ToArray();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static ArticleMarketQuote[] MergeMarketQuotes(
        string? existingJson,
        IEnumerable<ArticleMarketQuote>? additions)
    {
        var existing = DeserializeMarketQuotes(existingJson);
        if (additions is null) return existing;

        var merged = new List<ArticleMarketQuote>(Math.Min(6, existing.Length + 4));

        foreach (var item in existing)
        {
            if (merged.Count >= 6) break;
            if (!merged.Any(m => IsSameStockQuote(m, item)))
                merged.Add(item);
        }

        foreach (var raw in additions)
        {
            if (merged.Count >= 6) break;
            if (raw is null || string.IsNullOrWhiteSpace(raw.Symbol) || raw.Price <= 0) continue;
            var hasExtended = raw.ExtendedPrice is > 0;
            var normalized = raw with
            {
                Topic = NormalizeDisplayText(raw.Topic, 80),
                Symbol = raw.Symbol.Trim().ToUpperInvariant(),
                Name = NormalizeDisplayText(raw.Name, 160),
                Exchange = (raw.Exchange ?? "").Trim().ToUpperInvariant(),
                Currency = (raw.Currency ?? "").Trim().ToUpperInvariant(),
                QuoteTime = NormalizeDisplayText(raw.QuoteTime, 64),
                RecordedAtUtc = raw.RecordedAtUtc == default ? DateTime.UtcNow : raw.RecordedAtUtc,
                ExtendedPrice = hasExtended ? raw.ExtendedPrice : null,
                ExtendedChange = hasExtended ? raw.ExtendedChange : null,
                ExtendedPercentChange = hasExtended ? raw.ExtendedPercentChange : null,
                ExtendedQuoteTime = hasExtended && !string.IsNullOrWhiteSpace(raw.ExtendedQuoteTime)
                    ? NormalizeDisplayText(raw.ExtendedQuoteTime, 64)
                    : null,
                ExtendedSession = hasExtended && !string.IsNullOrWhiteSpace(raw.ExtendedSession)
                    ? NormalizeDisplayText(raw.ExtendedSession, 24)
                    : null,
            };
            if (!merged.Any(m => IsSameStockQuote(m, normalized)))
                merged.Add(normalized);
        }

        return merged.ToArray();
    }

    private static bool IsSameStockQuote(ArticleMarketQuote left, ArticleMarketQuote right)
    {
        if (!string.Equals(left.Symbol, right.Symbol, StringComparison.OrdinalIgnoreCase))
            return false;
        if (string.IsNullOrWhiteSpace(left.Exchange) || string.IsNullOrWhiteSpace(right.Exchange))
            return true;
        return string.Equals(left.Exchange, right.Exchange, StringComparison.OrdinalIgnoreCase);
    }

    public bool IsKnownOrCachedStockTopic(string topic)
    {
        var normalized = NormalizeDisplayText(topic, 80);
        return normalized.Length > 0 && HasFastSymbolMatch(normalized, out var matched) && matched;
    }

    public async Task<Dictionary<string, ArticleMarketQuote>> ResolveQuotesForTopicsAsync(
        IReadOnlyCollection<string> candidateTopics,
        IReadOnlyDictionary<string, string>? tickerOverrides,
        DateTime recordedAtUtc,
        CancellationToken cancellationToken)
    {
        var resolved = new Dictionary<string, ArticleMarketQuote>(StringComparer.OrdinalIgnoreCase);
        if (!IsConfigured || candidateTopics is null || candidateTopics.Count == 0)
            return resolved;

        var seenTopics = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var fastCandidates = new List<(string Topic, string? Override)>();
        var discoveryCandidates = new List<(string Topic, string? Override)>();

        foreach (var raw in candidateTopics)
        {
            var topic = NormalizeDisplayText(raw, 80);
            if (topic.Length == 0 || !seenTopics.Add(topic)) continue;

            string? overrideSymbol = null;
            if (tickerOverrides is not null)
            {
                foreach (var pair in tickerOverrides)
                {
                    if (string.Equals(pair.Key, topic, StringComparison.OrdinalIgnoreCase)
                        && !string.IsNullOrWhiteSpace(pair.Value))
                    {
                        overrideSymbol = pair.Value.Trim();
                        break;
                    }
                }
            }

            if (overrideSymbol is not null)
            {
                fastCandidates.Add((topic, overrideSymbol));
            }
            else if (HasFastSymbolMatch(topic, out var knownOrCached))
            {
                if (knownOrCached)
                    fastCandidates.Add((topic, null));
            }
            else
            {
                discoveryCandidates.Add((topic, null));
            }
        }

        var ordered = fastCandidates.Concat(discoveryCandidates.Take(2)).Take(8);
        foreach (var (topic, overrideSymbol) in ordered)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var missCacheKey = ArticleTopicMissCacheKey(topic, overrideSymbol);
            if (cache.TryGetValue(missCacheKey, out _)) continue;
            try
            {
                var quote = await GetForTopicAsync(topic, overrideSymbol, cancellationToken, includeSparkline: false);
                if (quote is not null && quote.Price > 0)
                    resolved[topic] = ToArticleMarketQuote(quote, recordedAtUtc);
                else
                    cache.Set(missCacheKey, true, TimeSpan.FromMinutes(15));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Best-effort quote snapshot enrichment should not fail article ingestion.
                cache.Set(missCacheKey, true, TimeSpan.FromMinutes(15));
            }
        }

        return resolved;
    }

    public static Dictionary<string, string> DeserializeTickerOverrides(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            if (parsed is null || parsed.Count == 0)
                return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var normalized = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in parsed)
            {
                if (!string.IsNullOrWhiteSpace(pair.Key) && !string.IsNullOrWhiteSpace(pair.Value))
                    normalized[pair.Key.Trim()] = pair.Value.Trim();
            }
            return normalized;
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
    }

    public static string[] CollectCandidateTopics(
        string? title,
        IEnumerable<string>? topics,
        IReadOnlyDictionary<string, string>? tickerOverrides = null)
    {
        var baseTopics = ExtractKnownTopicsFromText(title, topics);
        if (tickerOverrides is null || tickerOverrides.Count == 0 || string.IsNullOrWhiteSpace(title))
            return baseTopics;

        var seen = new HashSet<string>(baseTopics, StringComparer.OrdinalIgnoreCase);
        var combined = new List<string>(baseTopics);
        foreach (var pair in tickerOverrides)
        {
            if (seen.Contains(pair.Key)) continue;
            if (TopicMatcher.Matches(title, pair.Key) && seen.Add(pair.Key))
                combined.Add(pair.Key);
        }
        return combined.ToArray();
    }

    public static ArticleMarketQuote[] MatchResolvedQuotes(
        IEnumerable<string> candidateTopics,
        IReadOnlyDictionary<string, ArticleMarketQuote> resolvedByTopic,
        IEnumerable<ArticleMarketQuote>? explicitQuotes = null)
    {
        var list = new List<ArticleMarketQuote>();
        if (explicitQuotes is not null)
            list.AddRange(explicitQuotes);

        if (resolvedByTopic is { Count: > 0 })
        {
            foreach (var topic in candidateTopics)
            {
                if (resolvedByTopic.TryGetValue(topic, out var quote))
                    list.Add(quote);
            }
        }

        return list.ToArray();
    }

    public async Task<MarketPricePoint[]> GetDatedSeriesAsync(
        string requestedTopic,
        string? tickerOverride,
        int outputSize,
        CancellationToken cancellationToken)
    {
        var bars = await GetHistoricalBarsAsync(requestedTopic, tickerOverride, outputSize, cancellationToken);
        return bars
            .Select(bar => new MarketPricePoint(bar.Utc.ToString("O", CultureInfo.InvariantCulture), bar.Close))
            .ToArray();
    }

    public async Task<HistoricalPriceBar[]> GetHistoricalBarsAsync(
        string requestedTopic,
        string? tickerOverride,
        int days,
        CancellationToken cancellationToken)
    {
        if (!IsConfigured) return [];
        var boundedDays = Math.Clamp(days, 2, 365);

        StockMatch? match = null;
        if (!string.IsNullOrWhiteSpace(tickerOverride) && MarketTickerParser.TryParse(tickerOverride, out var parsedOverride) && parsedOverride is not null)
        {
            match = new StockMatch(parsedOverride.Symbol, "", parsedOverride.Exchange);
        }
        else
        {
            var topic = NormalizeDisplayText(requestedTopic, 80);
            if (topic.Length == 0) return [];
            try
            {
                match = await FindMatchAsync(topic, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                return [];
            }
        }

        if (match is null) return [];

        var cacheKey = $"market-hist-bars:{match.Symbol}:{match.Exchange}:{boundedDays}".ToLowerInvariant();
        if (cache.TryGetValue(cacheKey, out HistoricalPriceBar[]? cached) && cached is not null)
            return cached;

        try
        {
            var dailySize = Math.Clamp(boundedDays + 10, 30, 365);
            var dailyRows = await FetchTimeSeriesBarsAsync(match, "1day", dailySize, isHourly: false, cancellationToken);

            var dailyBars = new List<HistoricalPriceBar>(dailyRows.Count);
            var dailyClosesByDate = new SortedDictionary<DateOnly, decimal>();
            decimal? prevClose = null;
            foreach (var row in dailyRows)
            {
                var baseline = prevClose ?? (row.Open > 0 ? row.Open : row.Close);
                var change = Math.Round(row.Close - baseline, 4);
                var pct = baseline > 0 ? Math.Round(change / baseline * 100m, 2) : 0m;
                dailyBars.Add(new HistoricalPriceBar(row.Utc, row.QuoteTime, row.Open, row.Close, change, pct));
                dailyClosesByDate[row.Date] = row.Close;
                prevClose = row.Close;
            }

            List<HistoricalPriceBar> combined;
            if (boundedDays <= 45)
            {
                var hourlyRows = await FetchTimeSeriesBarsAsync(match, "1h", 250, isHourly: true, cancellationToken);
                var trueHourlyRows = hourlyRows.Where(r => r.HasTimeOfDay).ToList();
                if (trueHourlyRows.Count >= 2)
                {
                    var earliestHourlyDate = trueHourlyRows[0].Date;
                    combined = new List<HistoricalPriceBar>(dailyBars.Count + trueHourlyRows.Count);
                    foreach (var daily in dailyBars)
                    {
                        var barDate = DateOnly.FromDateTime(daily.Utc.UtcDateTime);
                        if (barDate < earliestHourlyDate)
                            combined.Add(daily);
                    }

                    decimal? prevHourlyClose = null;
                    foreach (var row in trueHourlyRows)
                    {
                        decimal priorDayClose = 0m;
                        foreach (var kv in dailyClosesByDate)
                        {
                            if (kv.Key < row.Date) priorDayClose = kv.Value;
                            else break;
                        }
                        var baseline = priorDayClose > 0
                            ? priorDayClose
                            : (prevHourlyClose ?? (row.Open > 0 ? row.Open : row.Close));
                        var change = Math.Round(row.Close - baseline, 4);
                        var pct = baseline > 0 ? Math.Round(change / baseline * 100m, 2) : 0m;
                        combined.Add(new HistoricalPriceBar(row.Utc, row.QuoteTime, row.Open, row.Close, change, pct));
                        prevHourlyClose = row.Close;
                    }
                }
                else
                {
                    combined = dailyBars;
                }
            }
            else
            {
                combined = dailyBars;
            }

            var result = combined.OrderBy(b => b.Utc).ToArray();
            cache.Set(cacheKey, result, result.Length >= 2 ? TimeSpan.FromMinutes(60) : TimeSpan.FromMinutes(10));
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            cache.Set(cacheKey, Array.Empty<HistoricalPriceBar>(), TimeSpan.FromMinutes(10));
            return [];
        }
    }

    public static ArticleMarketQuote? FindHistoricalQuoteAt(
        DateTime publishedAtUtc,
        MarketQuote? liveQuote,
        HistoricalPriceBar[] bars,
        string topic,
        string symbol,
        string name,
        string exchange,
        string currency)
    {
        var utc = DateTime.SpecifyKind(publishedAtUtc, DateTimeKind.Utc);
        var publishedOffset = new DateTimeOffset(utc);

        if (bars is { Length: > 0 })
        {
            if (liveQuote is not null && liveQuote.Price > 0
                && publishedOffset >= DateTimeOffset.UtcNow.AddMinutes(-90)
                && publishedOffset > bars[^1].Utc.AddHours(12))
            {
                return ToArticleMarketQuote(liveQuote, utc);
            }

            HistoricalPriceBar? matched = null;
            foreach (var bar in bars)
            {
                if (bar.Utc <= publishedOffset) matched = bar;
                else break;
            }
            matched ??= bars[0];

            return new ArticleMarketQuote(
                NormalizeDisplayText(topic, 80),
                symbol.Trim().ToUpperInvariant(),
                NormalizeDisplayText(name, 160),
                exchange.Trim().ToUpperInvariant(),
                currency.Trim().ToUpperInvariant(),
                matched.Close,
                matched.Change,
                matched.PercentChange,
                matched.QuoteTime,
                null,
                utc);
        }

        if (liveQuote is not null && liveQuote.Price > 0
            && Math.Abs((DateTime.UtcNow - utc).TotalHours) <= 24)
        {
            return ToArticleMarketQuote(liveQuote, DateTime.UtcNow);
        }

        return null;
    }

    public async Task<Dictionary<long, ArticleMarketQuote[]>> ResolveQuotesForArticlesAsync(
        IReadOnlyCollection<(long Key, string Title, string[] Topics, DateTime PublishedAtUtc)> articles,
        IReadOnlyDictionary<string, string>? tickerOverrides,
        CancellationToken cancellationToken,
        bool historicalOnly = false)
    {
        var result = new Dictionary<long, ArticleMarketQuote[]>();
        if (!IsConfigured || articles is null || articles.Count == 0)
            return result;

        var candidateTopics = articles
            .SelectMany(a => CollectCandidateTopics(a.Title, a.Topics, tickerOverrides))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (candidateTopics.Length == 0)
            return result;

        var seenTopics = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var fastCandidates = new List<(string Topic, string? Override)>();
        var discoveryCandidates = new List<(string Topic, string? Override)>();

        foreach (var raw in candidateTopics)
        {
            var topic = NormalizeDisplayText(raw, 80);
            if (topic.Length == 0 || !seenTopics.Add(topic)) continue;
            var overrideSymbol = FindOverrideSymbol(tickerOverrides, topic);
            if (overrideSymbol is not null)
                fastCandidates.Add((topic, overrideSymbol));
            else if (HasFastSymbolMatch(topic, out var knownOrCached))
            {
                if (knownOrCached) fastCandidates.Add((topic, null));
            }
            else
            {
                discoveryCandidates.Add((topic, null));
            }
        }

        var topicSeries = new Dictionary<string, (MarketQuote Quote, HistoricalPriceBar[] Bars)>(StringComparer.OrdinalIgnoreCase);
        foreach (var (topic, overrideSymbol) in fastCandidates.Concat(discoveryCandidates.Take(2)).Take(8))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var missCacheKey = ArticleTopicMissCacheKey(topic, overrideSymbol);
            if (cache.TryGetValue(missCacheKey, out _)) continue;
            try
            {
                var quote = await GetForTopicAsync(topic, overrideSymbol, cancellationToken, includeSparkline: false);
                if (quote is null || quote.Price <= 0)
                {
                    cache.Set(missCacheKey, true, TimeSpan.FromMinutes(15));
                    continue;
                }
                var bars = await GetHistoricalBarsAsync(topic, overrideSymbol, 90, cancellationToken);
                topicSeries[topic] = (quote, bars);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Best-effort quote snapshot enrichment should not fail article ingestion.
                cache.Set(missCacheKey, true, TimeSpan.FromMinutes(15));
            }
        }

        if (topicSeries.Count == 0)
            return result;

        foreach (var article in articles)
        {
            var matched = new List<ArticleMarketQuote>();
            var articleTopics = CollectCandidateTopics(article.Title, article.Topics, tickerOverrides);
            foreach (var topic in articleTopics)
            {
                if (!topicSeries.TryGetValue(topic, out var entry)) continue;
                if (historicalOnly && (entry.Bars.Length == 0 || entry.Bars[0].Utc.UtcDateTime > article.PublishedAtUtc))
                    continue;
                var q = FindHistoricalQuoteAt(
                    article.PublishedAtUtc,
                    historicalOnly ? null : entry.Quote,
                    entry.Bars,
                    entry.Quote.Topic,
                    entry.Quote.Symbol,
                    entry.Quote.Name,
                    entry.Quote.Exchange,
                    entry.Quote.Currency);
                if (q is not null) matched.Add(q);
            }
            if (matched.Count > 0)
                result[article.Key] = MergeMarketQuotes("[]", matched);
        }

        return result;
    }

    private static string? FindOverrideSymbol(IReadOnlyDictionary<string, string>? tickerOverrides, string topic)
    {
        if (tickerOverrides is null) return null;
        foreach (var pair in tickerOverrides)
        {
            if (string.Equals(pair.Key, topic, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(pair.Value))
            {
                return pair.Value.Trim();
            }
        }
        return null;
    }

    private sealed record RawSeriesBar(DateTimeOffset Utc, DateOnly Date, string QuoteTime, decimal Open, decimal Close, bool HasTimeOfDay);

    private async Task<List<RawSeriesBar>> FetchTimeSeriesBarsAsync(
        StockMatch match,
        string interval,
        int outputSize,
        bool isHourly,
        CancellationToken cancellationToken)
    {
        try
        {
            var query = $"time_series?symbol={Uri.EscapeDataString(match.Symbol)}&interval={interval}&outputsize={outputSize}";
            if (match.Exchange.Length > 0)
                query += $"&exchange={Uri.EscapeDataString(match.Exchange)}";

            using var document = await SendAsync(query, cancellationToken);
            var root = document.RootElement;
            if (!root.TryGetProperty("values", out var values) || values.ValueKind != JsonValueKind.Array)
                return [];

            var tzId = "";
            if (root.TryGetProperty("meta", out var meta) && meta.ValueKind == JsonValueKind.Object)
                tzId = ReadString(meta, "exchange_timezone");
            var tz = ResolveExchangeTimeZone(tzId);

            var rows = new List<RawSeriesBar>(outputSize);
            foreach (var row in values.EnumerateArray())
            {
                var close = ReadDecimal(row, "close");
                var datetime = ReadString(row, "datetime");
                if (close is not > 0 || datetime.Length == 0) continue;
                var open = ReadDecimal(row, "open") ?? close.Value;

                if (!TryParseSeriesDatetime(datetime, tz, isHourly, out var utc, out var date, out var hasTimeOfDay))
                    continue;
                rows.Add(new RawSeriesBar(utc, date, datetime, open, close.Value, hasTimeOfDay));
            }

            rows.Sort((a, b) => a.Utc.CompareTo(b.Utc));
            return rows;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (InvalidOperationException exception) when (IsPlanRestriction(exception))
        {
            throw;
        }
        catch
        {
            return await FetchYahooTimeSeriesBarsAsync(match, interval, outputSize, isHourly, cancellationToken);
        }
    }

    private static TimeZoneInfo ResolveExchangeTimeZone(string? tzId)
    {
        if (string.IsNullOrWhiteSpace(tzId)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(tzId.Trim()); }
        catch
        {
            if (TimeZoneInfo.TryConvertIanaIdToWindowsId(tzId.Trim(), out var winId))
            {
                try { return TimeZoneInfo.FindSystemTimeZoneById(winId); }
                catch { }
            }
            return TimeZoneInfo.Utc;
        }
    }

    private static bool TryParseSeriesDatetime(
        string value,
        TimeZoneInfo exchangeZone,
        bool isHourly,
        out DateTimeOffset utc,
        out DateOnly date,
        out bool hasTimeOfDay)
    {
        utc = default;
        date = default;
        hasTimeOfDay = false;

        if (DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedDate))
        {
            date = parsedDate;
            var localClose = parsedDate.ToDateTime(new TimeOnly(16, 0, 0), DateTimeKind.Unspecified);
            var offset = exchangeZone.GetUtcOffset(localClose);
            utc = new DateTimeOffset(localClose, offset).ToUniversalTime();
            return true;
        }

        if (DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt))
        {
            hasTimeOfDay = value.Contains(':');
            date = DateOnly.FromDateTime(dt);
            if (dt.Kind == DateTimeKind.Utc)
            {
                utc = new DateTimeOffset(dt, TimeSpan.Zero);
            }
            else
            {
                var unspecified = DateTime.SpecifyKind(dt, DateTimeKind.Unspecified);
                var offset = (isHourly || hasTimeOfDay)
                    ? exchangeZone.GetUtcOffset(unspecified)
                    : TimeSpan.Zero;
                utc = new DateTimeOffset(unspecified, offset).ToUniversalTime();
            }
            return true;
        }

        return false;
    }

    private bool HasFastSymbolMatch(string topic, out bool matched)
    {
        if (KnownSymbols.ContainsKey(topic) || KnownNzxSymbols.ContainsKey(topic))
        {
            matched = true;
            return true;
        }
        var cacheKey = $"market-match:{topic}".ToLowerInvariant();
        if (cache.TryGetValue(cacheKey, out StockMatchCache? cachedMatch) && cachedMatch is not null)
        {
            matched = cachedMatch.Found;
            return true;
        }
        matched = false;
        return false;
    }

    private async Task<StockMatch?> FindMatchAsync(string topic, CancellationToken cancellationToken)
    {
        if (KnownSymbols.TryGetValue(topic, out var knownSymbol))
            return new StockMatch(knownSymbol, "", "");
        if (KnownNzxSymbols.TryGetValue(topic, out var knownNzxSymbol))
            return new StockMatch(knownNzxSymbol, "", "NZX");

        var cacheKey = $"market-match:{topic}".ToLowerInvariant();
        if (cache.TryGetValue(cacheKey, out StockMatchCache? cachedMatch) && cachedMatch is not null)
            return cachedMatch.Found ? cachedMatch.Match : null;

        StockMatch? match = null;
        try
        {
            using var document = await SendAsync(
                $"symbol_search?symbol={Uri.EscapeDataString(topic)}&outputsize=10",
                cancellationToken);
            var candidates = document.RootElement.TryGetProperty("data", out var data)
                && data.ValueKind == JsonValueKind.Array
                    ? data.EnumerateArray()
                    : [];

            foreach (var candidate in candidates)
            {
                var symbol = ReadString(candidate, "symbol");
                var name = ReadString(candidate, "instrument_name");
                var exchange = ReadString(candidate, "exchange");
                var instrumentType = ReadString(candidate, "instrument_type");
                if (symbol.Length == 0 || name.Length == 0 || !SupportedInstrumentTypes.Contains(instrumentType)) continue;
                if (exchange.StartsWith("OTC", StringComparison.OrdinalIgnoreCase)) continue;
                if (!IsConfidentMatch(topic, symbol, name)) continue;
                match = new StockMatch(symbol, name, exchange);
                break;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            match = await FindYahooMatchAsync(topic, cancellationToken);
        }

        cache.Set(
            cacheKey,
            new StockMatchCache(match is not null, match),
            match is null ? TimeSpan.FromHours(4) : TimeSpan.FromDays(1));
        return match;
    }

    private async Task<MarketQuote> RequestQuoteAsync(
        string topic,
        StockMatch match,
        CancellationToken cancellationToken)
    {
        try
        {
            var baseQuery = $"quote?symbol={Uri.EscapeDataString(match.Symbol)}";
            if (match.Exchange.Length > 0)
                baseQuery += $"&exchange={Uri.EscapeDataString(match.Exchange)}";

            JsonDocument document;
            try
            {
                document = await SendAsync($"{baseQuery}&prepost=true", cancellationToken);
            }
            catch (InvalidOperationException exception) when (IsExtendedHoursUnsupported(exception))
            {
                document = await SendAsync(baseQuery, cancellationToken);
            }

            using var _ = document;
            var root = document.RootElement;
            var price = ReadDecimal(root, "close");
            if (price is null) throw new InvalidOperationException("The latest quote did not include a price.");

            var isMarketOpen = ReadBoolean(root, "is_market_open");
            var lastQuoteAt = ReadInt64(root, "last_quote_at");
            var extendedPriceRaw = ReadDecimal(root, "extended_price");
            var extendedTimestamp = ReadInt64(root, "extended_timestamp");
            var extendedDatetime = ReadString(root, "extended_datetime");

            decimal? extendedPrice = null;
            decimal? extendedChange = null;
            decimal? extendedPercentChange = null;
            string? extendedQuoteTime = null;
            string? extendedSession = null;

            var isStalePreMarketDuringOpenSession = isMarketOpen == true
                && lastQuoteAt.HasValue
                && extendedTimestamp.HasValue
                && extendedTimestamp.Value < lastQuoteAt.Value;

            if (extendedPriceRaw is > 0 && !isStalePreMarketDuringOpenSession)
            {
                extendedPrice = extendedPriceRaw.Value;
                extendedChange = ReadDecimal(root, "extended_change")
                    ?? Math.Round(extendedPrice.Value - price.Value, 4);
                extendedPercentChange = ReadDecimal(root, "extended_percent_change")
                    ?? (price.Value > 0 ? Math.Round(extendedChange.Value / price.Value * 100m, 2) : 0m);

                if (extendedTimestamp is > 0)
                {
                    var etZone = ResolveExchangeTimeZone("America/New_York");
                    var etTime = TimeZoneInfo.ConvertTime(
                        DateTimeOffset.FromUnixTimeSeconds(extendedTimestamp.Value),
                        etZone);
                    extendedQuoteTime = !string.IsNullOrWhiteSpace(extendedDatetime)
                        ? NormalizeDisplayText(extendedDatetime, 64)
                        : etTime.ToString("yyyy-MM-dd HH:mm 'ET'", CultureInfo.InvariantCulture);
                    extendedSession = IsPreMarketLocalTime(etTime.Hour, etTime.Minute)
                        ? "pre-market"
                        : "after-hours";
                }
                else if (!string.IsNullOrWhiteSpace(extendedDatetime))
                {
                    extendedQuoteTime = NormalizeDisplayText(extendedDatetime, 64);
                    extendedSession = DateTime.TryParse(extendedDatetime, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedEt)
                        && IsPreMarketLocalTime(parsedEt.Hour, parsedEt.Minute)
                        ? "pre-market"
                        : "after-hours";
                }
                else
                {
                    extendedSession = "after-hours";
                }
            }

            return new MarketQuote(
                topic,
                ReadString(root, "symbol", match.Symbol),
                ReadString(root, "name", match.Name.Length > 0 ? match.Name : match.Symbol),
                ReadString(root, "exchange", match.Exchange),
                ReadString(root, "currency"),
                price.Value,
                ReadDecimal(root, "change") ?? 0,
                ReadDecimal(root, "percent_change") ?? 0,
                ReadString(root, "datetime"),
                isMarketOpen,
                "Twelve Data",
                ExtendedPrice: extendedPrice,
                ExtendedChange: extendedChange,
                ExtendedPercentChange: extendedPercentChange,
                ExtendedQuoteTime: extendedQuoteTime,
                ExtendedSession: extendedSession);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (InvalidOperationException exception) when (IsPlanRestriction(exception))
        {
            throw;
        }
        catch
        {
            return await RequestYahooQuoteAsync(topic, match, cancellationToken);
        }
    }

    private async Task<decimal[]?> TryGetSparklineAsync(
        StockMatch match,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"market-sparkline:{match.Symbol}:{match.Exchange}".ToLowerInvariant();
        if (cache.TryGetValue(cacheKey, out decimal[]? cached))
            return cached is { Length: >= 2 } ? cached : null;

        try
        {
            var query = $"time_series?symbol={Uri.EscapeDataString(match.Symbol)}&interval=1day&outputsize=14";
            if (match.Exchange.Length > 0)
                query += $"&exchange={Uri.EscapeDataString(match.Exchange)}";

            using var document = await SendAsync(query, cancellationToken);
            if (!document.RootElement.TryGetProperty("values", out var values)
                || values.ValueKind != JsonValueKind.Array)
            {
                cache.Set(cacheKey, Array.Empty<decimal>(), TimeSpan.FromMinutes(10));
                return null;
            }

            var points = new List<decimal>(14);
            foreach (var row in values.EnumerateArray())
            {
                var close = ReadDecimal(row, "close");
                if (close is > 0)
                    points.Add(close.Value);
            }

            // Twelve Data returns newest-first; reverse into chronological order (oldest -> latest)
            points.Reverse();
            if (points.Count < 2)
            {
                cache.Set(cacheKey, Array.Empty<decimal>(), TimeSpan.FromMinutes(10));
                return null;
            }

            var result = points.ToArray();
            cache.Set(cacheKey, result, TimeSpan.FromMinutes(60));
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (InvalidOperationException exception) when (IsPlanRestriction(exception))
        {
            return null;
        }
        catch
        {
            return await TryGetYahooSparklineAsync(match, cancellationToken);
        }
    }

    private const string QuotaCooldownCacheKey = "twelvedata:quota-exhausted";

    private async Task<JsonDocument> SendAsync(string relativePath, CancellationToken cancellationToken)
    {
        if (cache.TryGetValue(QuotaCooldownCacheKey, out string? cooldownMessage) && !string.IsNullOrEmpty(cooldownMessage))
            throw new InvalidOperationException(cooldownMessage);

        using var request = new HttpRequestMessage(HttpMethod.Get, relativePath);
        request.Headers.Authorization = new AuthenticationHeaderValue("apikey", options.Value.ApiKey.Trim());
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        JsonDocument? document = null;
        try
        {
            document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        }
        catch (JsonException) when (!response.IsSuccessStatusCode)
        {
            var fallbackMsg = $"Market pricing is temporarily unavailable ({(int)response.StatusCode}).";
            if (IsQuotaOrRateLimit(response.StatusCode, fallbackMsg))
                cache.Set(QuotaCooldownCacheKey, fallbackMsg, TimeSpan.FromMinutes(1));
            throw new InvalidOperationException(fallbackMsg);
        }

        if (response.IsSuccessStatusCode
            && (!document.RootElement.TryGetProperty("status", out var status)
                || !string.Equals(status.GetString(), "error", StringComparison.OrdinalIgnoreCase)))
            return document;

        var message = ReadString(document.RootElement, "message", "Market pricing is temporarily unavailable.");
        document.Dispose();
        if (IsQuotaOrRateLimit(response.StatusCode, message))
        {
            var ttl = IsDailyQuotaExhausted(message)
                ? TimeSpan.FromMinutes(15)
                : TimeSpan.FromMinutes(1);
            cache.Set(QuotaCooldownCacheKey, message, ttl);
        }
        throw new InvalidOperationException(message);
    }

    private static string ArticleTopicMissCacheKey(string topic, string? overrideSymbol) =>
        $"market-article-topic-miss:{topic}:{overrideSymbol ?? ""}".ToLowerInvariant();

    private static bool IsQuotaOrRateLimit(HttpStatusCode statusCode, string message) =>
        statusCode == HttpStatusCode.TooManyRequests || IsQuotaOrRateLimitMessage(message);

    private static bool IsQuotaOrRateLimit(InvalidOperationException exception) =>
        IsQuotaOrRateLimitMessage(exception.Message);

    private static bool IsQuotaOrRateLimitMessage(string message) =>
        message.Contains("API credits", StringComparison.OrdinalIgnoreCase)
        || message.Contains("run out of API credits", StringComparison.OrdinalIgnoreCase)
        || message.Contains("daily limit", StringComparison.OrdinalIgnoreCase)
        || message.Contains("minute limit", StringComparison.OrdinalIgnoreCase)
        || message.Contains("Too Many Requests", StringComparison.OrdinalIgnoreCase);

    private static bool IsDailyQuotaExhausted(string message) =>
        message.Contains("run out of API credits", StringComparison.OrdinalIgnoreCase)
        || message.Contains("for the day", StringComparison.OrdinalIgnoreCase)
        || message.Contains("daily limit", StringComparison.OrdinalIgnoreCase);

    private async Task<JsonDocument> SendYahooAsync(string pathAndQuery, CancellationToken cancellationToken)
    {
        var uri = new Uri($"https://query1.finance.yahoo.com/{pathAndQuery.TrimStart('/')}");
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.UserAgent.Clear();
        request.Headers.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
        request.Headers.Accept.Clear();
        request.Headers.Accept.ParseAdd("application/json");
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var errorMessage = $"Market pricing is temporarily unavailable ({(int)response.StatusCode}).";
            try
            {
                await using var errorStream = await response.Content.ReadAsStreamAsync(cancellationToken);
                using var errorDoc = await JsonDocument.ParseAsync(errorStream, cancellationToken: cancellationToken);
                if (errorDoc.RootElement.TryGetProperty("chart", out var errorChart)
                    && errorChart.TryGetProperty("error", out var errorObj)
                    && errorObj.ValueKind == JsonValueKind.Object)
                {
                    errorMessage = ReadString(errorObj, "description", errorMessage);
                }
            }
            catch (JsonException) { }
            throw new InvalidOperationException(errorMessage);
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
    }

    private async Task<StockMatch?> FindYahooMatchAsync(string topic, CancellationToken cancellationToken)
    {
        using var document = await SendYahooAsync(
            $"v1/finance/search?q={Uri.EscapeDataString(topic)}&quotesCount=10&newsCount=0",
            cancellationToken);
        if (!document.RootElement.TryGetProperty("quotes", out var quotes)
            || quotes.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var candidate in quotes.EnumerateArray())
        {
            var quoteType = ReadString(candidate, "quoteType");
            if (!quoteType.Equals("EQUITY", StringComparison.OrdinalIgnoreCase)
                && !quoteType.Equals("ETF", StringComparison.OrdinalIgnoreCase))
                continue;
            var rawSymbol = ReadString(candidate, "symbol");
            var name = ReadString(candidate, "longname", ReadString(candidate, "shortname"));
            var rawExchange = ReadString(candidate, "exchDisp", ReadString(candidate, "exchange"));
            if (rawSymbol.Length == 0 || name.Length == 0) continue;
            if (rawExchange.StartsWith("OTC", StringComparison.OrdinalIgnoreCase)
                || rawExchange.Equals("PNK", StringComparison.OrdinalIgnoreCase))
                continue;

            var (cleanSymbol, mappedExchange) = FromYahooSymbolAndExchange(rawSymbol, rawExchange, rawSymbol, "");
            if (!IsConfidentMatch(topic, cleanSymbol, name)) continue;
            return new StockMatch(cleanSymbol, name, mappedExchange);
        }

        return null;
    }

    private async Task<MarketQuote> RequestYahooQuoteAsync(
        string topic,
        StockMatch match,
        CancellationToken cancellationToken)
    {
        var yahooSymbol = ToYahooSymbol(match);
        using var document = await SendYahooAsync(
            $"v8/finance/chart/{Uri.EscapeDataString(yahooSymbol)}?interval=15m&range=5d&includePrePost=true",
            cancellationToken);
        var result = ExtractYahooChartResult(document.RootElement);
        var meta = result.GetProperty("meta");

        var price = ReadDecimal(meta, "regularMarketPrice");
        var previousClose = ReadDecimal(meta, "previousClose") ?? ReadDecimal(meta, "chartPreviousClose") ?? 0m;
        var tzId = ReadString(meta, "exchangeTimezoneName");
        var tz = ResolveExchangeTimeZone(tzId);
        var regularMarketTime = ReadInt64(meta, "regularMarketTime");

        long? preStart = null, regStart = null, regEnd = null, postStart = null, postEnd = null;
        if (meta.TryGetProperty("currentTradingPeriod", out var periods) && periods.ValueKind == JsonValueKind.Object)
        {
            if (periods.TryGetProperty("pre", out var preObj) && preObj.ValueKind == JsonValueKind.Object)
                preStart = ReadInt64(preObj, "start");
            if (periods.TryGetProperty("regular", out var regObj) && regObj.ValueKind == JsonValueKind.Object)
            {
                regStart = ReadInt64(regObj, "start");
                regEnd = ReadInt64(regObj, "end");
            }
            if (periods.TryGetProperty("post", out var postObj) && postObj.ValueKind == JsonValueKind.Object)
            {
                postStart = ReadInt64(postObj, "start");
                postEnd = ReadInt64(postObj, "end");
            }
        }

        var nowUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        bool? isMarketOpen = regStart.HasValue && regEnd.HasValue
            ? nowUnix >= regStart.Value && nowUnix < regEnd.Value
            : null;

        long? latestBarTs = null;
        decimal? latestBarClose = null;
        decimal? latestRegularBarClose = null;
        if (TryGetYahooCloseArrays(result, out var timestamps, out var closes))
        {
            var len = Math.Min(timestamps.GetArrayLength(), closes.GetArrayLength());
            for (var i = 0; i < len; i++)
            {
                var close = ReadArrayDecimal(closes[i]);
                if (close is not > 0 || !timestamps[i].TryGetInt64(out var ts)) continue;
                latestBarTs = ts;
                latestBarClose = close.Value;
                if (!regStart.HasValue || !regEnd.HasValue || (ts >= regStart.Value && ts <= regEnd.Value))
                    latestRegularBarClose = close.Value;
            }
        }

        price ??= latestRegularBarClose ?? latestBarClose;
        if (price is null || price.Value <= 0)
            throw new InvalidOperationException("The latest quote did not include a price.");

        var change = ReadDecimal(meta, "fulldayChange")
            ?? (previousClose > 0 ? Math.Round(price.Value - previousClose, 4) : 0m);
        var percentChange = ReadDecimal(meta, "regularMarketChangePercent")
            ?? (previousClose > 0 ? Math.Round(change / previousClose * 100m, 2) : 0m);
        var quoteTime = regularMarketTime is > 0
            ? TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeSeconds(regularMarketTime.Value), tz)
                .ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)
            : "";

        decimal? extendedPrice = null;
        decimal? extendedChange = null;
        decimal? extendedPercentChange = null;
        string? extendedQuoteTime = null;
        string? extendedSession = null;

        var hasPrePost = ReadBoolean(meta, "hasPrePostMarketData") == true;
        if (isMarketOpen != true
            && hasPrePost
            && latestBarTs.HasValue
            && latestBarClose is > 0
            && (!regularMarketTime.HasValue || latestBarTs.Value > regularMarketTime.Value))
        {
            if ((postStart.HasValue && postEnd.HasValue && latestBarTs.Value >= postStart.Value && latestBarTs.Value <= postEnd.Value)
                || (regEnd.HasValue && latestBarTs.Value >= regEnd.Value))
            {
                extendedSession = "after-hours";
                extendedPrice = Math.Round(latestBarClose.Value, 4);
            }
            else if (preStart.HasValue && regStart.HasValue && latestBarTs.Value >= preStart.Value && latestBarTs.Value < regStart.Value)
            {
                extendedSession = "pre-market";
                extendedPrice = Math.Round(latestBarClose.Value, 4);
            }

            if (extendedPrice is > 0)
            {
                extendedChange = Math.Round(extendedPrice.Value - price.Value, 4);
                extendedPercentChange = price.Value > 0 ? Math.Round(extendedChange.Value / price.Value * 100m, 2) : 0m;
                var etZone = ResolveExchangeTimeZone("America/New_York");
                extendedQuoteTime = TimeZoneInfo.ConvertTime(
                    DateTimeOffset.FromUnixTimeSeconds(latestBarTs.Value),
                    etZone).ToString("yyyy-MM-dd HH:mm 'ET'", CultureInfo.InvariantCulture);
            }
        }

        var (resolvedSymbol, resolvedExchange) = FromYahooSymbolAndExchange(
            ReadString(meta, "symbol", yahooSymbol),
            ReadString(meta, "exchangeName", match.Exchange),
            match.Symbol,
            match.Exchange);
        var displayName = ReadString(meta, "longName", ReadString(meta, "shortName", match.Name.Length > 0 ? match.Name : resolvedSymbol));
        var currency = ReadString(meta, "currency");

        return new MarketQuote(
            topic,
            resolvedSymbol,
            displayName,
            resolvedExchange,
            currency,
            price.Value,
            change,
            percentChange,
            quoteTime,
            isMarketOpen,
            "Yahoo Finance",
            ExtendedPrice: extendedPrice,
            ExtendedChange: extendedChange,
            ExtendedPercentChange: extendedPercentChange,
            ExtendedQuoteTime: extendedQuoteTime,
            ExtendedSession: extendedSession);
    }

    private async Task<decimal[]?> TryGetYahooSparklineAsync(
        StockMatch match,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"market-sparkline:{match.Symbol}:{match.Exchange}".ToLowerInvariant();
        try
        {
            var yahooSymbol = ToYahooSymbol(match);
            using var document = await SendYahooAsync(
                $"v8/finance/chart/{Uri.EscapeDataString(yahooSymbol)}?interval=1d&range=1mo",
                cancellationToken);
            var result = ExtractYahooChartResult(document.RootElement);
            if (!TryGetYahooCloseArrays(result, out _, out var closes))
            {
                cache.Set(cacheKey, Array.Empty<decimal>(), TimeSpan.FromMinutes(10));
                return null;
            }

            var points = new List<decimal>(32);
            foreach (var item in closes.EnumerateArray())
            {
                var close = ReadArrayDecimal(item);
                if (close is > 0)
                    points.Add(close.Value);
            }

            if (points.Count < 2)
            {
                cache.Set(cacheKey, Array.Empty<decimal>(), TimeSpan.FromMinutes(10));
                return null;
            }

            var sliced = points.TakeLast(14).ToArray();
            cache.Set(cacheKey, sliced, TimeSpan.FromMinutes(60));
            return sliced;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            cache.Set(cacheKey, Array.Empty<decimal>(), TimeSpan.FromMinutes(10));
            return null;
        }
    }

    private async Task<List<RawSeriesBar>> FetchYahooTimeSeriesBarsAsync(
        StockMatch match,
        string interval,
        int outputSize,
        bool isHourly,
        CancellationToken cancellationToken)
    {
        var yahooSymbol = ToYahooSymbol(match);
        var range = isHourly
            ? "1mo"
            : outputSize <= 30 ? "1mo"
            : outputSize <= 90 ? "3mo"
            : outputSize <= 180 ? "6mo"
            : "2y";
        var yahooInterval = isHourly ? "1h" : "1d";

        using var document = await SendYahooAsync(
            $"v8/finance/chart/{Uri.EscapeDataString(yahooSymbol)}?interval={yahooInterval}&range={range}",
            cancellationToken);
        var result = ExtractYahooChartResult(document.RootElement);
        if (!TryGetYahooCloseArrays(result, out var timestamps, out var closes))
            return [];

        JsonElement opens = default;
        var hasOpens = result.TryGetProperty("indicators", out var indicators)
            && indicators.TryGetProperty("quote", out var quoteArr)
            && quoteArr.ValueKind == JsonValueKind.Array
            && quoteArr.GetArrayLength() > 0
            && quoteArr[0].TryGetProperty("open", out opens)
            && opens.ValueKind == JsonValueKind.Array;

        var tzId = result.TryGetProperty("meta", out var meta) ? ReadString(meta, "exchangeTimezoneName") : "";
        var tz = ResolveExchangeTimeZone(tzId);

        var rows = new List<RawSeriesBar>(outputSize);
        var len = Math.Min(timestamps.GetArrayLength(), closes.GetArrayLength());
        for (var i = 0; i < len; i++)
        {
            var close = ReadArrayDecimal(closes[i]);
            if (close is not > 0 || !timestamps[i].TryGetInt64(out var ts)) continue;
            var open = (hasOpens && i < opens.GetArrayLength() ? ReadArrayDecimal(opens[i]) : null) ?? close.Value;

            var utcFromEpoch = DateTimeOffset.FromUnixTimeSeconds(ts).ToUniversalTime();
            var localDt = TimeZoneInfo.ConvertTime(utcFromEpoch, tz);
            var date = DateOnly.FromDateTime(localDt.DateTime);

            if (isHourly)
            {
                var quoteTime = localDt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
                rows.Add(new RawSeriesBar(utcFromEpoch, date, quoteTime, open, close.Value, true));
            }
            else
            {
                var localClose = date.ToDateTime(new TimeOnly(16, 0, 0), DateTimeKind.Unspecified);
                var offset = tz.GetUtcOffset(localClose);
                var closeUtc = new DateTimeOffset(localClose, offset).ToUniversalTime();
                var quoteTime = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                rows.Add(new RawSeriesBar(closeUtc, date, quoteTime, open, close.Value, false));
            }
        }

        rows.Sort((a, b) => a.Utc.CompareTo(b.Utc));
        if (rows.Count > outputSize)
            rows = rows.Skip(rows.Count - outputSize).ToList();
        return rows;
    }

    private static JsonElement ExtractYahooChartResult(JsonElement root)
    {
        if (!root.TryGetProperty("chart", out var chart) || chart.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Market pricing is temporarily unavailable.");
        if (chart.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
            throw new InvalidOperationException(ReadString(error, "description", "Market pricing is temporarily unavailable."));
        if (!chart.TryGetProperty("result", out var results)
            || results.ValueKind != JsonValueKind.Array
            || results.GetArrayLength() == 0)
            throw new InvalidOperationException("The latest quote did not include a price.");
        return results[0];
    }

    private static bool TryGetYahooCloseArrays(JsonElement result, out JsonElement timestamps, out JsonElement closes)
    {
        timestamps = default;
        closes = default;
        if (!result.TryGetProperty("timestamp", out timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return false;
        if (!result.TryGetProperty("indicators", out var indicators)
            || !indicators.TryGetProperty("quote", out var quotes)
            || quotes.ValueKind != JsonValueKind.Array
            || quotes.GetArrayLength() == 0
            || !quotes[0].TryGetProperty("close", out closes)
            || closes.ValueKind != JsonValueKind.Array)
            return false;
        return true;
    }

    private static decimal? ReadArrayDecimal(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number
        && decimal.TryParse(value.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private static string ToYahooSymbol(StockMatch match)
    {
        var symbol = match.Symbol.Trim().ToUpperInvariant();
        var exchange = match.Exchange.Trim().ToUpperInvariant();
        if (exchange.Length == 0 || exchange is "NASDAQ" or "NYSE" or "AMEX" or "NMS" or "NGM" or "NCM" or "NYQ" or "ASE" or "PCX" or "BATS")
            return symbol.Replace('.', '-');

        var suffix = exchange switch
        {
            "NZX" or "XNZE" or "NZE" => ".NZ",
            "ASX" or "XASX" => ".AX",
            "LSE" or "XLON" => ".L",
            "TSX" or "XTSE" => ".TO",
            "TSXV" or "XTSX" => ".V",
            "HKEX" or "XHKG" => ".HK",
            "NSE" => ".NS",
            "BSE" => ".BO",
            "JPX" or "TYO" or "XTKS" => ".T",
            "FRA" or "XETR" or "ETR" => ".DE",
            "EPA" or "XPAR" => ".PA",
            "AMS" or "XAMS" => ".AS",
            "SWX" or "XSWX" => ".SW",
            "SGX" or "XSES" => ".SI",
            _ => "",
        };
        return suffix.Length > 0 && !symbol.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
            ? symbol + suffix
            : symbol;
    }

    private static (string Symbol, string Exchange) FromYahooSymbolAndExchange(
        string yahooSymbol,
        string yahooExchange,
        string fallbackSymbol,
        string fallbackExchange)
    {
        var cleanSymbol = yahooSymbol.Trim().ToUpperInvariant();
        var mappedExchange = yahooExchange.Trim().ToUpperInvariant() switch
        {
            "NZE" or "XNZE" => "NZX",
            "NMS" or "NGM" or "NCM" or "NASDAQGS" or "NASDAQGM" or "NASDAQCM" => "NASDAQ",
            "NYQ" or "NYSE" => "NYSE",
            "ASE" or "AMEX" => "AMEX",
            "ASX" or "XASX" => "ASX",
            "LSE" or "XLON" => "LSE",
            "TOR" or "TSX" or "XTSE" => "TSX",
            "HKG" or "HKEX" or "XHKG" => "HKEX",
            _ => string.IsNullOrWhiteSpace(yahooExchange) ? fallbackExchange : yahooExchange.Trim().ToUpperInvariant(),
        };

        foreach (var (suffix, exchangeForSuffix) in new[]
        {
            (".NZ", "NZX"),
            (".AX", "ASX"),
            (".L", "LSE"),
            (".TO", "TSX"),
            (".V", "TSXV"),
            (".HK", "HKEX"),
            (".NS", "NSE"),
            (".BO", "BSE"),
            (".T", "TYO"),
            (".DE", "XETR"),
            (".PA", "EPA"),
            (".AS", "AMS"),
            (".SW", "SWX"),
            (".SI", "SGX"),
        })
        {
            if (cleanSymbol.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) && cleanSymbol.Length > suffix.Length)
            {
                cleanSymbol = cleanSymbol[..^suffix.Length];
                if (string.IsNullOrWhiteSpace(fallbackExchange))
                    mappedExchange = exchangeForSuffix;
                break;
            }
        }

        if (cleanSymbol.Length == 0 || string.Equals(cleanSymbol.Replace('-', '.'), fallbackSymbol, StringComparison.OrdinalIgnoreCase))
            cleanSymbol = fallbackSymbol;
        if (!string.IsNullOrWhiteSpace(fallbackExchange))
            mappedExchange = fallbackExchange;
        return (cleanSymbol, mappedExchange);
    }

    private static bool IsConfidentMatch(string topic, string symbol, string instrumentName)
    {
        var normalizedTopic = NormalizeForMatch(topic);
        var normalizedName = NormalizeForMatch(instrumentName);
        if (normalizedTopic.Length < 2 || normalizedName.Length < 2) return false;
        if (string.Equals(topic.Trim(), symbol, StringComparison.OrdinalIgnoreCase)) return true;
        if (normalizedName == normalizedTopic) return true;
        var hasMultipleWords = normalizedTopic.Contains(' ', StringComparison.Ordinal);
        var isKnownCompany = KnownSymbols.ContainsKey(topic.Trim()) || KnownNzxSymbols.ContainsKey(topic.Trim());
        if (!hasMultipleWords && !isKnownCompany) return false;
        return normalizedName.StartsWith($"{normalizedTopic} ", StringComparison.Ordinal)
            || normalizedTopic.StartsWith($"{normalizedName} ", StringComparison.Ordinal);
    }

    private static bool IsPlanRestriction(InvalidOperationException exception) =>
        exception.Message.Contains("available starting with", StringComparison.OrdinalIgnoreCase)
        && exception.Message.Contains("plan", StringComparison.OrdinalIgnoreCase);

    private static bool IsExtendedHoursUnsupported(InvalidOperationException exception) =>
        exception.Message.Contains("Pre/post", StringComparison.OrdinalIgnoreCase)
        || exception.Message.Contains("Pre-market", StringComparison.OrdinalIgnoreCase)
        || exception.Message.Contains("extended hours", StringComparison.OrdinalIgnoreCase)
        || exception.Message.Contains("prepost", StringComparison.OrdinalIgnoreCase);

    private static bool IsPreMarketLocalTime(int hour, int minute) =>
        hour >= 4 && (hour < 9 || (hour == 9 && minute < 30));

    private static string NormalizeForMatch(string value)
    {
        var wordsToDrop = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "adr", "co", "company", "corp", "corporation", "holdings", "inc",
            "incorporated", "limited", "ltd", "plc", "sa",
        };
        var normalized = new string(value
            .ToLowerInvariant()
            .Select(character => char.IsLetterOrDigit(character) ? character : ' ')
            .ToArray());
        return string.Join(
            " ",
            normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                .Where(word => !wordsToDrop.Contains(word)));
    }

    private static string NormalizeDisplayText(string? value, int maximumLength)
    {
        var normalized = string.Join(" ", (value ?? "").Split(
            (char[]?)null,
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        return normalized[..Math.Min(normalized.Length, maximumLength)];
    }

    private static string ReadString(JsonElement element, string property, string fallback = "") =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? fallback
            : fallback;

    private static decimal? ReadDecimal(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value)
        && decimal.TryParse(value.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private static long? ReadInt64(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value)
        && long.TryParse(value.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;

    private static bool? ReadBoolean(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    private sealed record StockMatch(string Symbol, string Name, string Exchange);
    private sealed record StockMatchCache(bool Found, StockMatch? Match);
}
