using System.ComponentModel.DataAnnotations;
using System.Text;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Microsoft.AspNetCore.WebUtilities;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/auth")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class AuthController(
    UserManager<ApplicationUser> userManager,
    SignInManager<ApplicationUser> signInManager,
    SignalDbContext database,
    IAccountEmailSender emailSender,
    IAntiforgery antiforgery,
    ILogger<AuthController> logger) : ControllerBase
{
    [AllowAnonymous]
    [HttpGet("csrf")]
    public IActionResult Csrf()
    {
        var tokens = antiforgery.GetAndStoreTokens(HttpContext);
        return Ok(new { token = tokens.RequestToken });
    }

    [AllowAnonymous]
    [HttpPost("register")]
    public async Task<IActionResult> Register(RegisterRequest request, CancellationToken cancellationToken)
    {
        var email = request.Email.Trim();
        var existingUser = await userManager.FindByEmailAsync(email);
        if (existingUser is not null)
        {
            return Ok(new
            {
                message = "If the address can be registered, check your email for a confirmation link.",
            });
        }

        var user = new ApplicationUser { UserName = email, Email = email };
        var result = await userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
        {
            if (result.Errors.Any(error => error.Code is "DuplicateEmail" or "DuplicateUserName"))
            {
                return Ok(new
                {
                    message = "If the address can be registered, check your email for a confirmation link.",
                });
            }
            return IdentityFailure(result);
        }

        try
        {
            await SendConfirmationEmailAsync(user, cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Could not send confirmation email for a new account.");
            await userManager.DeleteAsync(user);
            return Problem(
                statusCode: StatusCodes.Status503ServiceUnavailable,
                title: "Email delivery is unavailable",
                detail: "The account was not created. Check the email-delivery configuration and try again.");
        }

        return Ok(new
        {
            message = "Account created. Check your email to confirm the address before signing in.",
        });
    }

    [AllowAnonymous]
    [HttpPost("resend-confirmation")]
    public async Task<IActionResult> ResendConfirmation(
        EmailRequest request,
        CancellationToken cancellationToken)
    {
        var user = await userManager.FindByEmailAsync(request.Email.Trim());
        if (user is not null && !await userManager.IsEmailConfirmedAsync(user))
        {
            try
            {
                await SendConfirmationEmailAsync(user, cancellationToken);
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Could not resend an account confirmation email.");
                return Problem(
                    statusCode: StatusCodes.Status503ServiceUnavailable,
                    title: "Email delivery is unavailable",
                    detail: "Check the email-delivery configuration and try again.");
            }
        }

        return Ok(new { message = "If that account is awaiting confirmation, a new email has been sent." });
    }

    [AllowAnonymous]
    [HttpGet("confirm-email")]
    public async Task<IActionResult> ConfirmEmail([FromQuery] string userId, [FromQuery] string code)
    {
        var user = await userManager.FindByIdAsync(userId);
        if (user is null || !TryDecodeToken(code, out var decodedCode))
            return Redirect("/?auth=confirmation-failed");

        var result = await userManager.ConfirmEmailAsync(user, decodedCode);
        return Redirect(result.Succeeded ? "/?auth=confirmed" : "/?auth=confirmation-failed");
    }

    [AllowAnonymous]
    [HttpPost("login")]
    public async Task<IActionResult> Login(LoginRequest request, CancellationToken cancellationToken)
    {
        var user = await userManager.FindByEmailAsync(request.Email.Trim());
        if (user is null)
            return Unauthorized(new { error = "The email or password is incorrect." });

        var result = await signInManager.PasswordSignInAsync(
            user,
            request.Password,
            request.RememberMe,
            lockoutOnFailure: true);

        if (result.Succeeded) return Ok(await UserPayloadAsync(user, cancellationToken));
        if (result.IsLockedOut)
            return StatusCode(StatusCodes.Status423Locked, new { error = "Too many attempts. Try again in 15 minutes." });
        if (result.IsNotAllowed)
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "Confirm your email before signing in." });

        return Unauthorized(new { error = "The email or password is incorrect." });
    }

    [Authorize]
    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        await signInManager.SignOutAsync();
        return NoContent();
    }

    [Authorize]
    [HttpGet("me")]
    public async Task<IActionResult> Me(CancellationToken cancellationToken)
    {
        var user = await userManager.GetUserAsync(User);
        return user is null ? Unauthorized() : Ok(await UserPayloadAsync(user, cancellationToken));
    }

    [Authorize]
    [HttpGet("profile-photo")]
    public async Task<IActionResult> ProfilePhoto(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

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

    [Authorize]
    [HttpPost("profile-photo")]
    [RequestSizeLimit(1_250_000)]
    public async Task<IActionResult> SaveProfilePhoto(
        [FromForm] IFormFile? photo,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (photo is null || photo.Length is <= 0 or > ProfilePhotoValidator.MaximumBytes)
            return BadRequest(new { error = "Choose a profile photo smaller than 1 MB." });
        if (!string.Equals(photo.ContentType, "image/jpeg", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = "Signal could not process that photo. Choose another image." });

        await using var stream = new MemoryStream((int)photo.Length);
        await photo.CopyToAsync(stream, cancellationToken);
        var imageBytes = stream.ToArray();
        if (!ProfilePhotoValidator.IsValidJpeg(imageBytes))
            return BadRequest(new { error = "The profile photo must be a 512 by 512 JPEG created by Signal." });

        var storedPhoto = await database.UserProfilePhotos
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        var updatedAt = DateTime.UtcNow;
        if (storedPhoto is null)
        {
            storedPhoto = new UserProfilePhoto { UserId = userId };
            database.UserProfilePhotos.Add(storedPhoto);
        }
        storedPhoto.ImageBytes = imageBytes;
        storedPhoto.UpdatedAtUtc = updatedAt;
        await database.SaveChangesAsync(cancellationToken);

        return Ok(new { profilePhotoUrl = ProfilePhotoUrl(updatedAt) });
    }

    [Authorize]
    [HttpDelete("profile-photo")]
    public async Task<IActionResult> DeleteProfilePhoto(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var photo = await database.UserProfilePhotos
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        if (photo is not null)
        {
            database.UserProfilePhotos.Remove(photo);
            await database.SaveChangesAsync(cancellationToken);
        }
        return Ok(new { profilePhotoUrl = (string?)null });
    }

    [Authorize]
    [HttpPost("change-password")]
    public async Task<IActionResult> ChangePassword(ChangePasswordRequest request)
    {
        var user = await userManager.GetUserAsync(User);
        if (user is null) return Unauthorized();

        var result = await userManager.ChangePasswordAsync(user, request.CurrentPassword, request.NewPassword);
        if (!result.Succeeded) return IdentityFailure(result);

        await signInManager.RefreshSignInAsync(user);
        return Ok(new { message = "Your password has been changed." });
    }

    [AllowAnonymous]
    [HttpPost("forgot-password")]
    public async Task<IActionResult> ForgotPassword(
        EmailRequest request,
        CancellationToken cancellationToken)
    {
        var user = await userManager.FindByEmailAsync(request.Email.Trim());
        if (user is not null && await userManager.IsEmailConfirmedAsync(user))
        {
            var token = await userManager.GeneratePasswordResetTokenAsync(user);
            var code = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(token));
            var root = $"{Request.Scheme}://{Request.Host}{Request.PathBase}/";
            var resetUrl = QueryHelpers.AddQueryString(root, new Dictionary<string, string?>
            {
                ["auth"] = "reset",
                ["email"] = user.Email,
                ["code"] = code,
            });

            try
            {
                await emailSender.SendPasswordResetAsync(user.Email!, resetUrl, cancellationToken);
            }
            catch (Exception exception)
            {
                logger.LogError(exception, "Could not send a password reset email.");
            }
        }

        return Ok(new { message = "If that confirmed account exists, a password-reset email has been sent." });
    }

    [AllowAnonymous]
    [HttpPost("reset-password")]
    public async Task<IActionResult> ResetPassword(ResetPasswordRequest request)
    {
        var user = await userManager.FindByEmailAsync(request.Email.Trim());
        if (user is null || !TryDecodeToken(request.Code, out var decodedCode))
            return BadRequest(new { error = "The password-reset link is invalid or expired." });

        var result = await userManager.ResetPasswordAsync(user, decodedCode, request.NewPassword);
        if (!result.Succeeded) return IdentityFailure(result);

        return Ok(new { message = "Your password has been reset. You can now sign in." });
    }

    private async Task SendConfirmationEmailAsync(ApplicationUser user, CancellationToken cancellationToken)
    {
        var token = await userManager.GenerateEmailConfirmationTokenAsync(user);
        var code = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(token));
        var confirmationUrl = Url.ActionLink(
            nameof(ConfirmEmail),
            values: new { userId = user.Id, code })
            ?? throw new InvalidOperationException("Could not create the confirmation URL.");
        await emailSender.SendConfirmationAsync(user.Email!, confirmationUrl, cancellationToken);
    }

    private IActionResult IdentityFailure(IdentityResult result)
    {
        var errors = result.Errors.Select(error => error.Description).Distinct().ToArray();
        return BadRequest(new { error = errors.FirstOrDefault() ?? "The account request could not be completed.", errors });
    }

    private async Task<object> UserPayloadAsync(
        ApplicationUser user,
        CancellationToken cancellationToken)
    {
        var updatedAt = await database.UserProfilePhotos
            .AsNoTracking()
            .Where(item => item.UserId == user.Id)
            .Select(item => (DateTime?)item.UpdatedAtUtc)
            .SingleOrDefaultAsync(cancellationToken);
        return new
        {
            email = user.Email,
            displayName = user.Email,
            profilePhotoUrl = updatedAt.HasValue ? ProfilePhotoUrl(updatedAt.Value) : null,
        };
    }

    private static string ProfilePhotoUrl(DateTime updatedAt) =>
        $"/api/auth/profile-photo?v={updatedAt.Ticks:x}";

    private static bool TryDecodeToken(string code, out string token)
    {
        try
        {
            token = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(code));
            return true;
        }
        catch
        {
            token = "";
            return false;
        }
    }
}

public sealed record RegisterRequest(
    [Required, EmailAddress, MaxLength(254)] string Email,
    [Required, MinLength(12), MaxLength(128)] string Password);

public sealed record LoginRequest(
    [Required, EmailAddress, MaxLength(254)] string Email,
    [Required, MaxLength(128)] string Password,
    bool RememberMe = true);

public sealed record EmailRequest(
    [Required, EmailAddress, MaxLength(254)] string Email);

public sealed record ChangePasswordRequest(
    [Required, MaxLength(128)] string CurrentPassword,
    [Required, MinLength(12), MaxLength(128)] string NewPassword);

public sealed record ResetPasswordRequest(
    [Required, EmailAddress, MaxLength(254)] string Email,
    [Required] string Code,
    [Required, MinLength(12), MaxLength(128)] string NewPassword);
