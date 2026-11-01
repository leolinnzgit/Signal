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
            var articleUrl = string.IsNullOrWhiteSpace(article.Article.FinalUrl) ? request.Url : article.Article.FinalUrl;
            return Ok(await translator.TranslateAsync(
                request.Title, article.Article.Paragraphs, request.Language, token,
                articleUrl, article.Article.SiteName, article.Article.Byline));
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

    public sealed record SnippetTranslationRequest(string[]? Texts, string? Language);
    public sealed record SnippetTranslationResponse(bool Available, string Reason, string[] Translations, string Language);

    [HttpPost("snippets")]
    [RequestSizeLimit(8_192)]
    public async Task<IActionResult> TranslateSnippets([FromBody] SnippetTranslationRequest request, CancellationToken token)
    {
        var lang = (request.Language ?? "en").Trim();
        var texts = (request.Texts ?? [])
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Take(12)
            .Select(t => t.Trim())
            .ToArray();

        if (texts.Length == 0 || !AzureTranslatorService.Languages.Contains(lang, StringComparer.Ordinal))
        {
            return BadRequest(new SnippetTranslationResponse(false, "Choose valid text and a supported language.", [], lang));
        }

        if (!translator.Enabled)
        {
            return Ok(new SnippetTranslationResponse(false, "Azure Translator has not been configured yet.", texts, lang));
        }

        try
        {
            var translated = await translator.TranslateTextsAsync(texts, lang, token);
            return Ok(new SnippetTranslationResponse(true, "", translated, lang));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning("Snippet translation failed ({FailureType}).", exception.GetType().Name);
            return Ok(new SnippetTranslationResponse(false, "Snippet translation is temporarily unavailable.", texts, lang));
        }
    }
}
