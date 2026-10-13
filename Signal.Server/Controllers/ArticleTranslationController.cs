using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-translation")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleTranslationController(ArticleReaderService reader, AzureTranslatorService translator,
    ILogger<ArticleTranslationController> logger) : ControllerBase
{
    public sealed record TranslationRequest(string Url, string Title, string Language);

    [HttpPost]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> Create(TranslationRequest request, CancellationToken token)
    {
        ArticleTranslationResult Unavailable(string reason) => new(false, reason, "", [], request.Language);
        try
        {
            if (!AzureTranslatorService.Languages.Contains(request.Language) || string.IsNullOrWhiteSpace(request.Title) || request.Title.Length > 1_000)
                return BadRequest(Unavailable("Choose a supported language and an article with a valid title."));
            if (!translator.Enabled) return Ok(Unavailable("Azure Translator has not been configured yet."));
            var article = await reader.ReadAsync(request.Url, token);
            if (!article.Available || article.Article is null)
                return Ok(Unavailable("The publisher did not provide full article text to translate."));
            return Ok(await translator.TranslateAsync(request.Title, article.Article.Paragraphs, request.Language, token));
        }
        catch (ArgumentException) { return BadRequest(Unavailable("Choose a valid public article and supported language.")); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return StatusCode(499); }
        catch (ArticleTranslationException exception) { return Ok(Unavailable(exception.Message)); }
        catch (Exception exception)
        {
            logger.LogWarning("Article translation failed ({FailureType}).", exception.GetType().Name);
            return Ok(Unavailable("The article translation is temporarily unavailable. Please try again."));
        }
    }
}
