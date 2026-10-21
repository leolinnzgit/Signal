using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/comments")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class CommentsController(
    SignalDbContext database,
    UserManager<ApplicationUser> userManager) : ControllerBase
{
    private const int DefaultPageSize = 50;
    private const int MaximumPageSize = 100;

    [HttpGet("latest")]
    public async Task<IActionResult> GetLatest(
        [FromQuery] long? afterId = null,
        [FromQuery] int limit = 12,
        CancellationToken cancellationToken = default)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var pageSize = Math.Clamp(limit, 1, 30);
        var query = database.NewsComments
            .AsNoTracking()
            .Include(comment => comment.User);
        var comments = await query
            .OrderByDescending(comment => comment.Id)
            .Take(pageSize)
            .ToArrayAsync(cancellationToken);
        var friendshipStates = await LoadFriendshipStatesAsync(
            userId,
            comments.Select(comment => comment.UserId),
            cancellationToken);
        var replyTargets = await LoadReplyTargetsAsync(comments, cancellationToken);
        var newCount = afterId.HasValue
            ? await database.NewsComments.CountAsync(
                comment => comment.Id > afterId.Value && (comment.UserId == null || comment.UserId != userId),
                cancellationToken)
            : 0;

        return Ok(new LatestCommentsResponse(
            comments.Select(comment => ToResponse(comment, userId, friendshipStates, replyTargets)).ToArray(),
            newCount));
    }

    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string url,
        [FromQuery] long? beforeId = null,
        [FromQuery] int limit = DefaultPageSize,
        CancellationToken cancellationToken = default)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var articleUrl = NormalizeUrl(url);
        if (articleUrl is null) return BadRequest(new { error = "Choose a valid article link." });

        var query = database.NewsComments
            .AsNoTracking()
            .Include(comment => comment.User)
            .Where(comment => comment.ArticleUrl == articleUrl);
        var total = await query.CountAsync(cancellationToken);
        if (beforeId.HasValue) query = query.Where(comment => comment.Id < beforeId.Value);
        var pageSize = Math.Clamp(limit, 1, MaximumPageSize);
        var page = await query
            .OrderByDescending(comment => comment.Id)
            .Take(pageSize + 1)
            .ToArrayAsync(cancellationToken);
        var hasMore = page.Length > pageSize;
        var comments = page.Take(pageSize).Reverse().ToArray();
        var friendshipStates = await LoadFriendshipStatesAsync(
            userId,
            comments.Select(comment => comment.UserId),
            cancellationToken);
        var replyTargets = await LoadReplyTargetsAsync(comments, cancellationToken);

        return Ok(new CommentPageResponse(
            comments.Select(comment => ToResponse(comment, userId, friendshipStates, replyTargets)).ToArray(),
            total,
            hasMore));
    }

    [HttpPost]
    public async Task<IActionResult> Create(
        CreateCommentRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var articleUrl = NormalizeUrl(request.ArticleUrl);
        var articleTitle = NormalizeSingleLine(request.ArticleTitle, 500);
        var body = request.Body.Trim();
        if (articleUrl is null) return BadRequest(new { error = "Choose a valid article link." });
        if (articleTitle.Length == 0) return BadRequest(new { error = "The article title is required." });
        if (body.Length == 0) return BadRequest(new { error = "Write a comment first." });
        if (body.Length > 2000) return BadRequest(new { error = "Comments can contain up to 2,000 characters." });

        NewsComment? parent = null;
        if (request.ParentCommentId is long parentId)
        {
            parent = await database.NewsComments
                .AsNoTracking()
                .Include(item => item.User)
                .SingleOrDefaultAsync(item => item.Id == parentId && item.ArticleUrl == articleUrl, cancellationToken);
            if (parent is null) return BadRequest(new { error = "The comment you are replying to is no longer available." });
        }

        var comment = new NewsComment
        {
            ArticleUrl = articleUrl,
            ArticleTitle = articleTitle,
            UserId = userId,
            ParentCommentId = parent?.Id,
            Body = body,
            CreatedAtUtc = DateTime.UtcNow,
        };
        database.NewsComments.Add(comment);
        await database.SaveChangesAsync(cancellationToken);
        comment.User = await userManager.FindByIdAsync(userId)
            ?? throw new InvalidOperationException("The signed-in user no longer exists.");

        var replyTargets = parent is null
            ? new Dictionary<long, CommentReplyResponse>()
            : new Dictionary<long, CommentReplyResponse> { [parent.Id] = ToReplySummary(parent) };
        return Ok(ToResponse(comment, userId, new Dictionary<string, string>(), replyTargets));
    }

    [HttpDelete("{commentId:long}")]
    public async Task<IActionResult> Delete(long commentId, CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var comment = await database.NewsComments
            .SingleOrDefaultAsync(item => item.Id == commentId, cancellationToken);
        if (comment is null) return NotFound();
        if (comment.UserId != userId) return Forbid();

        database.NewsComments.Remove(comment);
        await database.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    [HttpPut("{commentId:long}")]
    public async Task<IActionResult> Update(
        long commentId,
        EditCommentRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var body = request.Body.Trim();
        if (body.Length == 0) return BadRequest(new { error = "Write a comment first." });
        if (body.Length > 2000) return BadRequest(new { error = "Comments can contain up to 2,000 characters." });

        var comment = await database.NewsComments
            .Include(item => item.User)
            .SingleOrDefaultAsync(item => item.Id == commentId, cancellationToken);
        if (comment is null) return NotFound();
        if (comment.UserId != userId) return Forbid();

        comment.Body = body;
        await database.SaveChangesAsync(cancellationToken);
        var replyTargets = await LoadReplyTargetsAsync([comment], cancellationToken);
        return Ok(ToResponse(comment, userId, new Dictionary<string, string>(), replyTargets));
    }

    private async Task<Dictionary<long, CommentReplyResponse>> LoadReplyTargetsAsync(
        IEnumerable<NewsComment> comments,
        CancellationToken cancellationToken)
    {
        var parentIds = comments
            .Select(comment => comment.ParentCommentId)
            .OfType<long>()
            .Distinct()
            .ToArray();
        if (parentIds.Length == 0) return new Dictionary<long, CommentReplyResponse>();

        var parents = await database.NewsComments
            .AsNoTracking()
            .Include(comment => comment.User)
            .Where(comment => parentIds.Contains(comment.Id))
            .ToArrayAsync(cancellationToken);
        return parents.ToDictionary(parent => parent.Id, ToReplySummary);
    }

    private async Task<Dictionary<string, string>> LoadFriendshipStatesAsync(
        string currentUserId,
        IEnumerable<string?> authorIds,
        CancellationToken cancellationToken)
    {
        var ids = authorIds
            .OfType<string>()
            .Where(id => id != currentUserId)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (ids.Length == 0) return new Dictionary<string, string>();

        var relationships = await database.FriendRelationships
            .AsNoTracking()
            .Where(item =>
                (item.UserOneId == currentUserId && ids.Contains(item.UserTwoId))
                || (item.UserTwoId == currentUserId && ids.Contains(item.UserOneId)))
            .ToArrayAsync(cancellationToken);
        return relationships.ToDictionary(
            relationship => OtherUserId(relationship, currentUserId),
            relationship => relationship.Status == "Accepted"
                ? "friends"
                : relationship.RequestedByUserId == currentUserId ? "outgoing" : "incoming",
            StringComparer.Ordinal);
    }

    private static CommentResponse ToResponse(
        NewsComment comment,
        string currentUserId,
        IReadOnlyDictionary<string, string> friendshipStates,
        IReadOnlyDictionary<long, CommentReplyResponse> replyTargets) => new(
            comment.Id,
            comment.ArticleUrl,
            comment.ArticleTitle,
            comment.Body,
            AsUtc(comment.CreatedAtUtc),
            new CommentAuthorResponse(
                comment.UserId ?? "",
                AuthorName(comment),
                comment.UserId is null ? "" : $"/api/social/users/{Uri.EscapeDataString(comment.UserId)}/photo"),
            comment.UserId == currentUserId,
            comment.UserId is null ? "anonymous" : comment.UserId == currentUserId
                ? "self"
                : friendshipStates.GetValueOrDefault(comment.UserId, "none"),
            comment.ParentCommentId,
            comment.ParentCommentId is long parentId ? replyTargets.GetValueOrDefault(parentId) : null);

    private static CommentReplyResponse ToReplySummary(NewsComment comment) => new(
        comment.Id,
        AuthorName(comment),
        NormalizeSingleLine(comment.Body, 160));

    private static string AuthorName(NewsComment comment) =>
        comment.User is null
            ? (comment.GuestName.Length > 0 ? comment.GuestName : "Anonymous")
            : PublicName(comment.User);

    private static string OtherUserId(FriendRelationship relationship, string currentUserId) =>
        relationship.UserOneId == currentUserId ? relationship.UserTwoId : relationship.UserOneId;

    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    internal static string PublicName(ApplicationUser user)
    {
        var email = user.Email ?? user.UserName ?? "Signal reader";
        var separator = email.IndexOf('@');
        return separator > 0 ? email[..separator] : email;
    }

    internal static string? NormalizeUrl(string value)
    {
        if (value.Length > 2048 || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)) return null;
        if ((uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) || !string.IsNullOrEmpty(uri.UserInfo)) return null;
        return uri.AbsoluteUri;
    }

    private static string NormalizeSingleLine(string value, int maximumLength)
    {
        var normalized = string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, maximumLength)];
    }
}

public sealed record CreateCommentRequest(
    [Required, MaxLength(2048)] string ArticleUrl,
    [Required, MaxLength(500)] string ArticleTitle,
    [Required, MaxLength(2000)] string Body,
    long? ParentCommentId = null);

public sealed record EditCommentRequest([Required, MaxLength(2000)] string Body);

public sealed record CommentPageResponse(CommentResponse[] Comments, int Total, bool HasMore);

public sealed record CommentReplyResponse(long Id, string AuthorName, string Body);

public sealed record CommentResponse(
    long Id,
    string ArticleUrl,
    string ArticleTitle,
    string Body,
    DateTime CreatedAt,
    CommentAuthorResponse Author,
    bool CanDelete,
    string FriendshipState,
    long? ParentCommentId = null,
    CommentReplyResponse? ReplyTo = null);

public sealed record LatestCommentsResponse(CommentResponse[] Comments, int NewCount);

public sealed record CommentAuthorResponse(string UserId, string Name, string ProfilePhotoUrl);
