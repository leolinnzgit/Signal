using System.Net;
using System.Text;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Signal.Server.Services;

var cases = new (string Text, string Topic, bool Expected)[]
{
    ("New Zealand economy faces a slower recovery", "New Zealand economy", true),
    ("Economy outlook improves across New Zealand", "New Zealand economy", true),
    ("New species discovered near Australia", "New Zealand economy", false),
    ("New AI regulation proposed for health systems", "AI regulation", true),
    ("Regulation changes affect local councils", "AI regulation", false),
    ("AI tools reshape software development", "AI", true),
    ("Painting exhibition opens downtown", "AI", false),
    ("UK election campaign enters its final week", "UK", true),
    ("Ukraine election reporting continues", "UK", false),
};

foreach (var (text, topic, expected) in cases)
{
    var actual = TopicMatcher.Matches(text, topic);
    if (actual != expected)
        throw new InvalidOperationException($"Expected '{topic}' against '{text}' to be {expected}, but got {actual}.");
}

Console.WriteLine($"Topic matcher passed {cases.Length} relevance checks.");

var feedCases = new (string Left, string Right, bool Equal)[]
{
    ("https://Example.com:443/feed/", "https://example.com/feed", true),
    ("https://example.com/feed?utm_source=newsletter", "https://example.com/feed", true),
    ("https://example.com/feed?b=2&a=1", "https://example.com/feed?a=1&b=2", true),
    ("https://example.com/feed?edition=nz", "https://example.com/feed?edition=au", false),
    ("https://example.com/feed", "https://example.com/other-feed", false),
};

foreach (var (left, right, equal) in feedCases)
{
    var actual = string.Equals(
        FeedUrlCanonicalizer.GetComparisonKey(left),
        FeedUrlCanonicalizer.GetComparisonKey(right),
        StringComparison.OrdinalIgnoreCase);
    if (actual != equal)
        throw new InvalidOperationException($"Expected feed URLs '{left}' and '{right}' equality to be {equal}, but got {actual}.");
}

if (FeedUrlCanonicalizer.NormalizeForStorage("https://example.com/feed?edition=nz&utm_campaign=test#latest")
    != "https://example.com/feed?edition=nz")
    throw new InvalidOperationException("Feed storage normalization did not remove tracking data.");

if (FeedUrlCanonicalizer.NormalizeForStorage("http://example.com/feed") is not null)
    throw new InvalidOperationException("Feed storage normalization accepted an insecure URL.");

Console.WriteLine($"Feed URL canonicalizer passed {feedCases.Length + 2} checks.");

var trendsHandler = new FakeGoogleTrendsHandler();
using var trendsClient = new HttpClient(trendsHandler);
using var trendsCache = new MemoryCache(new MemoryCacheOptions());
var trendsService = new GoogleTrendsService(
    trendsClient,
    trendsCache,
    NullLogger<GoogleTrendsService>.Instance);
var worldwideTrends = await trendsService.GetLatestAsync(CancellationToken.None);
if (worldwideTrends.Geo != "WORLD"
    || worldwideTrends.Terms.Count != 100
    || worldwideTrends.Terms.GroupBy(term => term.Region).Any(group => group.Count() != 5))
    throw new InvalidOperationException("Worldwide Google Trends did not return five balanced results per configured region.");

var requiredTrendRegions = new[]
{
    "United States",
    "Guyana",
    "United Kingdom",
    "Nigeria",
    "United Arab Emirates",
    "India",
    "China",
    "Taiwan",
    "Singapore",
    "Australia",
    "Fiji",
};
if (requiredTrendRegions.Except(worldwideTrends.Terms.Select(term => term.Region)).Any())
    throw new InvalidOperationException("Worldwide Google Trends is missing required English or Mandarin-speaking regions.");

await trendsService.GetLatestAsync(CancellationToken.None);
if (trendsHandler.RequestCount != 20)
    throw new InvalidOperationException("Worldwide Google Trends did not reuse its cached result.");

Console.WriteLine("Worldwide Google Trends passed region balance and cache checks.");

file sealed class FakeGoogleTrendsHandler : HttpMessageHandler
{
    public int RequestCount { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        RequestCount++;
        var code = request.RequestUri?.Query.Split('=').LastOrDefault() ?? "XX";
        var items = string.Join(
            Environment.NewLine,
            Enumerable.Range(1, 5).Select(rank => $"""
                <item>
                  <title>trend-{code}-{rank}</title>
                  <ht:approx_traffic>{rank}0K+</ht:approx_traffic>
                </item>
                """));
        var xml = $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <rss xmlns:ht="https://trends.google.com/trending/rss">
              <channel>
                {items}
              </channel>
            </rss>
            """;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(xml, Encoding.UTF8, "text/xml"),
        });
    }
}
