using System.Xml.Linq;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Services;

public sealed class GoogleTrendsService(HttpClient httpClient, IMemoryCache cache)
{
    private const string CacheKey = "google-trends-nz";
    private static readonly Uri FeedUri = new("https://trends.google.com/trending/rss?geo=NZ");

    public async Task<GoogleTrendsResult> GetLatestAsync(CancellationToken cancellationToken)
    {
        if (cache.TryGetValue(CacheKey, out GoogleTrendsResult? cached) && cached is not null)
            return cached;

        using var response = await httpClient.GetAsync(FeedUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var document = await XDocument.LoadAsync(stream, LoadOptions.None, cancellationToken);
        XNamespace trafficNamespace = "https://trends.google.com/trending/rss";
        var terms = document
            .Descendants("item")
            .Select(item => new GoogleTrendTerm(
                Normalize(item.Element("title")?.Value, 80),
                Normalize(item.Element(trafficNamespace + "approx_traffic")?.Value, 30)))
            .Where(item => item.Keyword.Length > 0)
            .DistinctBy(item => item.Keyword, StringComparer.OrdinalIgnoreCase)
            .Take(20)
            .ToArray();
        if (terms.Length == 0) throw new InvalidOperationException("Google Trends returned no current searches.");

        var result = new GoogleTrendsResult("NZ", DateTimeOffset.UtcNow, terms);
        cache.Set(CacheKey, result, TimeSpan.FromMinutes(15));
        return result;
    }

    private static string Normalize(string? value, int maximumLength)
    {
        var normalized = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, maximumLength)];
    }
}

public sealed record GoogleTrendsResult(
    string Geo,
    DateTimeOffset FetchedAt,
    IReadOnlyList<GoogleTrendTerm> Terms);

public sealed record GoogleTrendTerm(string Keyword, string Traffic);
