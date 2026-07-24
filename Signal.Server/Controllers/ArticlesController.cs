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
[Route("api/articles")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticlesController(
    SignalDbContext database,
    UserManager<ApplicationUser> userManager) : ControllerBase
{
    private const int DefaultRetentionDays = 30;
    private const int MaximumSyncItems = 500;
    private const int DefaultPageSize = 50;
    private const int MaximumPageSize = 100;

    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] int offset = 0,
        [FromQuery] int limit = DefaultPageSize,
        [FromQuery] string? search = null,
        [FromQuery] bool bookmarksOnly = false,
        [FromQuery] string? topic = null,
        [FromQuery] string? provider = null,
        CancellationToken cancellationToken = default)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        await PurgeExpiredAsync(userId, cancellationToken);
        return Ok(await LoadHistoryAsync(
            userId,
            ArticleHistorySearch.Normalize(search),
            bookmarksOnly,
            NormalizeText(topic ?? "", 80),
            NormalizeText(provider ?? "", 256),
            Math.Max(0, offset),
            Math.Clamp(limit, 1, MaximumPageSize),
            [],
            cancellationToken));
    }

    [HttpPost("sync")]
    public async Task<IActionResult> Sync(ArticleSyncRequest request, CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var normalized = request.Articles
            .Select(NormalizeArticle)
            .Where(item => item is not null)
            .Cast<NormalizedArticle>()
            .GroupBy(item => item.Url, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .Take(MaximumSyncItems)
            .ToArray();
        var urls = normalized.Select(item => item.Url).ToArray();
        var existing = urls.Length == 0
            ? []
            : await database.StoredNewsArticles
                .Where(item => item.UserId == userId && urls.Contains(item.Url))
                .ToListAsync(cancellationToken);
        var byUrl = existing.ToDictionary(item => item.Url, StringComparer.OrdinalIgnoreCase);
        var now = DateTime.UtcNow;

        foreach (var item in normalized)
        {
            if (!byUrl.TryGetValue(item.Url, out var stored))
            {
                stored = new StoredNewsArticle
                {
                    UserId = userId,
                    Url = item.Url,
                    FirstSeenAtUtc = now,
                };
                database.StoredNewsArticles.Add(stored);
                byUrl[item.Url] = stored;
            }

            stored.Title = item.Title;
            stored.Source = item.Source;
            stored.PublishedAtUtc = item.PublishedAtUtc;
            stored.Summary = item.Summary;
            stored.TopicsJson = JsonSerializer.Serialize(MergeLists(stored.TopicsJson, item.Topics));
            stored.ProvidersJson = JsonSerializer.Serialize(MergeLists(stored.ProvidersJson, item.Providers));
            stored.LastSeenAtUtc = now;
        }

        await database.SaveChangesAsync(cancellationToken);
        await PurgeExpiredAsync(userId, cancellationToken);
        var bookmarkedUrls = urls.Length == 0
            ? []
            : await database.StoredNewsArticles
                .AsNoTracking()
                .Where(item => item.UserId == userId && item.IsBookmarked && urls.Contains(item.Url))
                .Select(item => item.Url)
                .ToArrayAsync(cancellationToken);
        return Ok(await LoadHistoryAsync(
            userId,
            "",
            false,
            "",
            "",
            0,
            DefaultPageSize,
            bookmarkedUrls,
            cancellationToken));
    }

    [HttpPost("bookmark")]
    public async Task<IActionResult> Bookmark(BookmarkRequest request, CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var url = NormalizeUrl(request.Url);
        if (url is null) return BadRequest(new { error = "Choose a valid article link." });

        var article = await database.StoredNewsArticles
            .SingleOrDefaultAsync(item => item.UserId == userId && item.Url == url, cancellationToken);
        if (article is null) return NotFound(new { error = "Refresh this briefing before bookmarking that story." });

        article.IsBookmarked = request.Bookmarked;
        article.BookmarkedAtUtc = request.Bookmarked ? DateTime.UtcNow : null;
        await database.SaveChangesAsync(cancellationToken);
        if (!request.Bookmarked) await PurgeExpiredAsync(userId, cancellationToken);

        return Ok(new BookmarkResponse(article.Url, article.IsBookmarked, article.BookmarkedAtUtc));
    }

    private async Task<ArticleHistoryResponse> LoadHistoryAsync(
        string userId,
        string search,
        bool bookmarksOnly,
        string topic,
        string provider,
        int offset,
        int limit,
        string[] bookmarkedUrls,
        CancellationToken cancellationToken)
    {
        var userArticles = database.StoredNewsArticles
            .AsNoTracking()
            .Where(item => item.UserId == userId);
        var historyTotal = await userArticles.CountAsync(cancellationToken);
        var bookmarkTotal = await userArticles.CountAsync(item => item.IsBookmarked, cancellationToken);

        IQueryable<StoredNewsArticle> matching = userArticles;
        if (bookmarksOnly) matching = matching.Where(item => item.IsBookmarked);
        matching = ArticleHistorySearch.Apply(matching, search);

        var facetRows = await matching
            .Select(item => new { item.TopicsJson, item.ProvidersJson })
            .ToArrayAsync(cancellationToken);
        var topicFacets = BuildFacets(facetRows.Select(item => item.TopicsJson));
        var providerFacets = BuildFacets(facetRows.Select(item => item.ProvidersJson));

        matching = ArticleHistorySearch.ApplyFilters(matching, topic, provider);

        var matchingTotal = await matching.CountAsync(cancellationToken);
        var articles = await matching
            .OrderByDescending(item => item.LastSeenAtUtc)
            .Skip(offset)
            .Take(limit)
            .ToArrayAsync(cancellationToken);
        return new ArticleHistoryResponse(
            articles.Select(ToResponse).ToArray(),
            historyTotal,
            bookmarkTotal,
            matchingTotal,
            facetRows.Length,
            offset + articles.Length < matchingTotal,
            bookmarkedUrls,
            topicFacets,
            providerFacets);
    }

    private async Task PurgeExpiredAsync(string userId, CancellationToken cancellationToken)
    {
        var retentionDays = await database.UserNewsPreferences
            .Where(item => item.UserId == userId)
            .Select(item => (int?)item.ArticleRetentionDays)
            .SingleOrDefaultAsync(cancellationToken) ?? DefaultRetentionDays;
        retentionDays = PreferencesController.NormalizeRetentionDays(retentionDays);
        var cutoff = DateTime.UtcNow.AddDays(-retentionDays);
        var expired = await database.StoredNewsArticles
            .Where(item => item.UserId == userId && !item.IsBookmarked && item.LastSeenAtUtc < cutoff)
            .ToArrayAsync(cancellationToken);
        if (expired.Length == 0) return;
        database.StoredNewsArticles.RemoveRange(expired);
        await database.SaveChangesAsync(cancellationToken);
    }

    private static NormalizedArticle? NormalizeArticle(StoredArticleRequest item)
    {
        var url = NormalizeUrl(item.Url);
        var title = NormalizeText(item.Title, 500);
        var source = NormalizeText(item.Source, 256);
        if (url is null || title.Length == 0 || source.Length == 0) return null;
        var publishedAt = item.PublishedAt.ToUniversalTime();
        if (publishedAt.Year < 2000 || publishedAt > DateTimeOffset.UtcNow.AddDays(1))
            publishedAt = DateTimeOffset.UtcNow;
        return new NormalizedArticle(
            url,
            title,
            source,
            publishedAt.UtcDateTime,
            NormalizeText(item.Summary, 4000),
            NormalizeList(item.Topics),
            NormalizeList(item.Providers));
    }

    private static string? NormalizeUrl(string value)
    {
        if (value.Length > 2048 || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)) return null;
        if ((uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) || !string.IsNullOrEmpty(uri.UserInfo)) return null;
        return uri.AbsoluteUri;
    }

    private static string NormalizeText(string value, int maxLength)
    {
        var normalized = string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, maxLength)];
    }

    private static string[] NormalizeList(IEnumerable<string> values) => values
        .Select(value => NormalizeText(value, 80))
        .Where(value => value.Length > 0)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static string[] MergeLists(string json, IEnumerable<string> additions) => DeserializeList(json)
        .Concat(additions)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static string[] DeserializeList(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }

    private static ArticleHistoryFacet[] BuildFacets(IEnumerable<string> values) => values
        .SelectMany(DeserializeList)
        .GroupBy(value => value, StringComparer.OrdinalIgnoreCase)
        .Select(group => new ArticleHistoryFacet(group.Key, group.Count()))
        .OrderByDescending(facet => facet.Count)
        .ThenBy(facet => facet.Value, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static ArticleHistoryItem ToResponse(StoredNewsArticle article) => new(
        article.Title,
        article.Url,
        article.Source,
        article.PublishedAtUtc,
        article.Summary,
        DeserializeList(article.TopicsJson),
        DeserializeList(article.ProvidersJson),
        article.FirstSeenAtUtc,
        article.LastSeenAtUtc,
        article.IsBookmarked,
        article.BookmarkedAtUtc);

    private sealed record NormalizedArticle(
        string Url,
        string Title,
        string Source,
        DateTime PublishedAtUtc,
        string Summary,
        string[] Topics,
        string[] Providers);
}

public sealed record ArticleSyncRequest([Required] StoredArticleRequest[] Articles);

public sealed record StoredArticleRequest(
    [Required] string Title,
    [Required] string Url,
    [Required] string Source,
    DateTimeOffset PublishedAt,
    string Summary,
    [Required] string[] Topics,
    [Required] string[] Providers);

public sealed record BookmarkRequest([Required] string Url, bool Bookmarked);

public sealed record BookmarkResponse(string Url, bool Bookmarked, DateTime? BookmarkedAt);

public sealed record ArticleHistoryResponse(
    ArticleHistoryItem[] Articles,
    int HistoryTotal,
    int BookmarkTotal,
    int MatchingTotal,
    int FilterTotal,
    bool HasMore,
    string[] BookmarkedUrls,
    ArticleHistoryFacet[] TopicFacets,
    ArticleHistoryFacet[] ProviderFacets);

public sealed record ArticleHistoryFacet(string Value, int Count);

public sealed record ArticleHistoryItem(
    string Title,
    string Url,
    string Source,
    DateTime PublishedAt,
    string Summary,
    string[] Topics,
    string[] Providers,
    DateTime FirstSeenAt,
    DateTime LastSeenAt,
    bool IsBookmarked,
    DateTime? BookmarkedAt);
