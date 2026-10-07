using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/headline-audio")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class HeadlineAudioController(HeadlineAudioService audio, ILogger<HeadlineAudioController> logger) : ControllerBase
{
    [HttpPost]
    [RequestSizeLimit(150_000)]
    public async Task<IActionResult> Create(HeadlineAudioRequest request, CancellationToken cancellationToken)
    {
        try
        {
            var briefing = await audio.GenerateAsync(request, cancellationToken);
            Response.Headers["X-Signal-Headline-Starts"] = JsonSerializer.Serialize(briefing.Starts);
            return File(briefing.Wave, "audio/wav");
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not prepare headline audio.");
            return StatusCode(503, new { error = "Screen-off audio could not be prepared. Please try again or use the browser voice." });
        }
    }
}
