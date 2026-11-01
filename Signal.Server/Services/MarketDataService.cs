using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

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
            throw new MarketDataPlanRequiredException(
                match.Exchange.Equals("NZX", StringComparison.OrdinalIgnoreCase)
                    ? $"{qualifiedSymbol} is a valid NZX ticker, but NZX prices require a Twelve Data Pro or Venture plan."
                    : $"{qualifiedSymbol} is not available on the configured Twelve Data plan.",
                exception);
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
        exception.Message.Contains("available starting with the Pro or Venture plan", StringComparison.OrdinalIgnoreCase);

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
