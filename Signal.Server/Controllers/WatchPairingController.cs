using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Models;
using Signal.Server.Services;
using Signal.Server.Data;
using Microsoft.EntityFrameworkCore;

namespace Signal.Server.Controllers;

[ApiController, Route("api/watch/pairing")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class WatchPairingController(
    WatchPairingService pairing,
    UserManager<ApplicationUser> users,
    SignInManager<ApplicationUser> signIn,
    SignalDbContext database) : ControllerBase
{
    // These anonymous native-client endpoints do not use an ambient signed-in
    // browser session. Only the approval endpoint uses cookies and requires CSRF.
    [HttpPost, AllowAnonymous, IgnoreAntiforgeryToken, EnableRateLimiting("account")]
    public IActionResult Create([FromQuery] string kind = "watch")
    {
        if (kind is not ("watch" or "phone")) return BadRequest();
        try { return Ok(pairing.Create(kind)); }
        catch (InvalidOperationException) { return StatusCode(503, new { error = "Watch pairing is busy. Try again shortly." }); }
    }

    [HttpPost("approve"), Authorize, EnableRateLimiting("account")]
    public async Task<IActionResult> Approve(WatchApprovalRequest request)
    {
        var user = await users.GetUserAsync(User);
        if (user is null) return Unauthorized();
        if (request.BrowserEndpoint is not null && !await database.UserPushSubscriptions.AnyAsync(s => s.UserId == user.Id && s.Endpoint == request.BrowserEndpoint))
            return BadRequest(new { error = "This browser notification subscription does not belong to your signed-in account." });
        if (!pairing.Approve(request.Code, user.Id, request.BrowserEndpoint))
            return NotFound(new { error = "That code is unavailable or expired. Start a new connection on your watch." });
        return Ok(new { status = "approved" });
    }

    [HttpPost("claim"), AllowAnonymous, IgnoreAntiforgeryToken, EnableRateLimiting("watch-poll")]
    public async Task<IActionResult> Claim(WatchClaimRequest request)
    {
        var claim = pairing.Claim(request.DeviceSecret);
        if (claim.Status == "pending") return StatusCode(202, new { status = "pending" });
        if (claim.UserId is null) return StatusCode(410, new { error = "This watch code expired. Start a new connection." });
        var user = await users.FindByIdAsync(claim.UserId);
        if (user is null || !await signIn.CanSignInAsync(user) || await users.IsLockedOutAsync(user))
            return Unauthorized(new { error = "This account cannot sign in. Check Signal on your phone." });
        await signIn.SignInAsync(user, isPersistent: true, authenticationMethod: "SignalWatch");
        return Ok(new { status = "connected", browserEndpoint = claim.BrowserEndpoint });
    }
}

public sealed record WatchApprovalRequest([Required, MaxLength(20)] string Code, [MaxLength(4096)] string? BrowserEndpoint = null);
public sealed record WatchClaimRequest([Required, StringLength(64, MinimumLength = 64)] string DeviceSecret);
