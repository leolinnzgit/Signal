using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/preferences")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class PreferencesController(
    SignalDbContext database,
    UserManager<ApplicationUser> userManager,
    NewsService newsService,
    ILogger<PreferencesController> logger) : ControllerBase
{
    private static readonly int[] AllowedRefreshMinutes = [0, 5, 15, 30, 60, 120, 180, 240, 300, 360, 420, 480];
    private static readonly int[] AllowedRetentionDays = [1, 7, 14, 30, 90, 180, 365];

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        return Ok(new PreferencesEnvelope(
            preferences is not null,
            preferences is null ? NewsPreferencesResponse.Default : ToResponse(preferences)));
    }

    [HttpPost]
    public async Task<IActionResult> Save(
        NewsPreferencesRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (!AllowedRefreshMinutes.Contains(request.RefreshMinutes))
            return BadRequest(new { error = "Choose a supported refresh interval." });

        var topics = NormalizeTopics(request.Topics);
        var rssFeeds = NormalizeRssFeeds(request.Sources.RssFeeds);
        var preferences = await database.UserNewsPreferences
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        var topicsJson = JsonSerializer.Serialize(topics);
        var rssFeedsJson = JsonSerializer.Serialize(rssFeeds);
        var tickerOverrides = NormalizeTickerOverrides(request.TickerOverrides, topics);
        var tickerOverridesJson = JsonSerializer.Serialize(tickerOverrides);
        var weatherLocation = NormalizeWeatherLocation(request.WeatherLocation);
        var weatherLocationJson = weatherLocation is null ? "{}" : JsonSerializer.Serialize(weatherLocation);
        var secondaryTimeZone = NormalizeSecondaryTimeZone(request.SecondaryTimeZone);
        var secondaryTimeZoneJson = secondaryTimeZone is null ? "{}" : JsonSerializer.Serialize(secondaryTimeZone);
        var trendRegions = NormalizeTrendRegions(request.TrendRegions);
        var trendRegionsJson = JsonSerializer.Serialize(trendRegions);
        var storyLimit = NormalizeStoryLimit(request.Limit);
        var forceRefresh = preferences is null
            || preferences.StoryLimit != storyLimit
            || preferences.GoogleEnabled != request.Sources.Google
            || preferences.GdeltEnabled != request.Sources.Gdelt
            || !string.Equals(preferences.RssFeedsJson, rssFeedsJson, StringComparison.Ordinal);
        var intervalChanged = preferences is null || preferences.RefreshMinutes != request.RefreshMinutes;

        if (preferences is null)
        {
            preferences = new UserNewsPreferences { UserId = userId };
            database.UserNewsPreferences.Add(preferences);
        }

        preferences.TopicsJson = topicsJson;
        preferences.StoryLimit = storyLimit;
        preferences.StoryTitleSize = NormalizeStoryTitleSize(request.StoryTitleSize);
        preferences.TopicHeaderSize = NormalizeStoryTitleSize(request.TopicHeaderSize);
        preferences.ShowTopicFiltersWhenPinned = request.ShowTopicFiltersWhenPinned ?? preferences.ShowTopicFiltersWhenPinned;
        preferences.ShowSourceFiltersWhenPinned = request.ShowSourceFiltersWhenPinned ?? preferences.ShowSourceFiltersWhenPinned;
        preferences.RefreshMinutes = request.RefreshMinutes;
        preferences.EmailSummaryEnabled = request.EmailSummaryEnabled;
        preferences.PushNewsTitlesEnabled = request.PushNewsTitlesEnabled ?? preferences.PushNewsTitlesEnabled;
        preferences.ArticleRetentionDays = NormalizeRetentionDays(request.ArticleRetentionDays);
        preferences.GoogleEnabled = request.Sources.Google;
        preferences.GdeltEnabled = request.Sources.Gdelt;
        preferences.RssFeedsJson = rssFeedsJson;
        preferences.TickerOverridesJson = tickerOverridesJson;
        preferences.WeatherLocationJson = weatherLocationJson;
        preferences.SecondaryTimeZoneJson = secondaryTimeZoneJson;
        preferences.TrendRegionsJson = trendRegionsJson;
        preferences.TrendsPerRegion = NormalizeTrendsPerRegion(request.TrendsPerRegion);
        var requestOrigin = Request?.Host.HasValue == true
            ? $"{Request.Scheme}://{Request.Host}{Request.PathBase}"
            : null;
        var mergedBriefing = ExecutiveBriefingDeliveryService.MergePatch(
            ExecutiveBriefingDeliveryService.Deserialize(preferences.BriefingPreferencesJson),
            request.BriefingPreferences,
            weatherLocation?.Timezone,
            requestOrigin);
        preferences.BriefingPreferencesJson = JsonSerializer.Serialize(mergedBriefing);
        if (request.MarketPortfolio is not null)
        {
            var marketPortfolio = NormalizeMarketPortfolio(request.MarketPortfolio);
            preferences.MarketPortfolioJson = JsonSerializer.Serialize(marketPortfolio);
        }
        preferences.UpdatedAtUtc = DateTimeOffset.UtcNow;

        await SyncTopicRefreshStatesAsync(
            userId,
            topics,
            request.RefreshMinutes,
            forceRefresh,
            intervalChanged,
            cancellationToken);
        await database.SaveChangesAsync(cancellationToken);
        var retentionCutoff = DateTime.UtcNow.AddDays(-preferences.ArticleRetentionDays);
        var expiredArticles = await database.StoredNewsArticles
            .Where(item => item.UserId == userId && !item.IsBookmarked && item.LastSeenAtUtc < retentionCutoff)
            .ToArrayAsync(cancellationToken);
        if (expiredArticles.Length > 0)
        {
            database.StoredNewsArticles.RemoveRange(expiredArticles);
            await database.SaveChangesAsync(cancellationToken);
        }
        return Ok(new PreferencesEnvelope(true, ToResponse(preferences)));
    }

    [HttpPost("rss-feed")]
    public async Task<IActionResult> ResolveRssFeed(
        ResolveRssFeedRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        using var validationTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        validationTimeout.CancelAfter(TimeSpan.FromSeconds(8));
        try
        {
            var candidate = await newsService.ResolvePublisherFeedUrlAsync(request.Feed, validationTimeout.Token);
            var existing = NormalizeRssFeeds(request.ExistingFeeds);
            var feeds = new List<string>(existing.Length + 1);
            var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var feed in existing)
            {
                var key = FeedUrlCanonicalizer.GetComparisonKey(feed);
                if (key is not null && keys.Add(key)) feeds.Add(feed);
            }

            var candidateKey = FeedUrlCanonicalizer.GetComparisonKey(candidate)!;
            var duplicateOf = feeds.FirstOrDefault(feed =>
                string.Equals(
                    FeedUrlCanonicalizer.GetComparisonKey(feed),
                    candidateKey,
                    StringComparison.OrdinalIgnoreCase));
            if (duplicateOf is not null)
                return Ok(new ResolveRssFeedResponse(candidate, false, duplicateOf, feeds.ToArray()));
            if (feeds.Count >= 30)
                return BadRequest(new { error = "You can add up to 30 publisher feeds." });

            feeds.Add(candidate);
            return Ok(new ResolveRssFeedResponse(candidate, true, null, feeds.ToArray()));
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return StatusCode(
                StatusCodes.Status504GatewayTimeout,
                new { error = "That publisher feed took too long to respond. Please try again." });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Publisher feed validation failed.");
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "That publisher feed could not be reached right now." });
        }
    }

    public sealed record OpmlImportRequest(string? OpmlXml);
    public sealed record OpmlImportResponse(
        int Imported,
        int Duplicates,
        int TotalFeeds,
        string[] Feeds,
        string[] Skipped);

    public sealed record SourceDiagnosticsRequest(string[]? Feeds);
    public sealed record SourceDiagnosticsResponse(NewsService.FeedDiagnosticResult[] Results);

    [HttpPost("opml/import")]
    [RequestSizeLimit(524_288)]
    public async Task<IActionResult> ImportOpml(
        [FromBody] OpmlImportRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var xml = request?.OpmlXml;
        if (string.IsNullOrWhiteSpace(xml))
        {
            return BadRequest(new { error = "OPML content is empty or missing." });
        }

        XDocument doc;
        try
        {
            doc = XDocument.Parse(xml, LoadOptions.None);
        }
        catch
        {
            return BadRequest(new { error = "Invalid OPML XML format." });
        }

        var outlines = doc.Descendants().Where(e => e.Name.LocalName == "outline");
        var extractedUrls = new List<string>();
        foreach (var outline in outlines)
        {
            var rawUrl = outline.Attribute("xmlUrl")?.Value
                ?? outline.Attribute("xmlurl")?.Value
                ?? outline.Attribute("url")?.Value;

            if (!string.IsNullOrWhiteSpace(rawUrl))
            {
                var normalized = FeedUrlCanonicalizer.NormalizeForStorage(rawUrl.Trim());
                if (normalized is not null)
                {
                    extractedUrls.Add(normalized);
                }
            }
        }

        if (extractedUrls.Count == 0)
        {
            return BadRequest(new { error = "No RSS feeds found in the uploaded OPML file." });
        }

        var preferences = await database.UserNewsPreferences
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        if (preferences is null)
        {
            preferences = new UserNewsPreferences { UserId = userId };
            database.UserNewsPreferences.Add(preferences);
        }

        var existingFeeds = DeserializeList(preferences.RssFeedsJson);
        var existingKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var currentFeedList = new List<string>(existingFeeds.Length);

        foreach (var f in existingFeeds)
        {
            var key = FeedUrlCanonicalizer.GetComparisonKey(f);
            if (key is not null && existingKeys.Add(key))
            {
                currentFeedList.Add(f);
            }
        }

        var importedCount = 0;
        var duplicateCount = 0;
        var skipped = new List<string>();

        foreach (var candidate in extractedUrls)
        {
            var key = FeedUrlCanonicalizer.GetComparisonKey(candidate);
            if (key is null)
            {
                skipped.Add(candidate);
                continue;
            }

            if (existingKeys.Contains(key))
            {
                duplicateCount++;
                continue;
            }

            if (currentFeedList.Count >= 30)
            {
                skipped.Add(candidate);
                continue;
            }

            existingKeys.Add(key);
            currentFeedList.Add(candidate);
            importedCount++;
        }

        preferences.RssFeedsJson = JsonSerializer.Serialize(currentFeedList);
        await database.SaveChangesAsync(cancellationToken);

        return Ok(new OpmlImportResponse(
            importedCount,
            duplicateCount,
            currentFeedList.Count,
            currentFeedList.ToArray(),
            skipped.ToArray()));
    }

    [HttpGet("opml/export")]
    public async Task<IActionResult> ExportOpml(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        var feeds = preferences is null ? [] : DeserializeList(preferences.RssFeedsJson);

        var outlines = feeds.Select(feed =>
        {
            var title = ExtractHostName(feed);
            return new XElement("outline",
                new XAttribute("type", "rss"),
                new XAttribute("text", title),
                new XAttribute("title", title),
                new XAttribute("xmlUrl", feed),
                new XAttribute("htmlUrl", feed));
        });

        var doc = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement("opml",
                new XAttribute("version", "2.0"),
                new XElement("head",
                    new XElement("title", "Signal RSS Subscriptions"),
                    new XElement("dateCreated", DateTime.UtcNow.ToString("R")),
                    new XElement("docs", "http://opml.org/spec2.opml")),
                new XElement("body",
                    new XElement("outline",
                        new XAttribute("text", "Signal Subscriptions"),
                        new XAttribute("title", "Signal Subscriptions"),
                        outlines))));

        var bytes = System.Text.Encoding.UTF8.GetBytes(doc.ToString());
        return File(bytes, "application/xml; charset=utf-8", "signal-subscriptions.opml");
    }

    [HttpPost("sources/diagnostics")]
    public async Task<IActionResult> RunDiagnostics(
        [FromBody] SourceDiagnosticsRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        string[] feedUrls;
        if (request?.Feeds is not null && request.Feeds.Length > 0)
        {
            feedUrls = request.Feeds.Take(30).ToArray();
        }
        else
        {
            var preferences = await database.UserNewsPreferences
                .AsNoTracking()
                .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
            feedUrls = preferences is null ? [] : DeserializeList(preferences.RssFeedsJson);
        }

        var results = new List<NewsService.FeedDiagnosticResult>();
        foreach (var url in feedUrls)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(6));
            var diag = await newsService.DiagnosePublisherFeedAsync(url, timeoutCts.Token);
            results.Add(diag);
        }

        return Ok(new SourceDiagnosticsResponse(results.ToArray()));
    }

    public sealed record KeywordRulesDto(
        string[] WatchKeywords,
        string[] MutedKeywords,
        string NoiseCancellationLevel);

    [HttpGet("keyword-rules")]
    public async Task<IActionResult> GetKeywordRules(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        if (preferences is null || string.IsNullOrWhiteSpace(preferences.BriefingPreferencesJson))
        {
            return Ok(new KeywordRulesDto([], ["gossip", "celebrity", "rumor", "tabloid"], "moderate"));
        }

        try
        {
            using var doc = JsonDocument.Parse(preferences.BriefingPreferencesJson);
            var root = doc.RootElement;
            var watch = root.TryGetProperty("watchKeywords", out var wEl) && wEl.ValueKind == JsonValueKind.Array
                ? wEl.EnumerateArray().Select(x => x.GetString() ?? "").Where(s => !string.IsNullOrWhiteSpace(s)).ToArray()
                : [];
            var muted = root.TryGetProperty("mutedKeywords", out var mEl) && mEl.ValueKind == JsonValueKind.Array
                ? mEl.EnumerateArray().Select(x => x.GetString() ?? "").Where(s => !string.IsNullOrWhiteSpace(s)).ToArray()
                : ["gossip", "celebrity", "rumor", "tabloid"];
            var level = root.TryGetProperty("noiseCancellationLevel", out var lEl) && lEl.ValueKind == JsonValueKind.String
                ? lEl.GetString() ?? "moderate"
                : "moderate";

            return Ok(new KeywordRulesDto(watch, muted, level));
        }
        catch
        {
            return Ok(new KeywordRulesDto([], ["gossip", "celebrity", "rumor", "tabloid"], "moderate"));
        }
    }

    [HttpPost("keyword-rules")]
    public async Task<IActionResult> SaveKeywordRules(
        [FromBody] KeywordRulesDto? request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var preferences = await database.UserNewsPreferences
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        if (preferences is null)
        {
            preferences = new UserNewsPreferences { UserId = userId };
            database.UserNewsPreferences.Add(preferences);
        }

        var watch = (request?.WatchKeywords ?? [])
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim().ToLowerInvariant())
            .Distinct()
            .Take(50)
            .ToArray();

        var muted = (request?.MutedKeywords ?? [])
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim().ToLowerInvariant())
            .Distinct()
            .Take(50)
            .ToArray();

        var level = request?.NoiseCancellationLevel?.ToLowerInvariant() is "off" or "strict"
            ? request.NoiseCancellationLevel.ToLowerInvariant()
            : "moderate";

        Dictionary<string, object> dict;
        try
        {
            dict = JsonSerializer.Deserialize<Dictionary<string, object>>(preferences.BriefingPreferencesJson) ?? [];
        }
        catch
        {
            dict = [];
        }

        dict["watchKeywords"] = watch;
        dict["mutedKeywords"] = muted;
        dict["noiseCancellationLevel"] = level;

        preferences.BriefingPreferencesJson = JsonSerializer.Serialize(dict);
        await database.SaveChangesAsync(cancellationToken);

        return Ok(new KeywordRulesDto(watch, muted, level));
    }

    private static string ExtractHostName(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var host = uri.Host;
            if (host.StartsWith("www.", StringComparison.OrdinalIgnoreCase)) host = host[4..];
            return host;
        }
        return "Publisher Feed";
    }

    private static string[] NormalizeTopics(IEnumerable<string> values) => values
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)))
        .Select(value => value[..Math.Min(value.Length, 80)])
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static string[] NormalizeRssFeeds(IEnumerable<string> values)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return values
        .Select(FeedUrlCanonicalizer.NormalizeForStorage)
        .Where(value => value is not null)
        .Where(value => keys.Add(FeedUrlCanonicalizer.GetComparisonKey(value!)!))
        .Select(value => value!)
        .Take(30)
        .ToArray();
    }

    private static NewsPreferencesResponse ToResponse(UserNewsPreferences preferences) => new(
        DeserializeList(preferences.TopicsJson),
        NormalizeStoryLimit(preferences.StoryLimit),
        NormalizeStoryTitleSize(preferences.StoryTitleSize),
        NormalizeStoryTitleSize(preferences.TopicHeaderSize),
        preferences.ShowTopicFiltersWhenPinned,
        preferences.ShowSourceFiltersWhenPinned,
        AllowedRefreshMinutes.Contains(preferences.RefreshMinutes) ? preferences.RefreshMinutes : 15,
        preferences.EmailSummaryEnabled,
        preferences.PushNewsTitlesEnabled,
        NormalizeRetentionDays(preferences.ArticleRetentionDays),
        DeserializeTickerOverrides(preferences.TickerOverridesJson, DeserializeList(preferences.TopicsJson)),
        DeserializeWeatherLocation(preferences.WeatherLocationJson),
        DeserializeSecondaryTimeZone(preferences.SecondaryTimeZoneJson),
        NormalizeTrendRegions(DeserializeList(preferences.TrendRegionsJson)),
        NormalizeTrendsPerRegion(preferences.TrendsPerRegion),
        new NewsSourcesResponse(
            preferences.GoogleEnabled,
            preferences.GdeltEnabled,
            DeserializeList(preferences.RssFeedsJson)),
        ExecutiveBriefingDeliveryService.Deserialize(preferences.BriefingPreferencesJson) with { PublicOrigin = null },
        DeserializeMarketPortfolio(preferences.MarketPortfolioJson));

    public static MarketPortfolioItemResponse[] DeserializeMarketPortfolio(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            var raw = JsonSerializer.Deserialize<MarketPortfolioItemRequest[]>(json);
            return NormalizeMarketPortfolio(raw);
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static MarketPortfolioItemResponse[] NormalizeMarketPortfolio(IEnumerable<MarketPortfolioItemRequest>? items)
    {
        if (items is null) return [];
        var result = new List<MarketPortfolioItemResponse>();
        var seenSymbols = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var item in items.Take(24))
        {
            if (item is null) continue;
            if (!MarketTickerParser.TryParse(item.Symbol, out var ticker) || ticker is null) continue;
            var symbol = ticker.QualifiedSymbol;
            if (!seenSymbols.Add(symbol)) continue;

            var displayName = (item.DisplayName ?? "").Trim();
            if (displayName.Length > 80) displayName = displayName[..80];
            if (string.IsNullOrWhiteSpace(displayName)) displayName = symbol;

            var threshold = Math.Clamp(Math.Round(item.AlertThresholdPercent, 2), 0.1m, 50.0m);
            result.Add(new MarketPortfolioItemResponse(symbol, displayName, threshold, item.AlertEnabled));
        }

        return result.ToArray();
    }

    internal static int NormalizeRetentionDays(int value) => AllowedRetentionDays.Contains(value) ? value : 30;
    internal static int NormalizeStoryLimit(int value) =>
        value == 10
            ? 10
            : Math.Clamp((int)Math.Round(value / 20d, MidpointRounding.AwayFromZero) * 20, 20, 500);
    internal static string NormalizeStoryTitleSize(string? value) =>
        value?.ToLowerInvariant() is "small" or "medium" or "large"
            ? value.ToLowerInvariant()
            : "large";
    internal static int NormalizeTrendsPerRegion(int value) =>
        value is >= 1 and <= GoogleTrendsService.MaximumTrendsPerRegion
            ? value
            : GoogleTrendsService.DefaultTrendsPerRegion;

    private static string[] NormalizeTrendRegions(IEnumerable<string>? values)
    {
        var supported = GoogleTrendsService.AvailableRegions
            .ToDictionary(region => region.Code, StringComparer.OrdinalIgnoreCase);
        var selected = (values ?? [])
            .Where(code => !string.IsNullOrWhiteSpace(code))
            .Select(code => code.Trim())
            .Where(supported.ContainsKey)
            .Select(code => supported[code].Code)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (selected.Count == 0)
            return GoogleTrendsService.AvailableRegions.Select(region => region.Code).ToArray();
        return GoogleTrendsService.AvailableRegions
            .Where(region => selected.Contains(region.Code))
            .Select(region => region.Code)
            .ToArray();
    }

    private static WeatherLocationResponse? NormalizeWeatherLocation(WeatherLocationRequest? location)
    {
        if (location is null
            || !double.IsFinite(location.Latitude)
            || location.Latitude is < -90 or > 90
            || !double.IsFinite(location.Longitude)
            || location.Longitude is < -180 or > 180)
            return null;

        var name = Regex.Replace(location.Name?.Trim() ?? "", @"\s+", " ");
        if (name.Length is < 1 or > 120) return null;
        var timezone = (location.Timezone ?? "").Trim();
        if (timezone.Length > 80) timezone = timezone[..80];
        return new WeatherLocationResponse(name, location.Latitude, location.Longitude, timezone);
    }

    private static WeatherLocationResponse? DeserializeWeatherLocation(string json)
    {
        try
        {
            var location = JsonSerializer.Deserialize<WeatherLocationResponse>(json);
            return location is null
                ? null
                : NormalizeWeatherLocation(new WeatherLocationRequest(
                    location.Name,
                    location.Latitude,
                    location.Longitude,
                    location.Timezone));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static SecondaryTimeZoneResponse? NormalizeSecondaryTimeZone(
        SecondaryTimeZoneRequest? value)
    {
        if (value is null) return null;
        var name = Regex.Replace(
            (value.Name ?? "").Split(',', 2)[0].Trim(),
            @"\s+",
            " ");
        var timeZone = (value.TimeZone ?? "").Trim();
        if (name.Length is < 1 or > 120 || timeZone.Length is < 1 or > 80)
            return null;
        try
        {
            _ = TimeZoneInfo.FindSystemTimeZoneById(timeZone);
        }
        catch (TimeZoneNotFoundException)
        {
            if (!TimeZoneInfo.TryConvertIanaIdToWindowsId(timeZone, out var windowsId))
                return null;
            try { _ = TimeZoneInfo.FindSystemTimeZoneById(windowsId); }
            catch (TimeZoneNotFoundException) { return null; }
            catch (InvalidTimeZoneException) { return null; }
        }
        catch (InvalidTimeZoneException)
        {
            return null;
        }
        return new SecondaryTimeZoneResponse(name, timeZone);
    }

    private static SecondaryTimeZoneResponse? DeserializeSecondaryTimeZone(string json)
    {
        try
        {
            var value = JsonSerializer.Deserialize<SecondaryTimeZoneResponse>(json);
            return value is null
                ? null
                : NormalizeSecondaryTimeZone(new SecondaryTimeZoneRequest(value.Name, value.TimeZone));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Dictionary<string, string> NormalizeTickerOverrides(
        IReadOnlyDictionary<string, string>? values,
        IReadOnlyList<string> topics)
    {
        var candidates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in values ?? new Dictionary<string, string>())
            candidates[pair.Key] = pair.Value;

        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var topic in topics)
        {
            if (!candidates.TryGetValue(topic, out var value)) continue;
            var symbol = NormalizeTickerSymbol(value);
            if (symbol is not null) result[topic] = symbol;
        }
        return result;
    }

    private static string? NormalizeTickerSymbol(string? value)
    {
        return MarketTickerParser.TryParse(value, out var ticker)
            ? ticker!.QualifiedSymbol
            : null;
    }

    private static string[] DeserializeList(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<string[]>(json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static Dictionary<string, string> DeserializeTickerOverrides(
        string json,
        IReadOnlyList<string> topics)
    {
        try
        {
            var values = JsonSerializer.Deserialize<Dictionary<string, string>>(json)
                ?? new Dictionary<string, string>();
            return NormalizeTickerOverrides(values, topics);
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    }

    private async Task SyncTopicRefreshStatesAsync(
        string userId,
        IReadOnlyList<string> topics,
        int refreshMinutes,
        bool forceRefresh,
        bool intervalChanged,
        CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var states = await database.TopicRefreshStates
            .Where(item => item.UserId == userId)
            .ToListAsync(cancellationToken);
        var topicKeys = topics
            .Select(TopicRefreshService.NormalizeTopicKey)
            .ToHashSet(StringComparer.Ordinal);

        database.TopicRefreshStates.RemoveRange(states.Where(state => !topicKeys.Contains(state.TopicKey)));
        var byKey = states.ToDictionary(state => state.TopicKey, StringComparer.Ordinal);
        foreach (var topic in topics)
        {
            var key = TopicRefreshService.NormalizeTopicKey(topic);
            if (!byKey.TryGetValue(key, out var state))
            {
                database.TopicRefreshStates.Add(new TopicRefreshState
                {
                    UserId = userId,
                    TopicKey = key,
                    Topic = topic,
                    NextRefreshAtUtc = refreshMinutes == 0 ? null : now,
                });
                continue;
            }

            state.Topic = topic;
            if (refreshMinutes == 0)
            {
                state.NextRefreshAtUtc = null;
            }
            else if (forceRefresh)
            {
                state.NextRefreshAtUtc = now;
            }
            else if (intervalChanged)
            {
                var intervalDueAt = state.LastSuccessfulAtUtc?.AddMinutes(refreshMinutes) ?? now;
                state.NextRefreshAtUtc = intervalDueAt > now ? intervalDueAt : now;
            }
        }
    }
}

public sealed record PreferencesEnvelope(bool Exists, NewsPreferencesResponse Preferences);

public sealed record NewsPreferencesResponse(
    string[] Topics,
    int Limit,
    string StoryTitleSize,
    string TopicHeaderSize,
    bool ShowTopicFiltersWhenPinned,
    bool ShowSourceFiltersWhenPinned,
    int RefreshMinutes,
    bool EmailSummaryEnabled,
    bool PushNewsTitlesEnabled,
    int ArticleRetentionDays,
    IReadOnlyDictionary<string, string> TickerOverrides,
    WeatherLocationResponse? WeatherLocation,
    SecondaryTimeZoneResponse? SecondaryTimeZone,
    string[] TrendRegions,
    int TrendsPerRegion,
    NewsSourcesResponse Sources,
    ExecutiveBriefingPreferencesDto? BriefingPreferences = null,
    MarketPortfolioItemResponse[]? MarketPortfolio = null)
{
    public static NewsPreferencesResponse Default { get; } = new(
        ["Artificial intelligence"],
        20,
        "large",
        "large",
        true,
        true,
        15,
        false,
        true,
        30,
        new Dictionary<string, string>(),
        null,
        null,
        GoogleTrendsService.AvailableRegions.Select(region => region.Code).ToArray(),
        GoogleTrendsService.DefaultTrendsPerRegion,
        new NewsSourcesResponse(true, true, []),
        ExecutiveBriefingPreferencesDto.Default,
        []);
}

public sealed record NewsSourcesResponse(bool Google, bool Gdelt, string[] RssFeeds);

public sealed record WeatherLocationResponse(
    string Name,
    double Latitude,
    double Longitude,
    string Timezone);

public sealed record SecondaryTimeZoneResponse(
    string Name,
    string TimeZone);

public sealed record NewsPreferencesRequest(
    [Required] string[] Topics,
    [Range(10, 500)] int Limit,
    string? StoryTitleSize,
    string? TopicHeaderSize,
    bool? ShowTopicFiltersWhenPinned,
    bool? ShowSourceFiltersWhenPinned,
    int RefreshMinutes,
    bool EmailSummaryEnabled,
    int ArticleRetentionDays,
    IReadOnlyDictionary<string, string>? TickerOverrides,
    WeatherLocationRequest? WeatherLocation,
    SecondaryTimeZoneRequest? SecondaryTimeZone,
    string[]? TrendRegions,
    int TrendsPerRegion,
    [Required] NewsSourcesRequest Sources,
    bool? PushNewsTitlesEnabled = null,
    ExecutiveBriefingPreferencesPatch? BriefingPreferences = null,
    MarketPortfolioItemRequest[]? MarketPortfolio = null);

public sealed record MarketPortfolioItemRequest(
    string Symbol,
    string? DisplayName = null,
    decimal AlertThresholdPercent = 2.0m,
    bool AlertEnabled = true);

public sealed record MarketPortfolioItemResponse(
    string Symbol,
    string DisplayName,
    decimal AlertThresholdPercent,
    bool AlertEnabled);

public sealed record WeatherLocationRequest(
    [Required, MaxLength(120)] string Name,
    [Range(-90, 90)] double Latitude,
    [Range(-180, 180)] double Longitude,
    [MaxLength(80)] string? Timezone);

public sealed record SecondaryTimeZoneRequest(
    [Required, MaxLength(120)] string Name,
    [Required, MaxLength(80)] string TimeZone);

public sealed record NewsSourcesRequest(
    bool Google,
    bool Gdelt,
    [Required] string[] RssFeeds);

public sealed record ResolveRssFeedRequest(
    [Required, MaxLength(2048)] string Feed,
    [Required] string[] ExistingFeeds);

public sealed record ResolveRssFeedResponse(
    string Feed,
    bool Added,
    string? DuplicateOf,
    string[] Feeds);
