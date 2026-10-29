using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-entities")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleEntitiesController(
    ArticleReaderService reader,
    AzureLanguageEntityService entityService,
    ILogger<ArticleEntitiesController> logger) : ControllerBase
{
    public sealed record EntitiesRequest(string Url, string? Title, string[]? Paragraphs);

    [HttpPost]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> Extract(EntitiesRequest request, CancellationToken token)
    {
        try
        {
            if (!entityService.Enabled)
                return Ok(new ArticleEntitiesResult(false, "Azure AI Language has not been configured yet.", []));

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
                return Ok(new ArticleEntitiesResult(false, "No article text available to analyze.", []));
            }

            var result = await entityService.ExtractEntitiesAsync(textToAnalyze, token);
            return Ok(result);
        }
        catch (ArgumentException)
        {
            return BadRequest(new ArticleEntitiesResult(false, "Choose a valid article request.", []));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning("Article entity extraction failed ({FailureType}).", exception.GetType().Name);
            return Ok(new ArticleEntitiesResult(false, "Entity extraction is temporarily unavailable.", []));
        }
    }
}
