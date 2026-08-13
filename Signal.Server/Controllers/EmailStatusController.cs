using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/email")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class EmailStatusController(
    GmailApiEmailSender gmail,
    IOptions<SmtpOptions> smtpOptions) : ControllerBase
{
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken cancellationToken)
    {
        if (gmail.IsConfigured)
        {
            var status = await gmail.GetConnectionStatusAsync(cancellationToken);
            return Ok(new
            {
                mode = "gmailOAuth",
                connected = status.Connected,
                email = status.Email,
                error = status.Error,
            });
        }

        var mode = smtpOptions.Value.Mode.Equals("File", StringComparison.OrdinalIgnoreCase)
            ? "localFile"
            : "smtp";
        return Ok(new { mode, connected = false, email = (string?)null, error = (string?)null });
    }
}
