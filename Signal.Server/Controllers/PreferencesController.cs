using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.RegularExpressions;
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
        preferences.ArticleRetentionDays = NormalizeRetentionDays(request.ArticleRetentionDays);
        preferences.GoogleEnabled = request.Sources.Google;
        preferences.GdeltEnabled = request.Sources.Gdelt;
        preferences.RssFeedsJson = rssFeedsJson;
        preferences.TickerOverridesJson = tickerOverridesJson;
        preferences.WeatherLocationJson = weatherLocationJson;
        preferences.SecondaryTimeZoneJson = secondaryTimeZoneJson;
        preferences.TrendRegionsJson = trendRegionsJson;
        preferences.TrendsPerRegion = NormalizeTrendsPerRegion(request.TrendsPerRegion);
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
            if (feeds.Count >= 20)
                return BadRequest(new { error = "You can add up to 20 publisher feeds." });

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
        .Take(20)
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
        NormalizeRetentionDays(preferences.ArticleRetentionDays),
        DeserializeTickerOverrides(preferences.TickerOverridesJson, DeserializeList(preferences.TopicsJson)),
        DeserializeWeatherLocation(preferences.WeatherLocationJson),
        DeserializeSecondaryTimeZone(preferences.SecondaryTimeZoneJson),
        NormalizeTrendRegions(DeserializeList(preferences.TrendRegionsJson)),
        NormalizeTrendsPerRegion(preferences.TrendsPerRegion),
        new NewsSourcesResponse(
            preferences.GoogleEnabled,
            preferences.GdeltEnabled,
            DeserializeList(preferences.RssFeedsJson)));

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
    int ArticleRetentionDays,
    IReadOnlyDictionary<string, string> TickerOverrides,
    WeatherLocationResponse? WeatherLocation,
    SecondaryTimeZoneResponse? SecondaryTimeZone,
    string[] TrendRegions,
    int TrendsPerRegion,
    NewsSourcesResponse Sources)
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
        30,
        new Dictionary<string, string>(),
        null,
        null,
        GoogleTrendsService.AvailableRegions.Select(region => region.Code).ToArray(),
        GoogleTrendsService.DefaultTrendsPerRegion,
        new NewsSourcesResponse(true, true, []));
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
    [Required] NewsSourcesRequest Sources);

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
