using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleSharesController(
    SignalDbContext database, ArticleReaderService reader,
    ILogger<ArticleSharesController> logger) : ControllerBase
{
    public sealed record ArticleSnapshot(string Title, string[] Paragraphs, string Language, string Byline);
    public sealed record CreateShareRequest(string Url, string Title, string Source, string Summary, ArticleSnapshot? Snapshot, string? DiscussionUrl = null);

    [Authorize]
    [EnableRateLimiting("account")]
    [HttpPost("api/article-shares")]
    [RequestSizeLimit(524_288)]
    public async Task<IActionResult> Create(CreateShareRequest request, CancellationToken token)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is null) return Unauthorized();
        if (string.IsNullOrWhiteSpace(request.Title) || request.Title.Length > 2_000
            || request.Source.Length > 256 || request.Summary.Length > 4_000
            || request.Url.Length > 2_048
            || !Uri.TryCreate(request.Url, UriKind.Absolute, out var original)
            || original.Scheme != "https" || !string.IsNullOrEmpty(original.UserInfo))
            return BadRequest(new { error = "Choose a story with a valid title and HTTPS publisher link." });

        var discussionUrl = CommentsController.NormalizeUrl(request.DiscussionUrl ?? request.Url);
        if (discussionUrl is null) return BadRequest(new { error = "Choose a valid news discussion link." });

        var snapshot = request.Snapshot;
        var summaryOnly = false;
        if (snapshot is not null)
        {
            if (string.IsNullOrWhiteSpace(snapshot.Title) || snapshot.Title.Length > 2_000
                || snapshot.Byline.Length > 1_000
                || (snapshot.Language != "" && !AzureTranslatorService.Languages.Contains(snapshot.Language))
                || snapshot.Paragraphs.Length is < 1 or > 80
                || snapshot.Paragraphs.Any(string.IsNullOrWhiteSpace)
                || snapshot.Paragraphs.Sum(text => (long)text.Length) > 80_000)
                return BadRequest(new { error = "The saved article text is incomplete or too large. Please reopen the story." });
        }
        var language = snapshot?.Language ?? "";
        var shareKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new { Url = discussionUrl, Language = language }))));
        var existing = await FindExistingAsync(userId, discussionUrl, original.AbsoluteUri, language, shareKey, token);
        if (existing is { SummaryOnly: false }) return ShareResponse(existing);

        if (snapshot is null)
        {
            try
            {
                var result = await reader.ReadAsync(request.Url, token);
                if (result.Available && result.Article is { } article)
                {
                    original = new Uri(article.FinalUrl);
                    snapshot = new(request.Title, article.Paragraphs.ToArray(), "", article.Byline);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (ArgumentException)
            {
                return BadRequest(new { error = "Choose a valid public HTTPS article." });
            }
            catch (Exception exception)
            {
                logger.LogInformation("Shared article extraction unavailable ({FailureType}).", exception.GetType().Name);
            }
            if (snapshot is null)
            {
                summaryOnly = true;
                snapshot = new(request.Title, string.IsNullOrWhiteSpace(request.Summary) ? [] : [request.Summary], "", "");
            }
        }

        var articleShare = new SharedNewsArticle
        {
            Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant(),
            UserId = userId,
            OriginalUrl = original.AbsoluteUri,
            DiscussionUrl = discussionUrl,
            ShareKey = shareKey,
            Title = snapshot.Title,
            Source = request.Source,
            Byline = snapshot.Byline,
            Language = snapshot.Language,
            ParagraphsJson = JsonSerializer.Serialize(snapshot.Paragraphs),
            SummaryOnly = summaryOnly,
            CreatedAtUtc = DateTime.UtcNow,
        };
        // Preserve full reading views; summary-only placeholders can gain full text.
        articleShare.ContentHash = ContentHash(articleShare);
        // Extraction can take time. Check again in case another request saved the story meanwhile.
        existing = await FindExistingAsync(userId, discussionUrl, original.AbsoluteUri, language, shareKey, token);
        if (existing is null)
        {
            database.SharedNewsArticles.Add(articleShare);
            try { await database.SaveChangesAsync(token); }
            catch (DbUpdateException)
            {
                // The unique story/language key also protects concurrent requests with different snapshots.
                database.Entry(articleShare).State = EntityState.Detached;
                existing = await FindExistingAsync(userId, discussionUrl, original.AbsoluteUri, language, shareKey, token);
                if (existing is null) throw;
            }
        }
        if (existing is { SummaryOnly: true } && !articleShare.SummaryOnly)
        {
            articleShare.DiscussionUrl = existing.DiscussionUrl;
            articleShare.ContentHash = ContentHash(articleShare);
            // Upgrade the saved placeholder in place so links and discussions survive.
            // The condition ensures a concurrent request cannot replace a full snapshot.
            await database.SharedNewsArticles
                .Where(item => item.Id == existing.Id && item.UserId == userId && item.SummaryOnly)
                .ExecuteUpdateAsync(update => update
                    .SetProperty(item => item.OriginalUrl, articleShare.OriginalUrl)
                    .SetProperty(item => item.Title, articleShare.Title)
                    .SetProperty(item => item.Source, articleShare.Source)
                    .SetProperty(item => item.Byline, articleShare.Byline)
                    .SetProperty(item => item.ParagraphsJson, articleShare.ParagraphsJson)
                    .SetProperty(item => item.ContentHash, articleShare.ContentHash)
                    .SetProperty(item => item.SummaryOnly, false), token);
            existing = await database.SharedNewsArticles.AsNoTracking().SingleAsync(item => item.Id == existing.Id, token);
        }
        return ShareResponse(existing ?? articleShare);
    }

    private static string ContentHash(SharedNewsArticle article) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new { article.OriginalUrl, article.DiscussionUrl, article.Title, article.Source,
                article.Byline, article.Language, article.ParagraphsJson, article.SummaryOnly }))));

    private Task<SharedNewsArticle?> FindExistingAsync(string userId, string discussionUrl, string originalUrl,
        string language, string shareKey, CancellationToken token) => database.SharedNewsArticles.AsNoTracking()
        .Where(item => item.UserId == userId && (item.ShareKey == shareKey
            || (item.Language == language && (item.DiscussionUrl == discussionUrl
                || (item.DiscussionUrl == "" && item.OriginalUrl == originalUrl)))))
        .OrderBy(item => item.CreatedAtUtc).ThenBy(item => item.Id)
        .FirstOrDefaultAsync(token);

    private IActionResult ShareResponse(SharedNewsArticle saved) =>
        Ok(new { path = $"{Request.PathBase}/shared/{saved.Id}", title = saved.Title,
            language = saved.Language, summaryOnly = saved.SummaryOnly });

    [AllowAnonymous]
    [HttpGet("shared/{id}")]
    public async Task<IActionResult> Read(string id, CancellationToken token)
    {
        Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
        var article = id.Length == 48 && id.All(character => char.IsAsciiHexDigit(character))
            ? await database.SharedNewsArticles.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, token)
            : null;
        if (article is null)
            return new ContentResult { StatusCode = 404, ContentType = "text/html; charset=utf-8",
                Content = SharedArticlePage.RenderMissing() };
        return Content(SharedArticlePage.Render(article, $"{Request.PathBase}/"), "text/html; charset=utf-8");
    }
}
