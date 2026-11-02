using System.Security.Claims;
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
    ILogger<StoryClusterController> logger,
    IAccountEmailSender? emailSender = null,
    IHttpClientFactory? httpClientFactory = null) : ControllerBase
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

    public sealed record DossierPerspective(
        string Publisher,
        string PrimaryFocus,
        string FramingTone);

    public sealed record DossierRiskItem(
        string Category,
        string Description,
        string Severity);

    public sealed record ClusterDossierRequest(
        string? Topic,
        ClusterArticleInput[]? Articles,
        string? Language = "en");

    public sealed record ClusterDossierResponse(
        bool Available,
        string Topic,
        string ExecutiveSummary,
        DossierPerspective[] Perspectives,
        DossierRiskItem[] Risks,
        TimelineMilestone[] Milestones,
        string[] CitedSources);

    public sealed record ClusterDossierDigestRequest(
        ClusterDossierResponse? Dossier,
        string? Destination = "email",
        string? RecipientEmail = null,
        string? WebhookUrl = null);

    public sealed record ClusterDossierDigestResponse(
        bool Success,
        bool EmailSent,
        bool WebhookSent,
        string Message);

    private sealed record NormalizedClusterArticle(
        string Url,
        string Title,
        string Source,
        string Summary);

    [HttpPost("dossier")]
    [RequestSizeLimit(65_536)]
    public IActionResult Dossier(
        [FromBody] ClusterDossierRequest? request)
    {
        var topic = (request?.Topic ?? "").Trim();
        var articles = NormalizeArticles(request?.Articles);
        if (articles.Length == 0 && string.IsNullOrWhiteSpace(topic))
        {
            return BadRequest(new { error = "At least one article or topic is required to build a dossier." });
        }

        var displayTopic = string.IsNullOrWhiteSpace(topic)
            ? (articles.Length > 0 ? articles[0].Title : "Executive Intelligence Dossier")
            : topic;

        var leadSource = articles.Length > 0 ? articles[0].Source : "Signal Research Desk";
        var leadTitle = articles.Length > 0 ? articles[0].Title : displayTopic;

        // 1. Executive Summary Synthesis
        var execSummary = articles.Length switch
        {
            0 => $"Cross-sector intelligence assessment examining current developments, regulatory impacts, and strategic positioning surrounding {displayTopic}.",
            1 => $"Single-publisher intelligence analysis based on reporting by {leadSource}. {articles[0].Summary}",
            _ => $"Unified multi-publisher intelligence dossier synthesizing reports across {articles.Length} independent news organizations ({string.Join(", ", articles.Select(a => a.Source).Distinct())}). " +
                 $"The core catalyst centers on {leadTitle}, with secondary focus on operational execution, market ramifications, and compliance benchmarks."
        };

        // 2. Multi-Publisher Perspectives
        var perspectives = articles.Select((art, idx) =>
        {
            var tone = idx == 0 ? "Direct Catalyst Reporting" : (idx % 2 == 1 ? "Impact & Scrutiny" : "Industry & Market Reaction");
            var focus = string.IsNullOrWhiteSpace(art.Summary) ? art.Title : art.Summary;
            if (focus.Length > 160) focus = focus[..157] + "...";
            return new DossierPerspective(art.Source, focus, tone);
        }).ToArray();

        // 3. Strategic & Downstream Risk Matrix
        var risks = new List<DossierRiskItem>
        {
            new("Regulatory & Compliance", $"Potential statutory reviews, disclosure mandates, or policy shifts stemming from {displayTopic}.", "Elevated"),
            new("Operational Execution", "Downstream integration bottlenecks, resource constraints, and timeline slippage.", "Moderate"),
            new("Market & Sentiment", "Volatility in valuation multiples, peer repositioning, and customer response.", "Medium")
        };

        // 4. Timeline Milestones
        var milestones = new List<TimelineMilestone>
        {
            new("Past Context", "Preceding Cycle", $"Historical Precedent: {displayTopic}",
                "Foundational events, regulatory reviews, and multi-year positioning that created today's conditions.",
                leadSource, articles.Length > 0 ? articles[0].Url : null),
            new("Today's Catalyst", "Breaking Nexus", leadTitle,
                articles.Length > 0 && !string.IsNullOrWhiteSpace(articles[0].Summary) ? articles[0].Summary : "Verified reporting marking a major policy or market inflection point.",
                leadSource, articles.Length > 0 ? articles[0].Url : null),
            new("Forward Milestone", "Next 30-90 Days", "Projected Regulatory & Capital Horizon",
                "Key watch items: formal compliance filings, cross-sector peer disclosures, and secondary implementation deadlines.",
                "Signal Desk", null)
        };

        var citedSources = articles.Select(a => $"{a.Source}: \"{a.Title}\" ({a.Url})").ToArray();

        return Ok(new ClusterDossierResponse(
            true,
            displayTopic,
            execSummary,
            perspectives,
            risks.ToArray(),
            milestones.ToArray(),
            citedSources));
    }

    [HttpPost("dossier/digest")]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> DispatchDigest(
        [FromBody] ClusterDossierDigestRequest? request,
        CancellationToken cancellationToken)
    {
        if (request?.Dossier is null || string.IsNullOrWhiteSpace(request.Dossier.Topic))
        {
            return BadRequest(new { error = "A compiled executive dossier is required to dispatch a digest." });
        }

        var destination = (request.Destination ?? "email").Trim().ToLowerInvariant();
        var emailSent = false;
        var webhookSent = false;
        var dossier = request.Dossier;

        if (destination is "email" or "both")
        {
            var recipientEmail = request.RecipientEmail?.Trim();
            if (string.IsNullOrWhiteSpace(recipientEmail))
            {
                try { recipientEmail = User?.FindFirstValue(ClaimTypes.Email) ?? User?.Identity?.Name; }
                catch { recipientEmail = null; }
            }

            if (!string.IsNullOrWhiteSpace(recipientEmail) && recipientEmail.Contains('@') && emailSender is not null)
            {
                var digest = new ExecutiveDossierEmailDigest(
                    dossier.Topic,
                    dossier.ExecutiveSummary,
                    dossier.Perspectives?.Select(p => new DossierPerspectiveDigest(p.Publisher, p.PrimaryFocus, p.FramingTone)).ToArray() ?? [],
                    dossier.Risks?.Select(r => new DossierRiskDigest(r.Category, r.Description, r.Severity)).ToArray() ?? [],
                    dossier.Milestones?.Select(m => new DossierMilestoneDigest(m.Phase, m.DateOrEra, m.Headline, m.Summary)).ToArray() ?? [],
                    dossier.CitedSources ?? []);

                try
                {
                    await emailSender.SendExecutiveDossierEmailAsync(recipientEmail, digest, cancellationToken);
                    emailSent = true;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Failed delivering executive dossier email to {RecipientEmail}", recipientEmail);
                }
            }
        }

        if (destination is "webhook" or "both")
        {
            var webhookUrl = request.WebhookUrl?.Trim();
            if (!string.IsNullOrWhiteSpace(webhookUrl)
                && Uri.TryCreate(webhookUrl, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && !uri.IsLoopback
                && httpClientFactory is not null)
            {
                try
                {
                    using var client = httpClientFactory.CreateClient("dossier-webhook");
                    client.Timeout = TimeSpan.FromSeconds(10);
                    var payload = new
                    {
                        source = "Signal Executive Intelligence",
                        type = "executive.dossier.digest",
                        topic = dossier.Topic,
                        executiveSummary = dossier.ExecutiveSummary,
                        perspectives = dossier.Perspectives,
                        risks = dossier.Risks,
                        milestones = dossier.Milestones,
                        citedSources = dossier.CitedSources,
                        dispatchedAt = DateTimeOffset.UtcNow
                    };
                    using var resp = await client.PostAsJsonAsync(webhookUrl, payload, cancellationToken);
                    webhookSent = resp.IsSuccessStatusCode;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Failed dispatching executive dossier webhook to {WebhookUrl}", webhookUrl);
                }
            }
        }

        var message = (emailSent, webhookSent) switch
        {
            (true, true) => "Executive dossier delivered via email and secure webhook.",
            (true, false) => "Executive dossier email briefing dispatched successfully.",
            (false, true) => "Executive dossier webhook dispatched successfully.",
            _ => "Executive dossier digest processed (no external dispatch configured or delivered)."
        };

        return Ok(new ClusterDossierDigestResponse(true, emailSent, webhookSent, message));
    }

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
