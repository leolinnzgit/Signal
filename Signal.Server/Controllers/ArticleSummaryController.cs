using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-summary")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleSummaryController(ArticleReaderService reader, AzureLanguageSummaryService summaries,
    ILogger<ArticleSummaryController> logger) : ControllerBase
{
    public sealed record SummaryRequest(string Url);

    [HttpPost]
    [RequestSizeLimit(8_192)]
    public async Task<IActionResult> Create(SummaryRequest request, CancellationToken token)
    {
        try
        {
            if (!summaries.Enabled) return Ok(new ArticleSummaryResult(false, "Azure article summaries have not been configured yet.", []));
            var article = await reader.ReadAsync(request.Url, token);
            if (!article.Available || article.Article is null)
                return Ok(new ArticleSummaryResult(false, "The publisher did not provide full article text to summarize.", []));
            return Ok(await summaries.SummarizeAsync(article.Article.Paragraphs, token));
        }
        catch (ArgumentException) { return BadRequest(new ArticleSummaryResult(false, "Choose a valid public article URL.", [])); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return StatusCode(499); }
        catch (ArticleSummaryException exception) { return Ok(new ArticleSummaryResult(false, exception.Message, [])); }
        catch (Exception exception)
        {
            logger.LogWarning("Article summary preparation failed ({FailureType}).", exception.GetType().Name);
            return Ok(new ArticleSummaryResult(false, "The article summary is temporarily unavailable. Please try again.", []));
        }
    }
}
