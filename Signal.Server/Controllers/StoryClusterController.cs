using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/story-cluster")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class StoryClusterController(
    ArticleReaderService reader,
    AzureLanguageSummaryService summaries,
    ILogger<StoryClusterController> logger) : ControllerBase
{
    public sealed record ClusterArticleInput(
        string? Url,
        string? Title,
        string? Source,
        string? Summary);

    public sealed record ClusterSynthesisRequest(ClusterArticleInput[]? Articles);

    public sealed record ClusterSynthesisResponse(
        bool Available,
        string Reason,
        string[] Paragraphs,
        int SourceCount);

    public sealed record TimelineMilestone(
        string Phase,
        string DateOrEra,
        string Headline,
        string Summary,
        string? Source,
        string? SourceUrl);

    public sealed record ClusterTimelineRequest(
        string? Topic,
        ClusterArticleInput[]? Articles,
        string? Language = "en");

    public sealed record ClusterTimelineResponse(
        bool Available,
        string Topic,
        TimelineMilestone[] Milestones);

    private sealed record NormalizedClusterArticle(
        string Url,
        string Title,
        string Source,
        string Summary);

    [HttpPost("timeline")]
    [RequestSizeLimit(32_768)]
    public IActionResult Timeline(
        [FromBody] ClusterTimelineRequest? request)
    {
        var topic = (request?.Topic ?? "").Trim();
        var articles = NormalizeArticles(request?.Articles);
        if (articles.Length == 0 && string.IsNullOrWhiteSpace(topic))
        {
            return BadRequest(new { error = "A story cluster or topic is required to build an evolution timeline." });
        }

        var leadTitle = articles.Length > 0 ? articles[0].Title : topic;
        var leadSource = articles.Length > 0 ? articles[0].Source : "Signal Intelligence";
        var leadUrl = articles.Length > 0 ? articles[0].Url : null;
        var leadSummary = articles.Length > 0 ? articles[0].Summary : "Underlying structural factors establishing market momentum.";

        var milestones = new List<TimelineMilestone>
        {
            new TimelineMilestone(
                "Past Context",
                "Preceding Cycle",
                $"Foundational Backdrop: {(!string.IsNullOrWhiteSpace(topic) ? topic : leadTitle)}",
                $"Historical buildup and regulatory precedents leading up to current market positioning.",
                leadSource,
                leadUrl),

            new TimelineMilestone(
                "Today's Catalyst",
                "Breaking Development",
                leadTitle,
                leadSummary,
                leadSource,
                leadUrl)
        };

        if (articles.Length > 1)
        {
            milestones.Add(new TimelineMilestone(
                "Today's Catalyst",
                "Contrasting Analysis",
                articles[1].Title,
                articles[1].Summary,
                articles[1].Source,
                articles[1].Url));
        }

        milestones.Add(new TimelineMilestone(
            "Forward Milestone",
            "Next 30-90 Days",
            "Projected Governance & Market Catalysts",
            "Key milestones to track: formal regulatory filings, cross-sector peer earnings calls, and secondary policy implementations.",
            "Signal Intelligence",
            null));

        return Ok(new ClusterTimelineResponse(
            true,
            !string.IsNullOrWhiteSpace(topic) ? topic : leadTitle,
            milestones.ToArray()));
    }

    [HttpPost("synthesize")]
    [RequestSizeLimit(32_768)]
    public async Task<IActionResult> Synthesize(
        [FromBody] ClusterSynthesisRequest? request,
        CancellationToken token)
    {
        var articles = NormalizeArticles(request?.Articles);
        if (articles.Length < 2)
        {
            return BadRequest(new ClusterSynthesisResponse(
                false,
                "At least two stories are required to compare coverage.",
                [],
                articles.Length));
        }

        var distinctSourceCount = articles
            .Select(item => item.Source)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count();

        if (!summaries.Enabled)
        {
            return Ok(new ClusterSynthesisResponse(
                false,
                "Azure article summaries have not been configured yet.",
                [],
                distinctSourceCount));
        }

        try
        {
            var dossiers = await BuildPublisherDossiersAsync(articles, token);
            var summary = await summaries.SummarizeAsync(dossiers, token, sentenceCount: 4);
            return Ok(new ClusterSynthesisResponse(
                summary.Available,
                summary.Reason,
                summary.Paragraphs,
                distinctSourceCount));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (ArticleSummaryException exception)
        {
            return Ok(new ClusterSynthesisResponse(false, exception.Message, [], distinctSourceCount));
        }
        catch (Exception exception)
        {
            logger.LogWarning("Story cluster synthesis failed ({FailureType}).", exception.GetType().Name);
            return Ok(new ClusterSynthesisResponse(
                false,
                "Multi-source synthesis is temporarily unavailable.",
                [],
                distinctSourceCount));
        }
    }

    private async Task<string[]> BuildPublisherDossiersAsync(
        NormalizedClusterArticle[] articles,
        CancellationToken token)
    {
        var selected = articles.Take(6).ToArray();
        var excerpts = new string[selected.Length];

        // Enrich up to the first 3 reports when their feed snippet is brief so synthesis captures lead facts
        var enrichTasks = new List<Task>();
        var enrichedCount = 0;

        for (var i = 0; i < selected.Length; i++)
        {
            var index = i;
            var item = selected[index];
            excerpts[index] = item.Summary;

            if (enrichedCount < 3 && item.Summary.Length < 160 && item.Url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                enrichedCount++;
                enrichTasks.Add(Task.Run(async () =>
                {
                    try
                    {
                        using var shortTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                        shortTimeout.CancelAfter(TimeSpan.FromSeconds(3.5));
                        var extracted = await reader.ReadAsync(item.Url, shortTimeout.Token);
                        if (extracted.Available && extracted.Article?.Paragraphs is { Count: > 0 } paragraphs)
                        {
                            var combined = string.Join(" ", paragraphs.Take(3));
                            var normalized = NormalizeText(combined, 850);
                            if (normalized.Length > excerpts[index].Length)
                            {
                                excerpts[index] = normalized;
                            }
                        }
                    }
                    catch
                    {
                        // Keep feed summary/headline fallback
                    }
                }, token));
            }
        }

        if (enrichTasks.Count > 0)
        {
            await Task.WhenAll(enrichTasks);
        }

        var blocks = new List<string>(selected.Length);
        for (var i = 0; i < selected.Length; i++)
        {
            var item = selected[i];
            var excerpt = excerpts[i];
            var block = excerpt.Length > 0
                ? $"[{item.Source}] {item.Title}. {excerpt}"
                : $"[{item.Source}] {item.Title}.";
            blocks.Add(block);
        }

        return blocks.ToArray();
    }

    private static NormalizedClusterArticle[] NormalizeArticles(ClusterArticleInput[]? inputs)
    {
        if (inputs is null || inputs.Length == 0) return [];

        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var results = new List<NormalizedClusterArticle>(Math.Min(inputs.Length, 8));

        foreach (var raw in inputs)
        {
            if (raw is null) continue;
            var rawUrl = (raw.Url ?? "").Trim();
            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
                || uri.IsLoopback
                || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                || !string.IsNullOrEmpty(uri.UserInfo))
            {
                continue;
            }

            if (!seenUrls.Add(uri.AbsoluteUri)) continue;

            var title = NormalizeText(raw.Title, 240);
            if (title.Length == 0) continue;

            var source = NormalizeText(raw.Source, 120);
            if (source.Length == 0) source = uri.Host;

            var summary = NormalizeText(raw.Summary, 850);
            results.Add(new NormalizedClusterArticle(uri.AbsoluteUri, title, source, summary));
            if (results.Count >= 8) break;
        }

        return results.ToArray();
    }

    private static string NormalizeText(string? value, int maxLength)
    {
        var collapsed = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return collapsed.Length <= maxLength ? collapsed : collapsed[..maxLength].TrimEnd();
    }
}
