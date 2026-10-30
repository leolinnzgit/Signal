using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[AllowAnonymous]
[Route("api/privacy")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class PrivacyShieldController(AzureLanguagePiiService piiService) : ControllerBase
{
    public sealed record RedactPiiRequest(string? Text);

    [HttpPost("redact-pii")]
    [RequestSizeLimit(32_768)]
    public async Task<IActionResult> Redact([FromBody] RedactPiiRequest request, CancellationToken token)
    {
        var text = (request.Text ?? "").Trim();
        if (text.Length == 0)
            return Ok(new PiiAnalysisResult(true, "", false, "", []));

        if (text.Length > 4_000)
            return BadRequest(new { error = "Text too long to analyze for privacy (maximum 4,000 characters)." });

        var result = await piiService.AnalyzeAndRedactAsync(text, token);
        return Ok(result);
    }
}
