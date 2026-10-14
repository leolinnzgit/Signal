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
    public async Task<IActionResult> Read(string id, CancellationToken token)
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
            var recording = await audio.PrepareAsync(article, token);
            if (SharedArticleAudioService.IsCached(recording)) return PhysicalFile(recording.Path, "audio/mpeg", enableRangeProcessing: true);
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            Response.ContentType = "audio/mpeg";
            Response.Headers.AcceptRanges = "none";
            Response.Headers["X-Accel-Buffering"] = "no";
            await audio.WriteAsync(recording, Response.Body, token);
            return new EmptyResult();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return new EmptyResult(); }
        catch (Exception exception)
        {
            logger.LogWarning("Shared story audio stopped ({FailureType}).", exception.GetType().Name);
            if (Response.HasStarted) { HttpContext.Abort(); return new EmptyResult(); }
            return StatusCode(503, new { error = "Signal could not prepare Azure audio for this story. Please try again shortly." });
        }
    }
}
