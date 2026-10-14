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
    public sealed record CreateShareRequest(string Url, string Title, string Source, string Summary, ArticleSnapshot? Snapshot);

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
        else
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
            Title = snapshot.Title,
            Source = request.Source,
            Byline = snapshot.Byline,
            Language = snapshot.Language,
            ParagraphsJson = JsonSerializer.Serialize(snapshot.Paragraphs),
            SummaryOnly = summaryOnly,
            CreatedAtUtc = DateTime.UtcNow,
        };
        // A link represents this exact version, independent of later translations or feed retention.
        articleShare.ContentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(new { articleShare.OriginalUrl, articleShare.Title, articleShare.Source,
                articleShare.Byline, articleShare.Language, articleShare.ParagraphsJson, articleShare.SummaryOnly }))));
        var existing = await database.SharedNewsArticles.AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId && item.ContentHash == articleShare.ContentHash, token);
        if (existing is null)
        {
            database.SharedNewsArticles.Add(articleShare);
            try { await database.SaveChangesAsync(token); }
            catch (DbUpdateException)
            {
                // Concurrent shares of the same version should return the same link.
                database.Entry(articleShare).State = EntityState.Detached;
                existing = await database.SharedNewsArticles.AsNoTracking()
                    .SingleOrDefaultAsync(item => item.UserId == userId && item.ContentHash == articleShare.ContentHash, token);
                if (existing is null) throw;
            }
        }
        var saved = existing ?? articleShare;
        return Ok(new { path = $"{Request.PathBase}/shared/{saved.Id}", title = saved.Title,
            language = saved.Language, summaryOnly = saved.SummaryOnly });
    }

    [AllowAnonymous]
    [HttpGet("shared/{id}")]
    public async Task<IActionResult> Read(string id, CancellationToken token)
    {
        Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
        var article = id.Length == 48 && id.All(character => char.IsAsciiHexDigit(character))
            ? await database.SharedNewsArticles.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, token)
            : null;
        if (article is null)
            return new ContentResult { StatusCode = 404, ContentType = "text/html; charset=utf-8",
                Content = SharedArticlePage.RenderMissing() };
        return Content(SharedArticlePage.Render(article, $"{Request.PathBase}/"), "text/html; charset=utf-8");
    }
}
