using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-keyphrases")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleKeyPhrasesController(
    ArticleReaderService reader,
    AzureLanguageKeyPhraseService keyPhraseService,
    ILogger<ArticleKeyPhrasesController> logger) : ControllerBase
{
    public sealed record KeyPhrasesRequest(string Url, string? Title, string[]? Paragraphs);

    [HttpPost]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> Extract(KeyPhrasesRequest request, CancellationToken token)
    {
        try
        {
            if (!keyPhraseService.Enabled)
                return Ok(new ArticleKeyPhrasesResult(false, "Azure AI Language has not been configured yet.", []));

            string textToAnalyze = "";

            if (request.Paragraphs is not null && request.Paragraphs.Length > 0)
            {
                var combined = string.Join("\n\n", request.Paragraphs.Take(4));
                textToAnalyze = string.IsNullOrWhiteSpace(request.Title) ? combined : $"{request.Title}\n\n{combined}";
            }
            else if (!string.IsNullOrWhiteSpace(request.Url))
            {
                var article = await reader.ReadAsync(request.Url, token);
                if (article.Available && article.Article is not null)
                {
                    var combined = string.Join("\n\n", article.Article.Paragraphs.Take(4));
                    textToAnalyze = string.IsNullOrWhiteSpace(request.Title) ? combined : $"{request.Title}\n\n{combined}";
                }
            }

            if (string.IsNullOrWhiteSpace(textToAnalyze))
            {
                return Ok(new ArticleKeyPhrasesResult(false, "No article text available to analyze.", []));
            }

            var result = await keyPhraseService.ExtractKeyPhrasesAsync(textToAnalyze, token);
            return Ok(result);
        }
        catch (ArgumentException)
        {
            return BadRequest(new ArticleKeyPhrasesResult(false, "Choose a valid article request.", []));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning("Article key phrase extraction failed ({FailureType}).", exception.GetType().Name);
            return Ok(new ArticleKeyPhrasesResult(false, "Key phrase extraction is temporarily unavailable.", []));
        }
    }
}
