using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/word-lookup")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class WordLookupController(
    WordLookupService wordLookupService,
    ILogger<WordLookupController> logger) : ControllerBase
{
    public sealed record WordLookupRequest(string? Word, string? Mode, string? Context = null);

    [HttpPost]
    [RequestSizeLimit(4_096)]
    public async Task<IActionResult> Lookup([FromBody] WordLookupRequest? request, CancellationToken token)
    {
        var rawMode = (request?.Mode ?? "").Trim().ToLowerInvariant();
        var normalizedWord = WordLookupService.NormalizeSelection(request?.Word);

        WordLookupResult Unavailable(string reason) => new(
            Available: false,
            Reason: reason,
            Word: normalizedWord,
            Mode: rawMode is "english" or "chinese" ? rawMode : "english",
            Phonetic: null,
            Meanings: [],
            ContextNote: null,
            ChineseSimplified: null,
            ChineseTraditional: null,
            Pinyin: null,
            ChineseSenses: [],
            Source: "");

        if (rawMode is not ("english" or "chinese") || normalizedWord.Length == 0)
        {
            return BadRequest(Unavailable("Highlight a valid word or short phrase and choose English meaning or Chinese translation."));
        }

        try
        {
            var result = await wordLookupService.LookupAsync(normalizedWord, rawMode, request?.Context, token);
            return Ok(result);
        }
        catch (ArgumentException exception)
        {
            return BadRequest(Unavailable(exception.Message));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning("Word lookup failed ({FailureType}).", exception.GetType().Name);
            return Ok(Unavailable("Word lookup is temporarily unavailable. Please try again."));
        }
    }
}
