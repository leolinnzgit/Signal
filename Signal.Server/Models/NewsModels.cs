using System.Globalization;
using System.Text.Json.Serialization;

namespace Signal.Server.Models;

public sealed record NewsDateRange(DateTimeOffset? From, DateTimeOffset? To)
{
    private static readonly DateTimeOffset MinimumDateUtc = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public bool HasBounds => From.HasValue || To.HasValue;

    public bool Contains(DateTimeOffset publishedAt)
    {
        var utc = publishedAt.ToUniversalTime();
        if (From.HasValue && utc < From.Value) return false;
        if (To.HasValue && utc > To.Value) return false;
        return true;
    }

    public static bool TryParse(
        string? rawFrom,
        string? rawTo,
        out NewsDateRange? range,
        out string? error,
        DateTimeOffset? utcNow = null)
    {
        var hasFrom = !string.IsNullOrWhiteSpace(rawFrom);
        var hasTo = !string.IsNullOrWhiteSpace(rawTo);
        if (!hasFrom && !hasTo)
        {
            range = null;
            error = null;
            return true;
        }

        DateTimeOffset? from = null;
        DateTimeOffset? to = null;

        if (hasFrom)
        {
            if (!TryParseBoundary(rawFrom!, "from", isEndOfDay: false, out var parsedFrom, out error))
            {
                range = null;
                return false;
            }
            from = parsedFrom;
        }

        if (hasTo)
        {
            if (!TryParseBoundary(rawTo!, "to", isEndOfDay: true, out var parsedTo, out error))
            {
                range = null;
                return false;
            }
            to = parsedTo;
        }

        if ((from.HasValue && from.Value < MinimumDateUtc) || (to.HasValue && to.Value < MinimumDateUtc))
        {
            range = null;
            error = "Dates must be on or after 2000-01-01.";
            return false;
        }

        var maxFrom = (utcNow ?? DateTimeOffset.UtcNow).AddDays(2);
        if (from.HasValue && from.Value > maxFrom)
        {
            range = null;
            error = "The start date (from) cannot be in the future.";
            return false;
        }

        if (from.HasValue && to.HasValue && from.Value > to.Value)
        {
            range = null;
            error = "The start date (from) must be earlier than or equal to the end date (to).";
            return false;
        }

        range = new NewsDateRange(from, to);
        error = null;
        return true;
    }

    private static bool TryParseBoundary(
        string raw,
        string name,
        bool isEndOfDay,
        out DateTimeOffset value,
        out string? error)
    {
        var trimmed = raw.Trim();
        if (trimmed.Length > 40)
        {
            value = default;
            error = $"Use YYYY-MM-DD or an ISO-8601 UTC timestamp for the '{name}' date parameter.";
            return false;
        }

        if (DateOnly.TryParseExact(trimmed, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dateOnly))
        {
            value = isEndOfDay
                ? new DateTimeOffset(dateOnly.Year, dateOnly.Month, dateOnly.Day, 23, 59, 59, 999, TimeSpan.Zero).AddTicks(9999)
                : new DateTimeOffset(dateOnly.Year, dateOnly.Month, dateOnly.Day, 0, 0, 0, TimeSpan.Zero);
            error = null;
            return true;
        }

        if (DateTimeOffset.TryParse(
                trimmed,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var parsed))
        {
            value = parsed.ToUniversalTime();
            error = null;
            return true;
        }

        value = default;
        error = $"Use YYYY-MM-DD or an ISO-8601 UTC timestamp for the '{name}' date parameter.";
        return false;
    }
}

public sealed record NewsArticle(
    string Title,
    string Url,
    string Source,
    DateTimeOffset PublishedAt,
    string Summary,
    IReadOnlyList<string>? MatchedTopics = null,
    string ImageUrl = "")
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? FullText { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ArticleMarketQuote[]? MarketQuotes { get; init; }
}

public sealed record NewsResult(
    string Topic,
    string Provider,
    DateTimeOffset FetchedAt,
    IReadOnlyList<NewsArticle> Articles,
    IReadOnlyList<string>? Topics = null,
    DateTimeOffset? From = null,
    DateTimeOffset? To = null);
