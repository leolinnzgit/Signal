using System.Globalization;
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
    decimal[]? Sparkline = null);

public sealed record MarketWatchlistTopicInput(string Topic, string? Symbol = null);

public sealed record MarketPricePoint(string Timestamp, decimal Price);

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
                    cache.Set(quoteCacheKey, resolved, TimeSpan.FromMinutes(2));
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
        cache.Set(quoteCacheKey, quote, TimeSpan.FromMinutes(2));
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
            recordedAtUtc);

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
            var normalized = raw with
            {
                Topic = NormalizeDisplayText(raw.Topic, 80),
                Symbol = raw.Symbol.Trim().ToUpperInvariant(),
                Name = NormalizeDisplayText(raw.Name, 160),
                Exchange = (raw.Exchange ?? "").Trim().ToUpperInvariant(),
                Currency = (raw.Currency ?? "").Trim().ToUpperInvariant(),
                QuoteTime = NormalizeDisplayText(raw.QuoteTime, 64),
                RecordedAtUtc = raw.RecordedAtUtc == default ? DateTime.UtcNow : raw.RecordedAtUtc,
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
            try
            {
                var quote = await GetForTopicAsync(topic, overrideSymbol, cancellationToken, includeSparkline: false);
                if (quote is not null && quote.Price > 0)
                    resolved[topic] = ToArticleMarketQuote(quote, recordedAtUtc);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Best-effort quote snapshot enrichment should not fail article ingestion.
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
        if (!IsConfigured) return [];
        var boundedSize = Math.Clamp(outputSize, 2, 180);

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

        var cacheKey = $"market-dated-series:{match.Symbol}:{match.Exchange}:{boundedSize}".ToLowerInvariant();
        if (cache.TryGetValue(cacheKey, out MarketPricePoint[]? cached) && cached is not null)
            return cached;

        try
        {
            var query = $"time_series?symbol={Uri.EscapeDataString(match.Symbol)}&interval=1day&outputsize={boundedSize}";
            if (match.Exchange.Length > 0)
                query += $"&exchange={Uri.EscapeDataString(match.Exchange)}";

            using var document = await SendAsync(query, cancellationToken);
            if (!document.RootElement.TryGetProperty("values", out var values)
                || values.ValueKind != JsonValueKind.Array)
            {
                cache.Set(cacheKey, Array.Empty<MarketPricePoint>(), TimeSpan.FromMinutes(10));
                return [];
            }

            var points = new List<MarketPricePoint>(boundedSize);
            foreach (var row in values.EnumerateArray())
            {
                var close = ReadDecimal(row, "close");
                var datetime = ReadString(row, "datetime");
                if (close is > 0 && datetime.Length > 0)
                    points.Add(new MarketPricePoint(datetime, close.Value));
            }

            // Twelve Data returns newest-first; reverse into chronological order (oldest -> latest)
            points.Reverse();
            var result = points.ToArray();
            cache.Set(cacheKey, result, result.Length >= 2 ? TimeSpan.FromMinutes(30) : TimeSpan.FromMinutes(10));
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            cache.Set(cacheKey, Array.Empty<MarketPricePoint>(), TimeSpan.FromMinutes(10));
            return [];
        }
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

        using var document = await SendAsync(
            $"symbol_search?symbol={Uri.EscapeDataString(topic)}&outputsize=10",
            cancellationToken);
        var candidates = document.RootElement.TryGetProperty("data", out var data)
            && data.ValueKind == JsonValueKind.Array
                ? data.EnumerateArray()
                : [];

        StockMatch? match = null;
        foreach (var candidate in candidates)
        {
            var symbol = ReadString(candidate, "symbol");
            var name = ReadString(candidate, "instrument_name");
            var exchange = ReadString(candidate, "exchange");
            var instrumentType = ReadString(candidate, "instrument_type");
            if (symbol.Length == 0 || name.Length == 0 || !SupportedInstrumentTypes.Contains(instrumentType)) continue;
            if (!IsConfidentMatch(topic, symbol, name)) continue;
            match = new StockMatch(symbol, name, exchange);
            break;
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
        var query = $"quote?symbol={Uri.EscapeDataString(match.Symbol)}";
        if (match.Exchange.Length > 0)
            query += $"&exchange={Uri.EscapeDataString(match.Exchange)}";

        using var document = await SendAsync(query, cancellationToken);
        var root = document.RootElement;
        var price = ReadDecimal(root, "close");
        if (price is null) throw new InvalidOperationException("The latest quote did not include a price.");

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
            ReadBoolean(root, "is_market_open"),
            "Twelve Data");
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
        catch
        {
            cache.Set(cacheKey, Array.Empty<decimal>(), TimeSpan.FromMinutes(10));
            return null;
        }
    }

    private async Task<JsonDocument> SendAsync(string relativePath, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, relativePath);
        request.Headers.Authorization = new AuthenticationHeaderValue("apikey", options.Value.ApiKey.Trim());
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (response.IsSuccessStatusCode
            && (!document.RootElement.TryGetProperty("status", out var status)
                || !string.Equals(status.GetString(), "error", StringComparison.OrdinalIgnoreCase)))
            return document;

        var message = ReadString(document.RootElement, "message", "Market pricing is temporarily unavailable.");
        document.Dispose();
        throw new InvalidOperationException(message);
    }

    private static bool IsConfidentMatch(string topic, string symbol, string instrumentName)
    {
        var normalizedTopic = NormalizeForMatch(topic);
        var normalizedName = NormalizeForMatch(instrumentName);
        if (normalizedTopic.Length < 2 || normalizedName.Length < 2) return false;
        if (string.Equals(topic.Trim(), symbol, StringComparison.OrdinalIgnoreCase)) return true;
        if (normalizedName == normalizedTopic) return true;
        return normalizedName.StartsWith($"{normalizedTopic} ", StringComparison.Ordinal)
            || normalizedTopic.StartsWith($"{normalizedName} ", StringComparison.Ordinal);
    }

    private static bool IsPlanRestriction(InvalidOperationException exception) =>
        exception.Message.Contains("available starting with", StringComparison.OrdinalIgnoreCase)
        && exception.Message.Contains("plan", StringComparison.OrdinalIgnoreCase);

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
