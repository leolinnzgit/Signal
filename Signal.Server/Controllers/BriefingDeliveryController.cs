using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/briefing-delivery")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class BriefingDeliveryController(
    ExecutiveBriefingDeliveryService deliveryService) : ControllerBase
{
    public sealed record SendBriefingNowRequest(bool Push = true, bool Email = false);

    [HttpPost("send-now")]
    public async Task<IActionResult> SendNow(
        [FromBody] SendBriefingNowRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is null) return Unauthorized();

        var wantPush = request?.Push ?? true;
        var wantEmail = request?.Email ?? false;
        if (!wantPush && !wantEmail)
        {
            return BadRequest(new { error = "Select Push and/or Email delivery." });
        }

        var origin = Request.Host.HasValue
            ? $"{Request.Scheme}://{Request.Host}{Request.PathBase}"
            : null;

        var result = await deliveryService.DeliverAsync(
            userId,
            wantPush,
            wantEmail,
            origin,
            cancellationToken);

        return Ok(result);
    }
}
