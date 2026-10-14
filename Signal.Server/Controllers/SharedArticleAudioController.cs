using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[AllowAnonymous]
[Route("shared/{id}/audio")]
[EnableRateLimiting("audio")]
public sealed class SharedArticleAudioController(SignalDbContext database, SharedArticleAudioService audio,
    ILogger<SharedArticleAudioController> logger) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Read(string id, CancellationToken token, [FromQuery] string? voice = null)
    {
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        Response.Headers.XContentTypeOptions = "nosniff";
        var article = id.Length == 48 && id.All(char.IsAsciiHexDigit)
            ? await database.SharedNewsArticles.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, token)
            : null;
        if (article is null) return NotFound();
        if (HttpMethods.IsHead(Request.Method)) return Ok();
        try
        {
            var recording = await audio.PrepareAsync(article, token, voice);
            if (SharedArticleAudioService.IsCached(recording)) return PhysicalFile(recording.Path, "audio/mpeg", enableRangeProcessing: true);
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            Response.ContentType = "audio/mpeg";
            Response.Headers.AcceptRanges = "none";
            Response.Headers["X-Accel-Buffering"] = "no";
            await audio.WriteAsync(recording, Response.Body, token);
            return new EmptyResult();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return new EmptyResult(); }
        catch (ArgumentException) { return BadRequest(new { error = "Choose an available voice for this story." }); }
        catch (Exception exception)
        {
            logger.LogWarning("Shared story audio stopped ({FailureType}).", exception.GetType().Name);
            if (Response.HasStarted) { HttpContext.Abort(); return new EmptyResult(); }
            return StatusCode(503, new { error = "Signal could not prepare Azure audio for this story. Please try again shortly." });
        }
    }

    [HttpGet("voices")]
    public Task<IActionResult> Voices(string id, CancellationToken token) => Metadata(id, null, true, token);

    [HttpGet("timing")]
    public Task<IActionResult> Timing(string id, CancellationToken token, [FromQuery] string? voice = null)
        => Metadata(id, voice, false, token);

    private async Task<IActionResult> Metadata(string id, string? voice, bool voices, CancellationToken token)
    {
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        Response.Headers.XContentTypeOptions = "nosniff";
        var article = id.Length == 48 && id.All(char.IsAsciiHexDigit)
            ? await database.SharedNewsArticles.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, token)
            : null;
        if (article is null) return NotFound();
        try
        {
            return Ok(voices ? await audio.GetVoicesAsync(article, token)
                : audio.GetTiming(await audio.PrepareAsync(article, token, voice)));
        }
        catch (ArgumentException) { return BadRequest(new { error = "Choose an available voice for this story." }); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return new EmptyResult(); }
        catch (Exception exception)
        {
            logger.LogWarning("Shared story audio metadata unavailable ({FailureType}).", exception.GetType().Name);
            return StatusCode(503, new { error = "Story audio choices could not be loaded. Please try again shortly." });
        }
    }
}
