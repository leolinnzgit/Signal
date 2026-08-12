using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/social")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SocialController(
    SignalDbContext database,
    UserManager<ApplicationUser> userManager,
    IAccountEmailSender emailSender,
    ILogger<SocialController> logger) : ControllerBase
{
    private const string PendingStatus = "Pending";
    private const string AcceptedStatus = "Accepted";
    private const int DefaultMessagePageSize = 50;
    private const int MaximumMessagePageSize = 100;
    private static readonly TimeSpan OnlineWindow = TimeSpan.FromSeconds(150);

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        await TouchPresenceAsync(userId, cancellationToken);
        return Ok(await LoadOverviewAsync(userId, cancellationToken));
    }

    [HttpDelete("presence")]
    public async Task<IActionResult> ClearPresence(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        await database.UserPresences
            .Where(item => item.UserId == userId)
            .ExecuteDeleteAsync(cancellationToken);
        return NoContent();
    }

    [HttpGet("users")]
    public async Task<IActionResult> FindUser(
        [FromQuery, Required, EmailAddress, MaxLength(254)] string email,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var target = await userManager.FindByEmailAsync(email.Trim());
        if (target is null || target.Id == userId)
            return NotFound(new { error = "No other Signal user was found with that exact email address." });

        var relationship = await FindRelationshipAsync(userId, target.Id, cancellationToken);
        var state = RelationshipState(relationship, userId);
        return Ok(new UserSearchResponse(ToUserCard(target, 0), state, relationship?.Id));
    }

    [HttpPost("friends/request")]
    public async Task<IActionResult> RequestFriend(
        FriendRequestCreateRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        ApplicationUser? target = null;
        if (!string.IsNullOrWhiteSpace(request.UserId))
            target = await userManager.FindByIdAsync(request.UserId.Trim());
        else if (!string.IsNullOrWhiteSpace(request.Email))
            target = await userManager.FindByEmailAsync(request.Email.Trim());
        if (target is null) return NotFound(new { error = "That Signal user could not be found." });
        if (target.Id == userId) return BadRequest(new { error = "You cannot add yourself as a friend." });

        var (userOneId, userTwoId) = OrderedPair(userId, target.Id);
        var relationship = await database.FriendRelationships
            .SingleOrDefaultAsync(item =>
                item.UserOneId == userOneId && item.UserTwoId == userTwoId,
                cancellationToken);
        var now = DateTime.UtcNow;
        if (relationship is null)
        {
            relationship = new FriendRelationship
            {
                UserOneId = userOneId,
                UserTwoId = userTwoId,
                RequestedByUserId = userId,
                Status = PendingStatus,
                CreatedAtUtc = now,
                UpdatedAtUtc = now,
            };
            database.FriendRelationships.Add(relationship);
        }
        else if (relationship.Status == PendingStatus && relationship.RequestedByUserId != userId)
        {
            relationship.Status = AcceptedStatus;
            relationship.UpdatedAtUtc = now;
        }
        else if (relationship.Status != AcceptedStatus)
        {
            relationship.RequestedByUserId = userId;
            relationship.Status = PendingStatus;
            relationship.UpdatedAtUtc = now;
        }

        await database.SaveChangesAsync(cancellationToken);
        return Ok(new FriendActionResponse(
            relationship.Id,
            RelationshipState(relationship, userId),
            relationship.Status == AcceptedStatus
                ? $"You and {CommentsController.PublicName(target)} are now friends."
                : $"Friend request sent to {CommentsController.PublicName(target)}."));
    }

    [HttpPost("friends/{relationshipId:long}/accept")]
    public async Task<IActionResult> AcceptFriend(long relationshipId, CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var relationship = await database.FriendRelationships
            .SingleOrDefaultAsync(item => item.Id == relationshipId, cancellationToken);
        if (relationship is null) return NotFound();
        if (!IncludesUser(relationship, userId)
            || relationship.RequestedByUserId == userId
            || relationship.Status != PendingStatus)
            return Forbid();

        relationship.Status = AcceptedStatus;
        relationship.UpdatedAtUtc = DateTime.UtcNow;
        await database.SaveChangesAsync(cancellationToken);
        return Ok(new FriendActionResponse(relationship.Id, "friends", "Friend request accepted."));
    }

    [HttpDelete("friends/{relationshipId:long}")]
    public async Task<IActionResult> RemoveFriend(long relationshipId, CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var relationship = await database.FriendRelationships
            .SingleOrDefaultAsync(item => item.Id == relationshipId, cancellationToken);
        if (relationship is null) return NotFound();
        if (!IncludesUser(relationship, userId)) return Forbid();

        database.FriendRelationships.Remove(relationship);
        await database.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    [HttpGet("messages")]
    public async Task<IActionResult> GetMessages(
        [FromQuery, Required] string friendUserId,
        [FromQuery] long? beforeId = null,
        [FromQuery] int limit = DefaultMessagePageSize,
        CancellationToken cancellationToken = default)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (!await AreFriendsAsync(userId, friendUserId, cancellationToken))
            return Forbid();

        var unread = await database.DirectMessages
            .Where(message =>
                message.SenderUserId == friendUserId
                && message.RecipientUserId == userId
                && message.ReadAtUtc == null)
            .ToArrayAsync(cancellationToken);
        if (unread.Length > 0)
        {
            var readAt = DateTime.UtcNow;
            foreach (var message in unread) message.ReadAtUtc = readAt;
            await database.SaveChangesAsync(cancellationToken);
        }

        var query = database.DirectMessages
            .AsNoTracking()
            .Where(message =>
                (message.SenderUserId == userId && message.RecipientUserId == friendUserId)
                || (message.SenderUserId == friendUserId && message.RecipientUserId == userId));
        if (beforeId.HasValue) query = query.Where(message => message.Id < beforeId.Value);
        var pageSize = Math.Clamp(limit, 1, MaximumMessagePageSize);
        var page = await query
            .OrderByDescending(message => message.Id)
            .Take(pageSize + 1)
            .ToArrayAsync(cancellationToken);
        var hasMore = page.Length > pageSize;
        var messages = page.Take(pageSize).Reverse().ToArray();
        return Ok(new MessagePageResponse(
            messages.Select(message => ToMessageResponse(message, userId)).ToArray(),
            hasMore));
    }

    [HttpPost("messages")]
    public async Task<IActionResult> SendMessage(
        SendMessageRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var recipientId = request.RecipientUserId.Trim();
        if (!await AreFriendsAsync(userId, recipientId, cancellationToken))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "You can only message accepted friends." });
        var body = request.Body.Trim();
        if (body.Length == 0) return BadRequest(new { error = "Write a message first." });
        if (body.Length > 2000) return BadRequest(new { error = "Messages can contain up to 2,000 characters." });

        var message = new DirectMessage
        {
            SenderUserId = userId,
            RecipientUserId = recipientId,
            Body = body,
            CreatedAtUtc = DateTime.UtcNow,
        };
        database.DirectMessages.Add(message);
        await database.SaveChangesAsync(cancellationToken);
        return Ok(ToMessageResponse(message, userId));
    }

    [HttpPost("shares")]
    public async Task<IActionResult> ShareArticle(
        ShareArticleRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var recipientId = request.RecipientUserId.Trim();
        if (!await AreFriendsAsync(userId, recipientId, cancellationToken))
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "You can only share stories with accepted friends." });

        var title = request.Title.Trim();
        var source = request.Source.Trim();
        if (title.Length == 0) return BadRequest(new { error = "The story title is required." });
        if (!Uri.TryCreate(request.Url.Trim(), UriKind.Absolute, out var articleUri)
            || articleUri.Scheme is not ("http" or "https"))
            return BadRequest(new { error = "The story link is not valid." });

        var recipient = await userManager.FindByIdAsync(recipientId);
        var sender = await userManager.FindByIdAsync(userId);
        if (recipient is null || sender is null) return NotFound(new { error = "That Signal friend could not be found." });

        var now = DateTime.UtcNow;
        var message = new DirectMessage
        {
            SenderUserId = userId,
            RecipientUserId = recipientId,
            Body = "Shared a story.",
            SharedArticleTitle = title,
            SharedArticleUrl = articleUri.AbsoluteUri,
            SharedArticleSource = source,
            CreatedAtUtc = now,
        };
        database.DirectMessages.Add(message);
        await database.SaveChangesAsync(cancellationToken);

        var lastSeenAt = await database.UserPresences
            .AsNoTracking()
            .Where(item => item.UserId == recipientId)
            .Select(item => (DateTime?)item.LastSeenAtUtc)
            .SingleOrDefaultAsync(cancellationToken);
        var recipientOnline = lastSeenAt.HasValue && lastSeenAt.Value >= now - OnlineWindow;
        var emailNotificationSent = false;
        if (!recipientOnline && recipient.EmailConfirmed && !string.IsNullOrWhiteSpace(recipient.Email))
        {
            try
            {
                var signalUrl = $"{Request.Scheme}://{Request.Host}{Request.PathBase}/";
                await emailSender.SendSharedArticleAsync(
                    recipient.Email,
                    new SharedArticleEmail(
                        CommentsController.PublicName(sender),
                        title,
                        source,
                        articleUri.AbsoluteUri,
                        signalUrl),
                    cancellationToken);
                emailNotificationSent = true;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(
                    exception,
                    "Story share {MessageId} was delivered to user {RecipientId}, but its offline email failed.",
                    message.Id,
                    recipientId);
            }
        }

        return Ok(new ShareArticleResponse(
            ToMessageResponse(message, userId),
            recipientOnline,
            emailNotificationSent));
    }

    [HttpGet("users/{userId}/photo")]
    public async Task<IActionResult> UserPhoto(string userId, CancellationToken cancellationToken)
    {
        var photo = await database.UserProfilePhotos
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        if (photo is null) return NotFound();
        var entityTag = $"\"{photo.UpdatedAtUtc.Ticks:x}\"";
        if (Request.Headers.IfNoneMatch.Any(value => value == entityTag))
            return StatusCode(StatusCodes.Status304NotModified);
        Response.Headers.ETag = entityTag;
        Response.Headers.CacheControl = "private, max-age=86400";
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(photo.ImageBytes, "image/jpeg");
    }

    private async Task<SocialOverviewResponse> LoadOverviewAsync(
        string userId,
        CancellationToken cancellationToken)
    {
        var relationships = await database.FriendRelationships
            .AsNoTracking()
            .Where(item => item.UserOneId == userId || item.UserTwoId == userId)
            .OrderByDescending(item => item.UpdatedAtUtc)
            .ToArrayAsync(cancellationToken);
        var otherIds = relationships
            .Select(relationship => OtherUserId(relationship, userId))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var users = otherIds.Length == 0
            ? []
            : await database.Users.AsNoTracking()
                .Where(user => otherIds.Contains(user.Id))
                .ToArrayAsync(cancellationToken);
        var byId = users.ToDictionary(user => user.Id, StringComparer.Ordinal);
        var unreadCounts = await database.DirectMessages
            .AsNoTracking()
            .Where(message => message.RecipientUserId == userId && message.ReadAtUtc == null)
            .GroupBy(message => message.SenderUserId)
            .Select(group => new { UserId = group.Key, Count = group.Count() })
            .ToDictionaryAsync(item => item.UserId, item => item.Count, cancellationToken);
        var presences = otherIds.Length == 0
            ? new Dictionary<string, DateTime>(StringComparer.Ordinal)
            : await database.UserPresences
                .AsNoTracking()
                .Where(presence => otherIds.Contains(presence.UserId))
                .ToDictionaryAsync(presence => presence.UserId, presence => presence.LastSeenAtUtc, cancellationToken);
        var onlineSince = DateTime.UtcNow - OnlineWindow;

        var friends = relationships
            .Where(item => item.Status == AcceptedStatus)
            .Select(item => new { Relationship = item, OtherId = OtherUserId(item, userId) })
            .Where(item => byId.ContainsKey(item.OtherId))
            .Select(item => new FriendResponse(
                item.Relationship.Id,
                ToUserCard(
                    byId[item.OtherId],
                    unreadCounts.GetValueOrDefault(item.OtherId),
                    presences.GetValueOrDefault(item.OtherId),
                    onlineSince)))
            .ToArray();
        var incoming = relationships
            .Where(item => item.Status == PendingStatus && item.RequestedByUserId != userId)
            .Select(item => ToRequest(item, userId, byId))
            .Where(item => item is not null)
            .Cast<FriendRequestResponse>()
            .ToArray();
        var outgoing = relationships
            .Where(item => item.Status == PendingStatus && item.RequestedByUserId == userId)
            .Select(item => ToRequest(item, userId, byId))
            .Where(item => item is not null)
            .Cast<FriendRequestResponse>()
            .ToArray();
        return new SocialOverviewResponse(
            friends,
            incoming,
            outgoing,
            unreadCounts.Values.Sum());
    }

    private static FriendRequestResponse? ToRequest(
        FriendRelationship relationship,
        string currentUserId,
        IReadOnlyDictionary<string, ApplicationUser> users)
    {
        var otherId = OtherUserId(relationship, currentUserId);
        return users.TryGetValue(otherId, out var user)
            ? new FriendRequestResponse(relationship.Id, ToUserCard(user, 0), AsUtc(relationship.CreatedAtUtc))
            : null;
    }

    private async Task<FriendRelationship?> FindRelationshipAsync(
        string firstUserId,
        string secondUserId,
        CancellationToken cancellationToken)
    {
        var (userOneId, userTwoId) = OrderedPair(firstUserId, secondUserId);
        return await database.FriendRelationships
            .AsNoTracking()
            .SingleOrDefaultAsync(item =>
                item.UserOneId == userOneId && item.UserTwoId == userTwoId,
                cancellationToken);
    }

    private async Task<bool> AreFriendsAsync(
        string firstUserId,
        string secondUserId,
        CancellationToken cancellationToken)
    {
        var (userOneId, userTwoId) = OrderedPair(firstUserId, secondUserId);
        return await database.FriendRelationships
            .AsNoTracking()
            .AnyAsync(item =>
                item.UserOneId == userOneId
                && item.UserTwoId == userTwoId
                && item.Status == AcceptedStatus,
                cancellationToken);
    }

    private static (string UserOneId, string UserTwoId) OrderedPair(string first, string second) =>
        string.CompareOrdinal(first, second) < 0 ? (first, second) : (second, first);

    private static bool IncludesUser(FriendRelationship relationship, string userId) =>
        relationship.UserOneId == userId || relationship.UserTwoId == userId;

    private static string OtherUserId(FriendRelationship relationship, string userId) =>
        relationship.UserOneId == userId ? relationship.UserTwoId : relationship.UserOneId;

    private static string RelationshipState(FriendRelationship? relationship, string currentUserId) =>
        relationship is null ? "none"
        : relationship.Status == AcceptedStatus ? "friends"
        : relationship.RequestedByUserId == currentUserId ? "outgoing" : "incoming";

    private static SocialUserResponse ToUserCard(ApplicationUser user, int unreadMessages) => new(
        user.Id,
        CommentsController.PublicName(user),
        $"/api/social/users/{Uri.EscapeDataString(user.Id)}/photo",
        unreadMessages,
        false,
        null);

    private static SocialUserResponse ToUserCard(
        ApplicationUser user,
        int unreadMessages,
        DateTime lastSeenAtUtc,
        DateTime onlineSince) => new(
        user.Id,
        CommentsController.PublicName(user),
        $"/api/social/users/{Uri.EscapeDataString(user.Id)}/photo",
        unreadMessages,
        lastSeenAtUtc >= onlineSince,
        lastSeenAtUtc == default ? null : AsUtc(lastSeenAtUtc));

    private async Task TouchPresenceAsync(string userId, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "UserPresences" ("UserId", "LastSeenAtUtc")
            VALUES ({userId}, {now})
            ON CONFLICT("UserId") DO UPDATE SET "LastSeenAtUtc" = excluded."LastSeenAtUtc";
            """, cancellationToken);
    }

    private static DirectMessageResponse ToMessageResponse(DirectMessage message, string currentUserId) => new(
        message.Id,
        message.Body,
        AsUtc(message.CreatedAtUtc),
        message.ReadAtUtc.HasValue ? AsUtc(message.ReadAtUtc.Value) : null,
        message.SenderUserId == currentUserId,
        string.IsNullOrWhiteSpace(message.SharedArticleUrl)
            ? null
            : new SharedStoryResponse(
                message.SharedArticleTitle,
                message.SharedArticleUrl,
                message.SharedArticleSource));

    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };
}

public sealed record FriendRequestCreateRequest(string? UserId, string? Email);

public sealed record SendMessageRequest(
    [Required, MaxLength(450)] string RecipientUserId,
    [Required, MaxLength(2000)] string Body);

public sealed record ShareArticleRequest(
    [Required, MaxLength(450)] string RecipientUserId,
    [Required, MaxLength(300)] string Title,
    [Required, MaxLength(2048)] string Url,
    [MaxLength(200)] string Source);

public sealed record SocialOverviewResponse(
    FriendResponse[] Friends,
    FriendRequestResponse[] IncomingRequests,
    FriendRequestResponse[] OutgoingRequests,
    int UnreadMessages);

public sealed record FriendResponse(long RelationshipId, SocialUserResponse User);

public sealed record FriendRequestResponse(
    long RelationshipId,
    SocialUserResponse User,
    DateTime CreatedAt);

public sealed record SocialUserResponse(
    string UserId,
    string Name,
    string ProfilePhotoUrl,
    int UnreadMessages,
    bool IsOnline,
    DateTime? LastSeenAt);

public sealed record UserSearchResponse(
    SocialUserResponse User,
    string FriendshipState,
    long? RelationshipId);

public sealed record FriendActionResponse(long RelationshipId, string FriendshipState, string Message);

public sealed record MessagePageResponse(DirectMessageResponse[] Messages, bool HasMore);

public sealed record DirectMessageResponse(
    long Id,
    string Body,
    DateTime CreatedAt,
    DateTime? ReadAt,
    bool IsMine,
    SharedStoryResponse? SharedArticle);

public sealed record SharedStoryResponse(string Title, string Url, string Source);

public sealed record ShareArticleResponse(
    DirectMessageResponse Message,
    bool RecipientOnline,
    bool EmailNotificationSent);
