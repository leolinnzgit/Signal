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
    string Provider);

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
            ["Google"] = "GOOGL",
            ["IBM"] = "IBM",
            ["Intel"] = "INTC",
            ["Meta"] = "META",
            ["Microsoft"] = "MSFT",
            ["Netflix"] = "NFLX",
            ["NVIDIA"] = "NVDA",
            ["Oracle"] = "ORCL",
            ["Palantir"] = "PLTR",
            ["Salesforce"] = "CRM",
            ["Taiwan Semiconductor"] = "TSM",
            ["Tesla"] = "TSLA",
            ["TSMC"] = "TSM",
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

    public async Task<MarketQuote?> GetForTopicAsync(string requestedTopic, CancellationToken cancellationToken)
    {
        var topic = NormalizeDisplayText(requestedTopic, 80);
        if (topic.Length == 0) throw new ArgumentException("Choose a topic.");
        if (string.IsNullOrWhiteSpace(options.Value.ApiKey)) throw new MarketDataNotConfiguredException();

        var match = await FindMatchAsync(topic, cancellationToken);
        if (match is null) return null;

        var quoteCacheKey = $"market-quote:{match.Symbol}:{match.Exchange}".ToLowerInvariant();
        if (cache.TryGetValue(quoteCacheKey, out MarketQuote? cachedQuote) && cachedQuote is not null)
            return cachedQuote with { Topic = topic };

        var quote = await RequestQuoteAsync(topic, match, cancellationToken);
        cache.Set(quoteCacheKey, quote, TimeSpan.FromMinutes(2));
        return quote;
    }

    private async Task<StockMatch?> FindMatchAsync(string topic, CancellationToken cancellationToken)
    {
        if (KnownSymbols.TryGetValue(topic, out var knownSymbol))
            return new StockMatch(knownSymbol, "", "");

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
