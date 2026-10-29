using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/listening-handoffs"), EnableRateLimiting("listening-handoff")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ListeningHandoffsController(ListeningHandoffService handoffs) : ControllerBase
{
    private string? UserId => User.FindFirstValue(ClaimTypes.NameIdentifier);
    [HttpGet("inbox")]
    public IActionResult Inbox([FromQuery] bool queues = false) => UserId is { } user ? Ok(handoffs.Inbox(user, queues)) : Unauthorized();
    [HttpPost, RequestSizeLimit(150_000)]
    public IActionResult Create(ListeningHandoffDocument document)
    {
        if (UserId is not { } user) return Unauthorized();
        try { return Ok(handoffs.Create(user, document)); }
        catch (ArgumentException error) { return BadRequest(new { error = error.Message }); }
        catch (InvalidOperationException error) { return StatusCode(503, new { error = error.Message }); }
        catch (IOException) { return StatusCode(503, new { error = "Listen later is unavailable. Your local queue is kept." }); }
    }
    [HttpGet("{id}")]
    public IActionResult Get(string id, [FromHeader(Name = "X-Signal-Handoff-Receiver")] string? receiverToken)
    {
        if (UserId is not { } user) return Unauthorized();
        var result = handoffs.Get(user, id, receiverToken);
        return result is null ? NotFound(new { error = "This transfer expired or is unavailable. Start again on your watch." }) : Ok(result);
    }
    [HttpPost("{id}/accept"), RequestSizeLimit(1024)]
    public IActionResult Accept(string id, Receiver request)
    {
        if (UserId is not { } user) return Unauthorized();
        return handoffs.Accept(user, id, request.ReceiverToken, request.Target, request.SupportsQueue) ? Ok(new { status = "accepted" })
            : Conflict(new { error = "This transfer is expired or already claimed. Start a new transfer on your watch." });
    }
    [HttpPost("{id}/ready"), RequestSizeLimit(1024)]
    public IActionResult Ready(string id, Source request)
    {
        if (UserId is not { } user) return Unauthorized();
        try {
            return handoffs.Ready(user, id, request.SourceToken, request.PartIndex, request.QueueVersion)
                ? Ok(new { status = "ready", queueVersion = handoffs.Get(user, id)?.QueueVersion })
                : Conflict(new { error = "The transfer could not confirm the paused position or the queue changed. Start a new transfer." });
        } catch (IOException) { return StatusCode(503, new { error = "Listen later is unavailable. Playback is paused; your local queue is kept." }); }
    }
    [HttpPost("{id}/cancel"), RequestSizeLimit(1024)]
    public IActionResult Cancel(string id, Cancellation request)
    {
        if (UserId is not { } user) return Unauthorized();
        return handoffs.Cancel(user, id, request.SourceToken, request.ReceiverToken) ? Ok(new { status = "cancelled" })
            : Conflict(new { error = "This transfer is already complete or unavailable." });
    }
    public sealed record Receiver(string ReceiverToken, string Target = "phone", bool SupportsQueue = false);
    public sealed record Source(string SourceToken, int PartIndex, string? QueueVersion = null);
    public sealed record Cancellation(string? SourceToken, string? ReceiverToken);
}
