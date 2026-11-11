using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/signal-bot")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SignalBotController(
    MicrosoftFoundryService foundry,
    SignalBotService signalBot,
    ILogger<SignalBotController> logger) : ControllerBase
{
    public sealed record SignalBotStatusResponse(
        bool Available,
        string Provider,
        string Model);

    [HttpGet("status")]
    public ActionResult<SignalBotStatusResponse> Status() =>
        Ok(new SignalBotStatusResponse(
            Available: foundry.Enabled,
            Provider: "Microsoft Foundry",
            Model: foundry.Enabled ? foundry.DeploymentName : ""));

    [HttpPost("analyze")]
    [RequestSizeLimit(196_608)]
    public async Task<IActionResult> Analyze(
        [FromBody] SignalBotAnalyzeRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized();
        }

        if (request is null)
        {
            return BadRequest(new { error = "Provide a news topic or question for Signal Bot to analyze." });
        }

        try
        {
            var result = await signalBot.AnalyzeTopicAsync(userId, request, cancellationToken);
            return Ok(result);
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (FoundryServiceException exception)
        {
            return StatusCode(exception.StatusCode, new { error = exception.Message });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Signal Bot analysis failed unexpectedly.");
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Signal Bot could not complete the analysis right now. Please try again." });
        }
    }
}
