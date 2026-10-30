using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-sentiment")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleSentimentController(
    ArticleReaderService reader,
    AzureLanguageSentimentService sentimentService,
    ILogger<ArticleSentimentController> logger) : ControllerBase
{
    public sealed record SentimentRequest(string Url, string? Title, string[]? Paragraphs);

    [HttpPost]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> Analyze(SentimentRequest request, CancellationToken token)
    {
        try
        {
            if (!sentimentService.Enabled)
                return Ok(new ArticleSentimentResult(false, "Azure AI Language has not been configured yet.", "neutral", 0, 0, 0));

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
                return Ok(new ArticleSentimentResult(false, "No article text available to analyze.", "neutral", 0, 0, 0));
            }

            var result = await sentimentService.AnalyzeSentimentAsync(textToAnalyze, token);
            return Ok(result);
        }
        catch (ArgumentException)
        {
            return BadRequest(new ArticleSentimentResult(false, "Choose a valid article request.", "neutral", 0, 0, 0));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning("Article sentiment analysis failed ({FailureType}).", exception.GetType().Name);
            return Ok(new ArticleSentimentResult(false, "Sentiment analysis is temporarily unavailable.", "neutral", 0, 0, 0));
        }
    }
}
