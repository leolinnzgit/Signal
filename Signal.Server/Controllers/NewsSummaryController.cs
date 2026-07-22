using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/news-summary")]
public sealed class NewsSummaryController(
    UserManager<ApplicationUser> userManager,
    IAccountEmailSender emailSender,
    ILogger<NewsSummaryController> logger) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Send(
        NewsSummaryRequest request,
        CancellationToken cancellationToken)
    {
        var user = await userManager.GetUserAsync(User);
        if (string.IsNullOrWhiteSpace(user?.Email)) return Unauthorized();

        var topics = NormalizeLabels(request.Topics, 20, 80);
        var articles = (request.Articles ?? [])
            .Take(50)
            .Where(article => article is not null)
            .Select(NormalizeArticle)
            .Where(article => article is not null)
            .Cast<NewsSummaryArticle>()
            .ToArray();
        if (topics.Length == 0)
            return BadRequest(new { error = "A briefing needs at least one topic." });

        var refreshedAt = request.RefreshedAt == default ? DateTimeOffset.UtcNow : request.RefreshedAt;
        try
        {
            await emailSender.SendNewsSummaryAsync(
                user.Email,
                new NewsSummaryDigest(refreshedAt, topics, articles),
                cancellationToken);
            return Ok(new { message = $"Email summary sent to {user.Email}." });
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Could not deliver a news summary for user {UserId}.", user.Id);
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "The briefing refreshed, but its email summary could not be delivered." });
        }
    }

    private static NewsSummaryArticle? NormalizeArticle(NewsSummaryArticleRequest article)
    {
        if (!Uri.TryCreate(article.Url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return null;
        }

        var title = NormalizeText(article.Title, 240);
        if (title.Length == 0) return null;
        return new NewsSummaryArticle(
            title,
            uri.AbsoluteUri,
            NormalizeText(article.Source, 120),
            article.PublishedAt == default ? DateTimeOffset.UtcNow : article.PublishedAt,
            NormalizeText(article.Summary, 600),
            NormalizeLabels(article.Topics, 20, 80),
            NormalizeLabels(article.Providers, 20, 120));
    }

    private static string NormalizeText(string? value, int maximumLength)
    {
        var normalized = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, maximumLength)];
    }

    private static string[] NormalizeLabels(IEnumerable<string>? values, int maximumCount, int maximumLength) =>
        (values ?? [])
            .Select(value => NormalizeText(value, maximumLength))
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(maximumCount)
            .ToArray();
}

public sealed record NewsSummaryRequest(
    DateTimeOffset RefreshedAt,
    string[]? Topics,
    NewsSummaryArticleRequest[]? Articles);

public sealed record NewsSummaryArticleRequest(
    string? Title,
    string? Url,
    string? Source,
    DateTimeOffset PublishedAt,
    string? Summary,
    string[]? Topics,
    string[]? Providers);
