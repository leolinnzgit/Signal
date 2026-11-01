using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[AllowAnonymous]
[Route("api/article-image-caption")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleImageCaptionController(AzureVisionService visionService) : ControllerBase
{
    public sealed record ImageCaptionRequest([Required, MaxLength(2048)] string ImageUrl);

    private static bool TryValidatePublicHttpsUrl(string? rawUrl, out string cleanUrl, out IActionResult? errorResult)
    {
        cleanUrl = (rawUrl ?? "").Trim();
        if (cleanUrl.Length == 0)
        {
            errorResult = new BadRequestObjectResult(new { error = "Image URL is required." });
            return false;
        }

        if (!Uri.TryCreate(cleanUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            errorResult = new BadRequestObjectResult(new { error = "Must be a valid public HTTPS image link." });
            return false;
        }

        errorResult = null;
        return true;
    }

    [HttpPost]
    [RequestSizeLimit(8_192)]
    public async Task<IActionResult> Caption([FromBody] ImageCaptionRequest request, CancellationToken token)
    {
        if (!TryValidatePublicHttpsUrl(request.ImageUrl, out var url, out var error))
            return error!;

        var result = await visionService.CaptionImageAsync(url, token);
        return Ok(result);
    }

    [HttpPost("ocr")]
    [RequestSizeLimit(8_192)]
    public async Task<IActionResult> ExtractText([FromBody] ImageCaptionRequest request, CancellationToken token)
    {
        if (!TryValidatePublicHttpsUrl(request.ImageUrl, out var url, out var error))
            return error!;

        var result = await visionService.ExtractTextAsync(url, token);
        return Ok(result);
    }
}
