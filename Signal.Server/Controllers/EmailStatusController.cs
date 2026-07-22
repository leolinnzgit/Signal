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
    public IActionResult Status()
    {
        if (gmail.IsConfigured)
        {
            return Ok(new
            {
                mode = "gmailOAuth",
                connected = true,
                email = gmail.ConnectedEmail,
            });
        }

        var mode = smtpOptions.Value.Mode.Equals("File", StringComparison.OrdinalIgnoreCase)
            ? "localFile"
            : "smtp";
        return Ok(new { mode, connected = false, email = (string?)null });
    }
}
