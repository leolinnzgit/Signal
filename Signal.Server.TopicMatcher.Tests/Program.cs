using System.Net;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Signal.Server.Data;
using Signal.Server.Models;
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
    ("https://www.theguardian.com/technology/rss", "https://www.theguardian.com/uk/technology/rss", true),
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

var validProfilePhoto = new byte[]
{
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x07, 0x08,
    0x02, 0x00,
    0x02, 0x00,
    0xff, 0xd9,
};
if (!ProfilePhotoValidator.IsValidJpeg(validProfilePhoto))
    throw new InvalidOperationException("Profile photo validation rejected a 512 by 512 JPEG.");

var wrongSizeProfilePhoto = validProfilePhoto.ToArray();
wrongSizeProfilePhoto[8] = 0x01;
if (ProfilePhotoValidator.IsValidJpeg(wrongSizeProfilePhoto))
    throw new InvalidOperationException("Profile photo validation accepted incorrect dimensions.");

var truncatedProfilePhoto = validProfilePhoto[..^2];
if (ProfilePhotoValidator.IsValidJpeg(truncatedProfilePhoto))
    throw new InvalidOperationException("Profile photo validation accepted a truncated JPEG.");

Console.WriteLine("Profile photo validation passed format and dimension checks.");

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

await using var historyConnection = new SqliteConnection("Data Source=:memory:");
await historyConnection.OpenAsync();
var historyOptions = new DbContextOptionsBuilder<SignalDbContext>()
    .UseSqlite(historyConnection)
    .Options;
await using (var historyDatabase = new SignalDbContext(historyOptions))
{
    await historyDatabase.Database.EnsureCreatedAsync();
    historyDatabase.Users.Add(new ApplicationUser
    {
        Id = "history-user",
        UserName = "history@example.com",
        NormalizedUserName = "HISTORY@EXAMPLE.COM",
        Email = "history@example.com",
        NormalizedEmail = "HISTORY@EXAMPLE.COM",
    });
    historyDatabase.StoredNewsArticles.AddRange(
        HistoryArticle("Technology policy changes", "The Guardian", "[\"Artificial intelligence\"]"),
        HistoryArticle("Weekend football results", "The Guardian", "[\"Sport\"]"),
        HistoryArticle("New AI research", "Science Daily", "[\"Artificial intelligence\"]", "[\"Google News\"]"));
    await historyDatabase.SaveChangesAsync();

    var guardianTechnology = await ArticleHistorySearch
        .Apply(historyDatabase.StoredNewsArticles.AsNoTracking(), "guardian technology")
        .Select(article => article.Title)
        .ToArrayAsync();
    if (guardianTechnology.Length != 1 || guardianTechnology[0] != "Technology policy changes")
        throw new InvalidOperationException("History search did not require all search terms across searchable fields.");

    var topicMatches = await ArticleHistorySearch
        .Apply(historyDatabase.StoredNewsArticles.AsNoTracking(), "artificial intelligence")
        .CountAsync();
    if (topicMatches != 2)
        throw new InvalidOperationException("History search did not match stored article topics.");

    var filteredMatches = await ArticleHistorySearch
        .ApplyFilters(
            historyDatabase.StoredNewsArticles.AsNoTracking(),
            "Artificial intelligence",
            "Google News")
        .Select(article => article.Title)
        .ToArrayAsync();
    if (filteredMatches.Length != 1 || filteredMatches[0] != "New AI research")
        throw new InvalidOperationException("History topic and source filters did not combine correctly.");
}

Console.WriteLine("Article history search and filters passed cross-field, topic and source checks.");

await using var scheduleConnection = new SqliteConnection("Data Source=:memory:");
await scheduleConnection.OpenAsync();
var scheduleOptions = new DbContextOptionsBuilder<SignalDbContext>()
    .UseSqlite(scheduleConnection)
    .Options;
await using (var scheduleDatabase = new SignalDbContext(scheduleOptions))
{
    await scheduleDatabase.Database.EnsureCreatedAsync();
    scheduleDatabase.Users.Add(new ApplicationUser
    {
        Id = "schedule-user",
        UserName = "schedule@example.com",
        NormalizedUserName = "SCHEDULE@EXAMPLE.COM",
        Email = "schedule@example.com",
        NormalizedEmail = "SCHEDULE@EXAMPLE.COM",
    });
    scheduleDatabase.UserNewsPreferences.Add(new UserNewsPreferences
    {
        UserId = "schedule-user",
        TopicsJson = "[\"Robots\",\"Solar\"]",
        StoryLimit = 20,
        RefreshMinutes = 60,
        GoogleEnabled = true,
        GdeltEnabled = false,
        RssFeedsJson = "[]",
    });
    scheduleDatabase.TopicRefreshStates.AddRange(
        new TopicRefreshState
        {
            UserId = "schedule-user",
            TopicKey = TopicRefreshService.NormalizeTopicKey("Robots"),
            Topic = "Robots",
            NextRefreshAtUtc = DateTime.UtcNow,
        },
        new TopicRefreshState
        {
            UserId = "schedule-user",
            TopicKey = TopicRefreshService.NormalizeTopicKey("Solar"),
            Topic = "Solar",
            NextRefreshAtUtc = DateTime.UtcNow.AddMinutes(30),
        });
    await scheduleDatabase.SaveChangesAsync();

    using var scheduleClient = new HttpClient(new FakeGoogleNewsHandler());
    var pushService = new PushNotificationService(
        scheduleDatabase,
        new VapidKeyStore(
            new TestWebHostEnvironment(),
            NullLogger<VapidKeyStore>.Instance),
        NullLogger<PushNotificationService>.Instance);
    var refreshService = new TopicRefreshService(
        scheduleDatabase,
        new NewsService(scheduleClient),
        new NullAccountEmailSender(),
        pushService,
        NullLogger<TopicRefreshService>.Instance);
    await refreshService.RefreshAsync("schedule-user", ["Robots"], false, CancellationToken.None);

    var robotState = await scheduleDatabase.TopicRefreshStates.SingleAsync(
        item => item.UserId == "schedule-user" && item.TopicKey == "ROBOTS");
    var solarState = await scheduleDatabase.TopicRefreshStates.SingleAsync(
        item => item.UserId == "schedule-user" && item.TopicKey == "SOLAR");
    if (robotState.LastSuccessfulAtUtc is null || robotState.NextRefreshAtUtc <= robotState.LastSuccessfulAtUtc)
        throw new InvalidOperationException("The refreshed topic did not receive its own successful next-refresh schedule.");
    if (solarState.LastAttemptedAtUtc is not null)
        throw new InvalidOperationException("Refreshing one topic incorrectly changed another topic's schedule.");

    var robotBriefing = await refreshService.LoadBriefingAsync(
        "schedule-user",
        CancellationToken.None,
        "Robots");
    if (robotBriefing.Articles.Length == 0
        || robotBriefing.Articles.Any(article =>
            !article.Topics.Contains("Robots", StringComparer.OrdinalIgnoreCase)))
    {
        throw new InvalidOperationException("A topic-specific Latest briefing returned stories from another topic.");
    }
}

Console.WriteLine("Per-topic refresh state and Latest filtering passed independent scheduling checks.");

static StoredNewsArticle HistoryArticle(
    string title,
    string source,
    string topicsJson,
    string providersJson = "[\"RSS\"]") => new()
{
    UserId = "history-user",
    Url = $"https://example.com/{Uri.EscapeDataString(title)}",
    Title = title,
    Source = source,
    PublishedAtUtc = DateTime.UtcNow,
    Summary = "",
    TopicsJson = topicsJson,
    ProvidersJson = providersJson,
    FirstSeenAtUtc = DateTime.UtcNow,
    LastSeenAtUtc = DateTime.UtcNow,
};

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

file sealed class FakeGoogleNewsHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        const string xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <rss>
              <channel>
                <item>
                  <title>Robots transform local manufacturing - Example News</title>
                  <source>Example News</source>
                  <link>https://example.com/robots</link>
                  <pubDate>Wed, 22 Jul 2026 01:00:00 GMT</pubDate>
                </item>
              </channel>
            </rss>
            """;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(xml, Encoding.UTF8, "text/xml"),
        });
    }
}

file sealed class NullAccountEmailSender : IAccountEmailSender
{
    public Task SendConfirmationAsync(string email, string confirmationUrl, CancellationToken cancellationToken) =>
        Task.CompletedTask;

    public Task SendPasswordResetAsync(string email, string resetUrl, CancellationToken cancellationToken) =>
        Task.CompletedTask;

    public Task SendNewsSummaryAsync(string email, NewsSummaryDigest digest, CancellationToken cancellationToken) =>
        Task.CompletedTask;
}

file sealed class TestWebHostEnvironment : IWebHostEnvironment
{
    public string ApplicationName { get; set; } = "Signal.Tests";

    public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();

    public string WebRootPath { get; set; } = Path.GetTempPath();

    public string EnvironmentName { get; set; } = "Development";

    public string ContentRootPath { get; set; } = Path.GetTempPath();

    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}
