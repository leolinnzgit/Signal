using System.ComponentModel.DataAnnotations;
using System.Text.Json;
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
        preferences.RefreshMinutes = request.RefreshMinutes;
        preferences.EmailSummaryEnabled = request.EmailSummaryEnabled;
        preferences.ArticleRetentionDays = NormalizeRetentionDays(request.ArticleRetentionDays);
        preferences.GoogleEnabled = request.Sources.Google;
        preferences.GdeltEnabled = request.Sources.Gdelt;
        preferences.RssFeedsJson = rssFeedsJson;
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
        AllowedRefreshMinutes.Contains(preferences.RefreshMinutes) ? preferences.RefreshMinutes : 15,
        preferences.EmailSummaryEnabled,
        NormalizeRetentionDays(preferences.ArticleRetentionDays),
        new NewsSourcesResponse(
            preferences.GoogleEnabled,
            preferences.GdeltEnabled,
            DeserializeList(preferences.RssFeedsJson)));

    internal static int NormalizeRetentionDays(int value) => AllowedRetentionDays.Contains(value) ? value : 30;
    internal static int NormalizeStoryLimit(int value) =>
        Math.Clamp((int)Math.Round(value / 20d, MidpointRounding.AwayFromZero) * 20, 20, 500);
    internal static string NormalizeStoryTitleSize(string? value) =>
        value?.ToLowerInvariant() is "small" or "medium" or "large"
            ? value.ToLowerInvariant()
            : "large";

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
    int RefreshMinutes,
    bool EmailSummaryEnabled,
    int ArticleRetentionDays,
    NewsSourcesResponse Sources)
{
    public static NewsPreferencesResponse Default { get; } = new(
        ["Artificial intelligence"],
        20,
        "large",
        15,
        false,
        30,
        new NewsSourcesResponse(true, true, []));
}

public sealed record NewsSourcesResponse(bool Google, bool Gdelt, string[] RssFeeds);

public sealed record NewsPreferencesRequest(
    [Required] string[] Topics,
    [Range(20, 500)] int Limit,
    string? StoryTitleSize,
    int RefreshMinutes,
    bool EmailSummaryEnabled,
    int ArticleRetentionDays,
    [Required] NewsSourcesRequest Sources);

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
