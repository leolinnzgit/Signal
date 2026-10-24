using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Route("api/native"), Authorize, EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class NativeNotificationsController(NativeNotificationService notifications, INativePushSender sender, NativeDeliveryReceipts receipts, IConfiguration configuration) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;
    [HttpGet("status"), AllowAnonymous]
    public IActionResult Status() => Ok(new { ready = sender.Ready });
    [HttpGet("config")]
    public IActionResult Config() => Ok(new {
        ready = sender.Ready, accountKey = NativeNotificationService.AccountKey(UserId),
        projectId = sender.Ready ? configuration["NativePush:ProjectId"] : null,
        applicationId = sender.Ready ? configuration["NativePush:ApplicationId"] : null,
        apiKey = sender.Ready ? configuration["NativePush:ApiKey"] : null,
        senderId = sender.Ready ? configuration["NativePush:SenderId"] : null,
    });

    [HttpPost("devices")]
    public async Task<IActionResult> Register(Registration request, CancellationToken ct)
    {
        if (!sender.Ready) return StatusCode(503, new { error = "Native notification delivery has not been configured on this Signal server." });
        if (!Guid.TryParseExact(request.Id, "N", out _) || request.Kind != "phone") return BadRequest();
        if (!await notifications.RegisterAsync(UserId, new NativeNotificationDevice {
            Id = request.Id, Token = request.Token, Kind = request.Kind, BrowserEndpoint = request.BrowserEndpoint,
        }, ct)) return Conflict(new { error = "That notification installation or browser subscription is unavailable for this account." });
        return Ok(new { status = "registered" });
    }

    [HttpPost("devices/remove")]
    public async Task<IActionResult> Remove(Removal request, CancellationToken ct)
    { await notifications.RemoveAsync(UserId, request.Id, ct); return NoContent(); }

    public sealed record Registration([Required, MaxLength(32)] string Id, [Required, MaxLength(4096)] string Token,
        [Required, MaxLength(5)] string Kind, [MaxLength(4096)] string? BrowserEndpoint);
    public sealed record Removal([Required, MaxLength(32)] string Id);

    [HttpPost("delivery")]
    public IActionResult Delivery(Receipt request) => Ok(new { accepted = receipts.Receive(request.Id, UserId, request.DeviceId, request.Displayed) });
    public sealed record Receipt([Required, MaxLength(32)] string Id, [Required, MaxLength(32)] string DeviceId, bool Displayed);
}
