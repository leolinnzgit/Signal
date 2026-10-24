using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("audio")]
[Route("api/headline-audio")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class HeadlineAudioController(
    HeadlineAudioService audio,
    ILogger<HeadlineAudioController> logger,
    UserVoicePreferencesService? voicePreferences = null) : ControllerBase
{
    private string? CurrentUserId => User?.FindFirstValue(ClaimTypes.NameIdentifier);

    [HttpGet("voices")]
    public async Task<IActionResult> Voices(CancellationToken cancellationToken)
    {
        try
        {
            var voices = await audio.GetVoicesAsync(cancellationToken);
            Response.Headers["X-Signal-Audio-Engine"] = audio.EngineName;
            Response.Headers["X-Signal-Article-Streaming"] = audio.EngineName == "azure-neural" ? "true" : "false";
            Response.Headers["X-Signal-Audio-Batch-Characters"] = audio.MaximumBatchCharacters.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (voicePreferences?.Get(CurrentUserId) is { } saved)
            {
                Response.Headers["X-Signal-Voice-En"] = saved.GetValueOrDefault("en", "");
                Response.Headers["X-Signal-Voice-Zh"] = saved.GetValueOrDefault("zh", "");
            }
            return Ok(voices);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return StatusCode(499); }
        catch (HeadlineAudioUnavailableException exception) { return StatusCode(503, new { error = exception.Message, code = exception.Code }); }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not list installed narration voices.");
            return StatusCode(503, new { error = "Reading voice choices are temporarily unavailable." });
        }
    }

    [HttpGet("preferences")]
    public IActionResult GetPreferences()
    {
        var saved = voicePreferences?.Get(CurrentUserId)
            ?? new Dictionary<string, string>(StringComparer.Ordinal) { ["en"] = "", ["zh"] = "" };
        return Ok(saved);
    }

    [HttpPost("preferences")]
    [RequestSizeLimit(4_096)]
    public IActionResult SavePreferences([FromBody] Dictionary<string, string>? voices)
    {
        try
        {
            var saved = voicePreferences?.Save(CurrentUserId, voices, replaceEmpty: true)
                ?? UserVoicePreferencesService.Normalize(voices);
            return Ok(saved);
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
    }

    [HttpPost]
    [RequestSizeLimit(150_000)]
    public async Task<IActionResult> Create(HeadlineAudioRequest request, CancellationToken cancellationToken)
    {
        try
        {
            if (voicePreferences is not null)
                request = voicePreferences.ApplyToRequest(CurrentUserId, request);
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
        catch (HeadlineAudioUnavailableException exception)
        {
            logger.LogWarning(exception, "Headline audio preparation was interrupted: {Code}.", exception.Code);
            Response.Headers.RetryAfter = "3";
            return StatusCode(503, new { error = exception.Message, code = exception.Code });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Could not prepare headline audio.");
            return StatusCode(503, new { error = "Screen-off audio could not be prepared. Please try again or use the browser voice." });
        }
    }
}
