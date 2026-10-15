using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Controllers;

[ApiController]
[AllowAnonymous]
[Route("api/shared/{id}/comments")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SharedCommentsController(SignalDbContext database) : ControllerBase
{
    public sealed record PublicComment(long Id, string Body, DateTime CreatedAt, string Author);
    public sealed record PublicCommentPage(PublicComment[] Comments, int Total, bool HasMore);
    public sealed record CreateRequest([Required, MaxLength(2000)] string Body);

    [HttpGet]
    public async Task<IActionResult> Get(string id, [FromQuery] long? beforeId = null, CancellationToken token = default)
    {
        var article = await FindArticleAsync(id, token);
        if (article is null) return NotFound();
        // Shared visitors see the story's discussion without exposing account IDs, photos or names.
        var url = DiscussionUrl(article);
        var query = database.NewsComments.AsNoTracking().Where(item => item.ArticleUrl == url);
        var total = await query.CountAsync(token);
        if (beforeId.HasValue) query = query.Where(item => item.Id < beforeId.Value);
        var page = await query.OrderByDescending(item => item.Id).Take(51).ToArrayAsync(token);
        return Ok(new PublicCommentPage(page.Take(50).Reverse().Select(ToPublic).ToArray(), total, page.Length > 50));
    }

    [HttpPost]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> Create(string id, CreateRequest request, CancellationToken token)
    {
        var article = await FindArticleAsync(id, token);
        if (article is null) return NotFound();
        var body = request.Body?.Trim() ?? "";
        if (body.Length == 0) return BadRequest(new { error = "Write a comment first." });
        if (body.Length > 2000) return BadRequest(new { error = "Comments can contain up to 2,000 characters." });
        var comment = new NewsComment {
            ArticleUrl = DiscussionUrl(article), ArticleTitle = article.Title[..Math.Min(article.Title.Length, 500)],
            Body = body, CreatedAtUtc = DateTime.UtcNow,
        };
        database.NewsComments.Add(comment);
        await database.SaveChangesAsync(token);
        return Ok(ToPublic(comment));
    }

    private Task<SharedNewsArticle?> FindArticleAsync(string id, CancellationToken token) =>
        id.Length == 48 && id.All(char.IsAsciiHexDigit)
            ? database.SharedNewsArticles.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, token)
            : Task.FromResult<SharedNewsArticle?>(null);

    private static string DiscussionUrl(SharedNewsArticle article) =>
        article.DiscussionUrl.Length > 0 ? article.DiscussionUrl : article.OriginalUrl;

    private static PublicComment ToPublic(NewsComment comment) => new(comment.Id, comment.Body,
        DateTime.SpecifyKind(comment.CreatedAtUtc, DateTimeKind.Utc), "Anonymous");
}
