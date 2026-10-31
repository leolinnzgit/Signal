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

    [HttpPost]
    [RequestSizeLimit(8_192)]
    public async Task<IActionResult> Caption([FromBody] ImageCaptionRequest request, CancellationToken token)
    {
        var url = (request.ImageUrl ?? "").Trim();
        if (url.Length == 0)
            return BadRequest(new { error = "Image URL is required." });

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { error = "Must be a valid public HTTPS image link." });
        }

        var result = await visionService.CaptionImageAsync(url, token);
        return Ok(result);
    }
}
