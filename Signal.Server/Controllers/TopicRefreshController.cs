using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/topic-refresh")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class TopicRefreshController(
    TopicRefreshService refreshService,
    UserManager<ApplicationUser> userManager) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string? topic,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        return Ok(await refreshService.LoadBriefingAsync(userId, cancellationToken, topic));
    }

    [HttpPost]
    public async Task<IActionResult> Refresh(
        TopicRefreshRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var topics = string.IsNullOrWhiteSpace(request.Topic) ? null : new[] { request.Topic };
        return Ok(await refreshService.RefreshAsync(userId, topics, true, cancellationToken));
    }

    [HttpPost("viewed")]
    public async Task<IActionResult> MarkViewed(
        TopicViewedRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (string.IsNullOrWhiteSpace(request.Topic))
            return BadRequest(new { error = "Choose a topic." });
        var updated = await refreshService.MarkTopicViewedAsync(
            userId,
            request.Topic,
            cancellationToken);
        return updated
            ? NoContent()
            : NotFound(new { error = "That topic is no longer followed." });
    }
}

public sealed record TopicRefreshRequest(string? Topic);

public sealed record TopicViewedRequest(string Topic);
