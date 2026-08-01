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
[Route("api/push")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class PushNotificationsController(
    PushNotificationService pushService,
    UserManager<ApplicationUser> userManager) : ControllerBase
{
    [HttpGet("public-key")]
    public async Task<IActionResult> GetPublicKey(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        return Ok(new
        {
            publicKey = await pushService.GetPublicKeyAsync(cancellationToken),
        });
    }

    [HttpPost("subscription")]
    public async Task<IActionResult> Subscribe(
        PushSubscriptionRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (!Uri.TryCreate(request.Endpoint, UriKind.Absolute, out var endpoint)
            || endpoint.Scheme != Uri.UriSchemeHttps
            || request.Endpoint.Length > 4096)
        {
            return BadRequest(new { error = "The notification subscription endpoint is invalid." });
        }
        if (!IsValidBase64Url(request.Keys.P256Dh, 256)
            || !IsValidBase64Url(request.Keys.Auth, 128))
        {
            return BadRequest(new { error = "The notification subscription keys are invalid." });
        }

        await pushService.SaveSubscriptionAsync(
            userId,
            new PushSubscriptionDetails(
                request.Endpoint,
                request.Keys.P256Dh,
                request.Keys.Auth),
            cancellationToken);
        return NoContent();
    }

    [HttpDelete("subscription")]
    public async Task<IActionResult> Unsubscribe(
        PushUnsubscribeRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (string.IsNullOrWhiteSpace(request.Endpoint) || request.Endpoint.Length > 4096)
            return BadRequest(new { error = "The notification subscription endpoint is invalid." });
        await pushService.RemoveSubscriptionAsync(userId, request.Endpoint, cancellationToken);
        return NoContent();
    }

    [HttpPost("test")]
    public async Task<IActionResult> Test(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        var delivered = await pushService.SendTestAsync(userId, cancellationToken);
        return delivered > 0
            ? Ok(new { delivered, message = "A test notification was sent to this account." })
            : StatusCode(
                StatusCodes.Status503ServiceUnavailable,
                new { error = "The test notification could not be delivered." });
    }

    private static bool IsValidBase64Url(string value, int maximumLength) =>
        value.Length is > 0
        && value.Length <= maximumLength
        && value.All(character =>
            char.IsAsciiLetterOrDigit(character)
            || character is '-' or '_');
}

public sealed record PushSubscriptionRequest(
    string Endpoint,
    PushSubscriptionKeysRequest Keys);

public sealed record PushSubscriptionKeysRequest(
    string P256Dh,
    string Auth);

public sealed record PushUnsubscribeRequest(string Endpoint);
