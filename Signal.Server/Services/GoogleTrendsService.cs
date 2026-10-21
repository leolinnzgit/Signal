using System.Xml.Linq;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Services;

public sealed class GoogleTrendsService(
    HttpClient httpClient,
    IMemoryCache cache,
    ILogger<GoogleTrendsService> logger)
{
    public const int DefaultTrendsPerRegion = 5;
    public const int MaximumTrendsPerRegion = 10;
    private static readonly GoogleTrendRegion[] Regions =
    [
        new("US", "United States"),
        new("CA", "Canada"),
        new("JM", "Jamaica"),
        new("GY", "Guyana"),
        new("GB", "United Kingdom"),
        new("IE", "Ireland"),
        new("NG", "Nigeria"),
        new("ZA", "South Africa"),
        new("KE", "Kenya"),
        new("AE", "United Arab Emirates"),
        new("IN", "India"),
        new("PH", "Philippines"),
        new("MY", "Malaysia"),
        new("SG", "Singapore"),
        new("CN", "China"),
        new("TW", "Taiwan"),
        new("HK", "Hong Kong"),
        new("AU", "Australia"),
        new("NZ", "New Zealand"),
        new("FJ", "Fiji"),
    ];

    public static IReadOnlyList<GoogleTrendRegion> AvailableRegions { get; } =
        Array.AsReadOnly(Regions);

    public Task<GoogleTrendsResult> GetLatestAsync(CancellationToken cancellationToken) =>
        GetLatestAsync(null, DefaultTrendsPerRegion, cancellationToken);

    public async Task<GoogleTrendsResult> GetLatestAsync(
        IEnumerable<string>? regionCodes,
        int trendsPerRegion,
        CancellationToken cancellationToken)
    {
        var requestedCodes = regionCodes?
            .Where(code => !string.IsNullOrWhiteSpace(code))
            .Select(code => code.Trim().ToUpperInvariant())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var selectedRegions = requestedCodes is null
            ? Regions
            : Regions.Where(region => requestedCodes.Contains(region.Code)).ToArray();
        if (selectedRegions.Length == 0)
            throw new ArgumentException("Choose at least one supported Google Trends region.", nameof(regionCodes));

        trendsPerRegion = Math.Clamp(trendsPerRegion, 1, MaximumTrendsPerRegion);

        var regionalResults = await Task.WhenAll(
            selectedRegions.Select(region => GetRegionAsync(region, cancellationToken)));
        var availableResults = regionalResults.Where(result => result.Terms.Length > 0).ToArray();
        if (availableResults.Length == 0)
            throw new InvalidOperationException("Google Trends returned no current searches.");

        var terms = SelectWorldwideTerms(availableResults, trendsPerRegion);
        return new GoogleTrendsResult(
            "WORLD",
            DateTimeOffset.UtcNow,
            terms,
            AvailableRegions,
            selectedRegions.Select(region => region.Code).ToArray(),
            trendsPerRegion);
    }

    private async Task<RegionalTrends> GetRegionAsync(
        GoogleTrendRegion region,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"google-trends-region-v3:{region.Code}";
        if (cache.TryGetValue(cacheKey, out RegionalTrends? cached) && cached is not null)
            return cached;

        try
        {
            var feedUri = new Uri($"https://trends.google.com/trending/rss?geo={region.Code}");
            using var response = await httpClient.GetAsync(
                feedUri,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            var document = await XDocument.LoadAsync(stream, LoadOptions.None, cancellationToken);
            var result = new RegionalTrends(region, ParseTerms(document, region.Name));
            cache.Set(cacheKey, result, TimeSpan.FromMinutes(15));
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Google Trends region {Region} was unavailable.", region.Code);
            return new RegionalTrends(region, []);
        }
    }

    private static GoogleTrendTerm[] ParseTerms(XDocument document, string regionName)
    {
        XNamespace trafficNamespace = "https://trends.google.com/trending/rss";
        return document
            .Descendants("item")
            .Select(item => new GoogleTrendTerm(
                Normalize(item.Element("title")?.Value, 80),
                Normalize(item.Element(trafficNamespace + "approx_traffic")?.Value, 30),
                regionName))
            .Where(item => item.Keyword.Length > 0)
            .DistinctBy(item => item.Keyword, StringComparer.OrdinalIgnoreCase)
            .Take(20)
            .ToArray();
    }

    private static GoogleTrendTerm[] SelectWorldwideTerms(
        RegionalTrends[] regionalResults,
        int maximumPerRegion)
    {
        var selected = new List<GoogleTrendTerm>(regionalResults.Length * maximumPerRegion);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var rank = 0; rank < maximumPerRegion; rank++)
        {
            foreach (var regionalResult in regionalResults)
            {
                if (rank >= regionalResult.Terms.Length) continue;
                var term = regionalResult.Terms[rank];
                if (!seen.Add(term.Keyword)) continue;
                selected.Add(term);
            }
        }
        return selected.ToArray();
    }

    private static string Normalize(string? value, int maximumLength)
    {
        var normalized = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, maximumLength)];
    }

    private sealed record RegionalTrends(GoogleTrendRegion Region, GoogleTrendTerm[] Terms);
}

public sealed record GoogleTrendsResult(
    string Geo,
    DateTimeOffset FetchedAt,
    IReadOnlyList<GoogleTrendTerm> Terms,
    IReadOnlyList<GoogleTrendRegion> AvailableRegions,
    IReadOnlyList<string> SelectedRegions,
    int TrendsPerRegion);

public sealed record GoogleTrendTerm(string Keyword, string Traffic, string Region);

public sealed record GoogleTrendRegion(string Code, string Name);
