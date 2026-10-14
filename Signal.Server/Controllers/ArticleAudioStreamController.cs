using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/article-audio-stream")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleAudioStreamController(ArticleAudioStreamService streams, ILogger<ArticleAudioStreamController> logger) : ControllerBase
{
    private string Owner => User.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw new InvalidOperationException("A signed-in user is required.");
    [HttpPost]
    [EnableRateLimiting("audio")]
    [RequestSizeLimit(250_000)]
    public async Task<IActionResult> Create(HeadlineAudioRequest request, CancellationToken token)
    {
        try
        {
            var session = await streams.CreateAsync(Owner, request, token);
            return Ok(new { url = $"/api/article-audio-stream/{session.Id}", statusUrl = $"/api/article-audio-stream/{session.Id}/status", status = session.Status });
        }
        catch (ArgumentException exception) { return BadRequest(new { error = exception.Message }); }
        catch (HeadlineAudioUnavailableException exception) { return StatusCode(503, new { error = exception.Message }); }
    }

    [HttpGet("{id}/status")]
    public IActionResult Status(string id) => streams.Find(Owner, id) is { } session ? Ok(session.Status) : NotFound();

    [HttpGet("{id}")]
    public async Task<IActionResult> Audio(string id, CancellationToken token)
    {
        var session = streams.Find(Owner, id);
        if (session is null) return NotFound();
        if (session.Recording is { } ready) return File(ready, session.ContentType, enableRangeProcessing: true);
        if (!session.TryStart()) return Conflict(new { error = session.Status.Error ?? "This audio stream is already open." });
        HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        Response.ContentType = "audio/mpeg";
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.AcceptRanges = "none";
        Response.Headers["X-Accel-Buffering"] = "no";
        try
        {
            await streams.WriteAsync(session, Response.Body, token);
            return new EmptyResult();
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return new EmptyResult(); }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Article audio streaming stopped.");
            if (Response.HasStarted) { HttpContext.Abort(); return new EmptyResult(); }
            return StatusCode(503, new { error = session.Status.Error });
        }
    }
}
