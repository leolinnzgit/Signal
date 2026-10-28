using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/listening-queue"), EnableRateLimiting("listening-handoff")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ListeningQueueController(ListeningQueueService progress) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;
    private object View(ListeningQueueState state, bool? accepted = null) => new { accountKey = NativeNotificationService.AccountKey(UserId),
        accountEmail = User.FindFirstValue(ClaimTypes.Email) ?? User.Identity?.Name ?? "", state.Version, state.State, state.UpdatedAt, state.Document, accepted };
    [HttpGet]
    public IActionResult Get([FromHeader(Name = "X-Signal-Progress-Account")] string? accountKey)
    {
        if (accountKey != null && accountKey != NativeNotificationService.AccountKey(UserId)) return StatusCode(403);
        try { return Ok(View(progress.Get(UserId))); }
        catch (IOException) { return StatusCode(503, new { error = "Listen later is temporarily unavailable. Your local queue is kept." }); }
    }
    [HttpPost, RequestSizeLimit(1_200_000)]
    public IActionResult Update(ListeningQueueMutation mutation)
    {
        try
        {
            var result = progress.Apply(UserId, mutation);
            return StatusCode(result.Accepted ? 200 : 409, View(result.Progress, result.Accepted));
        }
        catch (UnauthorizedAccessException) { return StatusCode(403); }
        catch (ArgumentException error) { return BadRequest(new { error = error.Message }); }
        catch (IOException) { return StatusCode(503, new { error = "Listen later is temporarily unavailable. Your local queue is kept." }); }
    }
}
