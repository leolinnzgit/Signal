using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Data;
using Signal.Server.Controllers;
using Signal.Server.Models;
using Signal.Server.Services;

await AzureSpeechChecks.RunAsync();
if (args.Contains("--azure-speech-only")) return;

if (args.Contains("--article-reader-browser"))
{
    await ArticleReaderChecks.RunBrowserAsync();
    return;
}
await ArticleReaderChecks.RunAsync();
if (args.Contains("--article-reader-only")) return;

await HeadlineAudioChecks.RunAsync();

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

var nzxTicker = MarketTickerParser.ParseOptional("air:xnze");
if (nzxTicker?.Symbol != "AIR"
    || nzxTicker.Exchange != "NZX"
    || nzxTicker.QualifiedSymbol != "AIR:NZX")
    throw new InvalidOperationException("NZX ticker parsing did not normalize the symbol and exchange.");
if (MarketTickerParser.TryParse("AIR:NZX:EXTRA", out _))
    throw new InvalidOperationException("Ticker parsing accepted more than one exchange qualifier.");
if (MarketTickerParser.ParseOptional("AAPL")?.QualifiedSymbol != "AAPL")
    throw new InvalidOperationException("Ticker parsing broke existing unqualified symbols.");

Console.WriteLine("Market ticker parsing passed NZX and existing-symbol checks.");

var marketHandler = new FakeMarketDataHandler();
using var marketClient = new HttpClient(marketHandler)
{
    BaseAddress = new Uri("https://api.twelvedata.com/"),
};
using var marketCache = new MemoryCache(new MemoryCacheOptions());
var marketService = new MarketDataService(
    marketClient,
    marketCache,
    Options.Create(new MarketDataOptions { ApiKey = "test-key" }));
var airNewZealandQuote = await marketService.GetForTopicAsync(
    "Air New Zealand",
    null,
    CancellationToken.None);
if (airNewZealandQuote?.Symbol != "AIR"
    || airNewZealandQuote.Exchange != "NZX"
    || airNewZealandQuote.Currency != "NZD"
    || marketHandler.LastRequestUri?.Query.Contains("symbol=AIR", StringComparison.Ordinal) != true
    || marketHandler.LastRequestUri.Query.Contains("exchange=NZX", StringComparison.Ordinal) != true)
    throw new InvalidOperationException("Air New Zealand did not request and return an NZX quote.");

Console.WriteLine("Market data service passed the NZX quote request check.");

var restrictedMarketHandler = new RestrictedMarketDataHandler();
using var restrictedMarketClient = new HttpClient(restrictedMarketHandler)
{
    BaseAddress = new Uri("https://api.twelvedata.com/"),
};
using var restrictedMarketCache = new MemoryCache(new MemoryCacheOptions());
var restrictedMarketService = new MarketDataService(
    restrictedMarketClient,
    restrictedMarketCache,
    Options.Create(new MarketDataOptions { ApiKey = "test-key" }));
try
{
    _ = await restrictedMarketService.GetForTopicAsync(
        "Contact Energy",
        "CEN:NZX",
        CancellationToken.None);
    throw new InvalidOperationException("A plan-restricted NZX quote did not report the provider requirement.");
}
catch (MarketDataPlanRequiredException exception)
{
    if (!exception.Message.Contains("CEN:NZX is a valid NZX ticker", StringComparison.Ordinal)
        || !exception.Message.Contains("Pro or Venture", StringComparison.Ordinal))
        throw new InvalidOperationException("The NZX plan restriction message was not clear.");
}

Console.WriteLine("Market data service passed the NZX provider-plan restriction check.");

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

var selectedTrends = await trendsService.GetLatestAsync(["NZ", "US"], 3, CancellationToken.None);
if (selectedTrends.TrendsPerRegion != 3
    || !selectedTrends.SelectedRegions.SequenceEqual(["US", "NZ"])
    || selectedTrends.Terms.Count != 6
    || selectedTrends.Terms.GroupBy(term => term.Region).Any(group => group.Count() != 3))
    throw new InvalidOperationException("Google Trends did not honour the selected regions and per-region count.");

await trendsService.GetLatestAsync(CancellationToken.None);
if (trendsHandler.RequestCount != 20)
    throw new InvalidOperationException("Worldwide Google Trends did not reuse its cached result.");

Console.WriteLine("Worldwide Google Trends passed region balance and cache checks.");

var redirectHandler = new FakeArticleRedirectHandler();
using var readerClient = new HttpClient(redirectHandler);
using var readerCache = new MemoryCache(new MemoryCacheOptions());
var readerService = new ArticleReaderService(
    readerClient,
    readerCache,
    NullLogger<ArticleReaderService>.Instance);
const string wrappedArticleUrl = "https://93.184.216.34/news/story";
const string publisherArticleUrl = "https://93.184.216.34/publisher/story";
var resolvedArticleUrl = await readerService.ResolveUrlAsync(wrappedArticleUrl, CancellationToken.None);
if (resolvedArticleUrl != publisherArticleUrl)
    throw new InvalidOperationException("Article URL resolution did not follow the publisher redirect.");

await readerService.ResolveUrlAsync(wrappedArticleUrl, CancellationToken.None);
if (redirectHandler.RequestCount != 2)
    throw new InvalidOperationException("Article URL resolution did not reuse its cached result.");

Console.WriteLine("Article sharing URL resolution passed redirect and cache checks.");

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

if (!new UserNewsPreferences().PushNewsTitlesEnabled || !NewsPreferencesResponse.Default.PushNewsTitlesEnabled)
    throw new InvalidOperationException("News titles must be enabled by default for new accounts.");
var oldPreferencesRequest = JsonSerializer.Deserialize<NewsPreferencesRequest>("""
    {"Topics":[],"Sources":{"Google":true,"Gdelt":true,"RssFeeds":[]}}
    """);
if (oldPreferencesRequest?.PushNewsTitlesEnabled is not null)
    throw new InvalidOperationException("Older clients must not overwrite the saved news title preference.");

var notificationStories = new[]
{
    new StoredNewsArticle { Id = 101, Title = "Robots learn a new skill", Source = "Robot News", Summary = "Researchers  taught robots\n to sort household items." },
    new StoredNewsArticle { Id = 102, Title = "Solar output rises", Source = "Energy News" },
};
var headlineMessages = PushNotificationService.BuildNewsMessages(
    ["Robots", "Solar"], [.. notificationStories, notificationStories[0]], true, 2);
if (headlineMessages.Length != 2
    || headlineMessages[0].Title != notificationStories[0].Title
    || headlineMessages[1].Title != notificationStories[1].Title
    || headlineMessages[0].Body != "Robot News\nResearchers taught robots to sort household items."
    || headlineMessages[1].Body != "Energy News"
    || headlineMessages.Select(message => message.Tag).Distinct().Count() != 2
    || headlineMessages.Any(message => message.BadgeCount != 2 || message.Url != "/#top"))
    throw new InvalidOperationException("Headline notifications lost titles, publisher, distinct tags or topic badge counts.");
var summaryMessages = PushNotificationService.BuildNewsMessages(["Robots"], notificationStories, false, 1);
if (summaryMessages.Length != 1
    || summaryMessages[0].Title != "New stories about Robots"
    || summaryMessages[0].Body != "Fresh coverage is available for Robots."
    || summaryMessages[0].Tag != "signal-new-stories")
    throw new InvalidOperationException("Disabling news titles did not retain topic summary notifications.");
if (PushNotificationService.BuildNewsMessages(["Robots"], [], true, 1).Length != 0)
    throw new InvalidOperationException("Headline mode sent a notification without a new story.");
var largeMessage = PushNotificationService.BuildNewsMessages(["Robots"],
    [new StoredNewsArticle { Id = long.MaxValue, Title = new string('新', 500), Source = new string('聞', 256), Summary = new string('文', 4000) }], true, 100)[0];
var largePayload = PushNotificationService.SerializeMessage(largeMessage);
if (Encoding.UTF8.GetByteCount(largePayload) > 3993
    || JsonDocument.Parse(largePayload).RootElement.GetProperty("title").GetString() != new string('新', 500)
    || !largeMessage.Body.Contains("\n文", StringComparison.Ordinal)
    || !largeMessage.Body.EndsWith('…'))
    throw new InvalidOperationException("A maximum-length Unicode headline exceeded the Web Push payload budget or lost its title.");

var longSummaryMessage = PushNotificationService.BuildNewsMessages([], [new StoredNewsArticle
{
    Id = 103, Title = "Headline", Source = "Publisher", Summary = string.Concat(Enumerable.Repeat("A short sentence. ", 40)),
}], true, 1)[0];
var shortSummary = longSummaryMessage.Body.Split('\n')[1];
if (shortSummary.Length > 180 || !shortSummary.EndsWith("A short…", StringComparison.Ordinal))
    throw new InvalidOperationException("A long news summary was not shortened at a word boundary with an ellipsis.");
var emojiSummaryMessage = PushNotificationService.BuildNewsMessages([], [new StoredNewsArticle
{
    Id = 104, Title = "Headline", Summary = new string('a', 178) + "🌞 extra text",
}], true, 1)[0];
var emojiSummary = emojiSummaryMessage.Body.Split('\n')[1];
if (emojiSummary != new string('a', 178) + "…")
    throw new InvalidOperationException("Truncating a news preview split an emoji surrogate pair.");
var blankSummaryMessage = PushNotificationService.BuildNewsMessages([], [new StoredNewsArticle
{
    Id = 105, Title = "Headline", Source = "Publisher", Summary = " \n\t ",
}], true, 1)[0];
if (blankSummaryMessage.Body != "Publisher")
    throw new InvalidOperationException("A blank news summary left an empty notification preview line.");

Console.WriteLine("News notification titles, previews, summary mode, defaults and payload size checks passed.");

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
    var storedPreference = await scheduleDatabase.UserNewsPreferences.SingleAsync();
    storedPreference.PushNewsTitlesEnabled = false;
    await scheduleDatabase.SaveChangesAsync();
    if (await scheduleDatabase.UserNewsPreferences.AsNoTracking().Select(item => item.PushNewsTitlesEnabled).SingleAsync())
        throw new InvalidOperationException("The disabled news-title preference did not persist.");

    var storedArticle = new TopicBriefingArticle("New headline", "https://example.com/new-headline", "Publisher",
        DateTimeOffset.UtcNow, "", "", ["Robots", "Solar"], ["Google News"], false, false);
    var firstStored = await refreshService.StoreArticlesAsync("schedule-user", [storedArticle, storedArticle], DateTime.UtcNow, CancellationToken.None);
    if (firstStored.NewArticles.Count != 1 || firstStored.NewArticles[0].Id <= 0 || firstStored.TopicKeys.Count != 2)
        throw new InvalidOperationException("A new story matched to multiple topics was not deduplicated for notifications.");
    var repeatedStored = await refreshService.StoreArticlesAsync("schedule-user", [storedArticle], DateTime.UtcNow, CancellationToken.None);
    if (repeatedStored.NewArticles.Count != 0 || repeatedStored.TopicKeys.Count != 0)
        throw new InvalidOperationException("Refreshing existing stories produced duplicate notifications.");
    var newTopicStored = await refreshService.StoreArticlesAsync("schedule-user", [storedArticle with { Topics = ["Robots", "Solar", "Energy"] }], DateTime.UtcNow, CancellationToken.None);
    if (newTopicStored.NewArticles.Count != 0 || !newTopicStored.TopicKeys.SetEquals(["ENERGY"]))
        throw new InvalidOperationException("Adding a topic to an existing story repeated its headline notification.");
    await refreshService.RefreshAsync("schedule-user", ["Robots"], false, CancellationToken.None);

    var robotState = await scheduleDatabase.TopicRefreshStates.SingleAsync(
        item => item.UserId == "schedule-user" && item.TopicKey == "ROBOTS");
    var solarState = await scheduleDatabase.TopicRefreshStates.SingleAsync(
        item => item.UserId == "schedule-user" && item.TopicKey == "SOLAR");
    if (robotState.LastSuccessfulAtUtc is null || robotState.NextRefreshAtUtc <= robotState.LastSuccessfulAtUtc)
        throw new InvalidOperationException("The refreshed topic did not receive its own successful next-refresh schedule.");
    if (solarState.LastAttemptedAtUtc is not null)
        throw new InvalidOperationException("Refreshing one topic incorrectly changed another topic's schedule.");

    if (robotState.LatestContentVersion <= robotState.ViewedContentVersion)
        throw new InvalidOperationException("A refresh with new topic stories did not advance the server unread cursor.");

    // The version cursor, rather than the legacy Boolean, is authoritative across devices.
    robotState.HasUnread = false;
    await scheduleDatabase.SaveChangesAsync();

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
    if (!robotBriefing.Topics.Single(item => item.Topic == "Robots").HasUnread)
        throw new InvalidOperationException("The briefing did not derive unread state from the server cursor.");

    if (!await refreshService.MarkTopicViewedAsync("schedule-user", "Robots", CancellationToken.None))
        throw new InvalidOperationException("The topic could not be marked viewed.");
    await scheduleDatabase.Entry(robotState).ReloadAsync();
    if (robotState.ViewedContentVersion != robotState.LatestContentVersion)
        throw new InvalidOperationException("Viewing a topic did not advance its cursor to the latest server version.");

    var secondDeviceBriefing = await refreshService.LoadBriefingAsync(
        "schedule-user",
        CancellationToken.None,
        "Robots");
    if (secondDeviceBriefing.Topics.Single(item => item.Topic == "Robots").HasUnread)
        throw new InvalidOperationException("A second device still received the topic as unread after it was viewed.");
}

Console.WriteLine("Per-topic refresh state, cross-device unread cursors and Latest filtering passed independent scheduling checks.");

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

file sealed class FakeMarketDataHandler : HttpMessageHandler
{
    public Uri? LastRequestUri { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        LastRequestUri = request.RequestUri;
        const string json = """
            {
              "symbol": "AIR",
              "name": "Air New Zealand Limited",
              "exchange": "NZX",
              "currency": "NZD",
              "datetime": "2026-08-02",
              "close": "0.62",
              "change": "0.01",
              "percent_change": "1.64",
              "is_market_open": false
            }
            """;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        });
    }
}

file sealed class RestrictedMarketDataHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        const string json = """
            {
              "code": 404,
              "message": "This symbol is available starting with the Pro or Venture plan.",
              "status": "error"
            }
            """;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
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

file sealed class FakeArticleRedirectHandler : HttpMessageHandler
{
    public int RequestCount { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        RequestCount++;
        if (request.RequestUri?.AbsolutePath == "/news/story")
        {
            var redirect = new HttpResponseMessage(HttpStatusCode.Redirect);
            redirect.Headers.Location = new Uri("/publisher/story", UriKind.Relative);
            return Task.FromResult(redirect);
        }

        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
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

    public Task SendSharedArticleAsync(
        string email,
        SharedArticleEmail sharedArticle,
        CancellationToken cancellationToken) => Task.CompletedTask;
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
