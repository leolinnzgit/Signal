using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/api-keys")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ApiKeysController(
    ApiKeyService apiKeyService,
    UserManager<ApplicationUser> userManager) : ControllerBase
{
    [HttpGet]
    [Authorize]
    [EnableRateLimiting("account")]
    public async Task<IActionResult> List(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var keys = await apiKeyService.ListActiveAsync(userId, cancellationToken);
        return Ok(new
        {
            keys,
            maxActiveKeys = ApiKeyService.MaxActiveKeysPerUser,
            availableScopes = ApiKeyScopes.All,
        });
    }

    [HttpPost]
    [Authorize]
    [EnableRateLimiting("account")]
    public async Task<IActionResult> Create(
        [FromBody] CreateApiKeyRequest? request,
        CancellationToken cancellationToken)
    {
        var user = await userManager.GetUserAsync(User);
        if (user is null) return Unauthorized();
        if (!user.EmailConfirmed)
            return BadRequest(new { error = "Confirm your email address before creating API keys." });

        if (request is null || string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(new { error = "Provide a name for the API key." });

        try
        {
            var created = await apiKeyService.CreateAsync(
                user.Id,
                request.Name,
                request.ExpiresInDays,
                request.Scopes,
                cancellationToken);
            return StatusCode(StatusCodes.Status201Created, new
            {
                apiKey = created.Summary,
                key = created.PlaintextKey,
            });
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
    }

    [HttpDelete("{id}")]
    [Authorize]
    [EnableRateLimiting("account")]
    public async Task<IActionResult> Revoke(string id, CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var revoked = await apiKeyService.RevokeAsync(userId, id, cancellationToken);
        return revoked
            ? NoContent()
            : NotFound(new { error = "That API key could not be found." });
    }

    [HttpGet("verify")]
    [Authorize(Policy = ApiKeyAuthenticationDefaults.ApiKeyOnlyPolicy)]
    [EnableRateLimiting("news-extract")]
    public IActionResult Verify()
    {
        Response.Headers.Vary = "Authorization, X-API-Key";
        var keyId = User.FindFirstValue(ApiKeyAuthenticationDefaults.KeyIdClaimType) ?? "";
        var name = User.FindFirstValue(ApiKeyAuthenticationDefaults.KeyNameClaimType) ?? "";
        var keyPrefix = User.FindFirstValue(ApiKeyAuthenticationDefaults.KeyPrefixClaimType) ?? "";
        var scopes = User.FindAll(ApiKeyAuthenticationDefaults.ScopeClaimType)
            .Select(claim => claim.Value)
            .ToArray();
        DateTimeOffset? expiresAt = DateTimeOffset.TryParse(
            User.FindFirstValue(ApiKeyAuthenticationDefaults.KeyExpiresAtClaimType),
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out var parsedExpiry)
            ? parsedExpiry
            : null;

        return Ok(new
        {
            authenticated = true,
            keyId,
            name,
            keyPrefix,
            scopes,
            expiresAt,
        });
    }
}

public sealed record CreateApiKeyRequest(
    [Required, MaxLength(80)] string Name,
    int? ExpiresInDays = 90,
    string[]? Scopes = null);
