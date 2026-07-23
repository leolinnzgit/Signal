using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

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
    private const int MaximumHistoryItems = 500;

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        await PurgeExpiredAsync(userId, cancellationToken);
        return Ok(new ArticleHistoryResponse(await LoadHistoryAsync(userId, cancellationToken)));
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
            .Take(MaximumHistoryItems)
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
        return Ok(new ArticleHistoryResponse(await LoadHistoryAsync(userId, cancellationToken)));
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

    private async Task<ArticleHistoryItem[]> LoadHistoryAsync(string userId, CancellationToken cancellationToken)
    {
        var articles = await database.StoredNewsArticles
            .AsNoTracking()
            .Where(item => item.UserId == userId)
            .OrderByDescending(item => item.IsBookmarked)
            .ThenByDescending(item => item.LastSeenAtUtc)
            .Take(MaximumHistoryItems)
            .ToArrayAsync(cancellationToken);
        return articles.Select(ToResponse).ToArray();
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
        .Take(20)
        .ToArray();

    private static string[] MergeLists(string json, IEnumerable<string> additions) => DeserializeList(json)
        .Concat(additions)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Take(20)
        .ToArray();

    private static string[] DeserializeList(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }

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

public sealed record ArticleHistoryResponse(ArticleHistoryItem[] Articles);

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
