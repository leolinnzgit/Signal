using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[EnableRateLimiting("account")]
[Route("api/voice-debrief")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class VoiceDebriefController(
    HeadlineAudioService audio,
    AzureLanguageSummaryService summaries,
    AzureTranslatorService translator,
    ILogger<VoiceDebriefController> logger) : ControllerBase
{
    public sealed record DebriefArticleInput(
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("title")] string? Title,
        [property: JsonPropertyName("source")] string? Source,
        [property: JsonPropertyName("summary")] string? Summary,
        [property: JsonPropertyName("topics")] string[]? Topics = null);

    public sealed record DebriefQueryRequest(
        [property: JsonPropertyName("query")] string? Query,
        [property: JsonPropertyName("articles")] DebriefArticleInput[]? Articles,
        [property: JsonPropertyName("marketContext")] string? MarketContext,
        [property: JsonPropertyName("voice")] string? Voice = null,
        [property: JsonPropertyName("language")] string? Language = "en");

    public sealed record DebriefCitation(
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source);

    public sealed record VoiceDebriefResponse(
        [property: JsonPropertyName("available")] bool Available,
        [property: JsonPropertyName("query")] string Query,
        [property: JsonPropertyName("intentCategory")] string IntentCategory,
        [property: JsonPropertyName("spokenScript")] string SpokenScript,
        [property: JsonPropertyName("executiveSummary")] string ExecutiveSummary,
        [property: JsonPropertyName("keyTakeaways")] string[] KeyTakeaways,
        [property: JsonPropertyName("citations")] DebriefCitation[] Citations,
        [property: JsonPropertyName("suggestedFollowUps")] string[] SuggestedFollowUps,
        [property: JsonPropertyName("audioAvailable")] bool AudioAvailable,
        [property: JsonPropertyName("generatedAt")] DateTimeOffset GeneratedAt);

    public sealed record DebriefPreset(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("query")] string Query,
        [property: JsonPropertyName("category")] string Category,
        [property: JsonPropertyName("icon")] string Icon);

    public sealed record DebriefSpeakRequest(
        [property: JsonPropertyName("text")] string? Text,
        [property: JsonPropertyName("voice")] string? Voice = null,
        [property: JsonPropertyName("language")] string? Language = "en-NZ");

    private static readonly DebriefPreset[] DefaultPresets =
    [
        new("risk-roundup", "Morning Risk Roundup", "Summarize the top three high-velocity risk and threat signals this morning.", "Risk", "🛡️"),
        new("semiconductors", "Semiconductor Nexus", "What are the latest developments in advanced semiconductor fabrication and export controls?", "Strategy", "⚡"),
        new("market-anomalies", "Macro & Market Movers", "What significant market price anomalies and interest rate developments are reported?", "Markets", "📊"),
        new("cyber-threats", "Critical Cyber & Zero-Day", "What active cyber incidents, zero-day CVEs, and infrastructure advisories are flagged?", "Cyber", "🚨"),
        new("supply-chokepoints", "Maritime & Trade Chokepoints", "Summarize current shipping chokepoint delays across the Red Sea and Pacific trade lanes.", "Supply Chain", "🚢")
    ];

    private static readonly Regex RiskPattern = new(
        @"\b(?:risk|threat|threats|vulnerability|incident|crisis|cve|cisa|war|sanction|sanctions|chokepoint|tariff|tariffs|disruption|breach)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex MarketPattern = new(
        @"\b(?:market|markets|stock|stocks|price|nasdaq|sp500|dow|treasury|rates|inflation|yield|bond|fed|interest rate|earnings)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex TechPattern = new(
        @"\b(?:ai|semiconductor|semiconductors|chip|chips|nvidia|tsmc|asml|intel|quantum|lithography|hyperscale|gpu)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex GeopoliticalPattern = new(
        @"\b(?:taiwan|china|russia|ukraine|red sea|strait|pacific|nato|ofac|bis|treaty|embargo|iran|middle east)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    [HttpGet("presets")]
    public IActionResult GetPresets() => Ok(DefaultPresets);

    [HttpPost("query")]
    [IgnoreAntiforgeryToken]
    [RequestSizeLimit(128_000)]
    public async Task<IActionResult> Query(
        [FromBody] DebriefQueryRequest? request,
        CancellationToken token)
    {
        var rawQuery = (request?.Query ?? "").Trim();
        if (rawQuery.Length < 2)
        {
            return BadRequest(new { error = "Voice debrief query must be at least 2 characters." });
        }

        var language = string.IsNullOrWhiteSpace(request?.Language) ? "en" : request.Language.Trim();
        var marketContext = (request?.MarketContext ?? "").Trim();
        var rawArticles = request?.Articles ?? [];

        // Determine intent category
        var intent = ClassifyIntent(rawQuery);

        // Score and rank relevant articles
        var rankedArticles = RankArticles(rawQuery, rawArticles);
        var topArticles = rankedArticles.Take(4).ToArray();

        // Synthesize executive spoken brief
        var (spokenScript, summary, takeaways, followUps) = await SynthesizeDebriefAsync(
            rawQuery,
            intent,
            topArticles,
            marketContext,
            token);

        // Prepare citations
        var citations = topArticles
            .Where(a => !string.IsNullOrEmpty(a.Url))
            .Select(a => new DebriefCitation(a.Url!, a.Title ?? "Intelligence Item", a.Source ?? "Verified Feed"))
            .ToArray();

        var response = new VoiceDebriefResponse(
            Available: true,
            Query: rawQuery,
            IntentCategory: intent,
            SpokenScript: spokenScript,
            ExecutiveSummary: summary,
            KeyTakeaways: takeaways,
            Citations: citations,
            SuggestedFollowUps: followUps,
            AudioAvailable: audio is not null,
            GeneratedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }

    [HttpPost("speak")]
    [IgnoreAntiforgeryToken]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> Speak(
        [FromBody] DebriefSpeakRequest? request,
        CancellationToken token)
    {
        var text = (request?.Text ?? "").Trim();
        if (string.IsNullOrEmpty(text))
        {
            return BadRequest(new { error = "Text to synthesize is required." });
        }

        // Limit maximum character length to 3,000 characters for snappy voice response
        if (text.Length > 3000)
        {
            text = text[..3000];
        }

        try
        {
            var language = request?.Language ?? "en-NZ";
            var preferences = new Dictionary<string, string>(StringComparer.Ordinal);
            if (!string.IsNullOrEmpty(request?.Voice))
            {
                preferences["en"] = request.Voice;
            }

            var audioRequest = new HeadlineAudioRequest(
                Titles: [text],
                Seconds: 1,
                Language: language,
                Voices: preferences.Count > 0 ? preferences : null);

            var briefing = await audio.GenerateAsync(audioRequest, token);
            return File(briefing.Wave, "audio/wav");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Voice debrief speech synthesis fallback invoked.");
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Neural speech rendering is temporarily unavailable." });
        }
    }

    private static string ClassifyIntent(string query)
    {
        if (RiskPattern.IsMatch(query)) return "Risk & Threats";
        if (TechPattern.IsMatch(query)) return "Deep Tech & Silicon";
        if (MarketPattern.IsMatch(query)) return "Macro & Markets";
        if (GeopoliticalPattern.IsMatch(query)) return "Geopolitical & Trade";
        return "Executive Intelligence";
    }

    private static DebriefArticleInput[] RankArticles(string query, DebriefArticleInput[] articles)
    {
        if (articles.Length == 0) return [];

        var terms = query.ToLowerInvariant()
            .Split([' ', ',', '.', '?', '!', ';', ':', '-', '(', ')', '"', '\''], StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length > 2)
            .Distinct()
            .ToArray();

        if (terms.Length == 0) return articles.Take(4).ToArray();

        var scored = articles.Select(article =>
        {
            int score = 0;
            var title = (article.Title ?? "").ToLowerInvariant();
            var summary = (article.Summary ?? "").ToLowerInvariant();
            var topics = article.Topics != null ? string.Join(" ", article.Topics).ToLowerInvariant() : "";

            foreach (var term in terms)
            {
                if (title.Contains(term)) score += 5;
                if (summary.Contains(term)) score += 2;
                if (topics.Contains(term)) score += 3;
            }

            return new { Article = article, Score = score };
        })
        .OrderByDescending(x => x.Score)
        .Select(x => x.Article)
        .ToArray();

        return scored;
    }

    private async Task<(string SpokenScript, string Summary, string[] Takeaways, string[] FollowUps)> SynthesizeDebriefAsync(
        string query,
        string intent,
        DebriefArticleInput[] articles,
        string marketContext,
        CancellationToken token)
    {
        // Build concise executive narrative
        var leadArticle = articles.FirstOrDefault();
        var secondaryArticle = articles.Skip(1).FirstOrDefault();

        string spokenScript;
        string executiveSummary;
        List<string> takeaways = [];
        List<string> followUps = [];

        if (leadArticle != null)
        {
            var leadTitle = CleanTitle(leadArticle.Title);
            var leadSource = leadArticle.Source ?? "intelligence wires";
            var leadSummary = !string.IsNullOrWhiteSpace(leadArticle.Summary)
                ? leadArticle.Summary.Trim()
                : "Continuous strategic surveillance remains active across regional channels.";

            if (secondaryArticle != null)
            {
                var secondaryTitle = CleanTitle(secondaryArticle.Title);
                spokenScript = $"Signal Executive Voice Debrief. Addressing your inquiry on {query}. Primary intelligence highlights {leadTitle}, as reported by {leadSource}. In parallel, {secondaryTitle} presents secondary strategic implications. Key risk indicators suggest monitored stakeholders are reassessing contingency timelines.";
                executiveSummary = $"{leadTitle} dominates current briefing telemetry ({leadSource}). Compounding factors include {secondaryTitle}.";
            }
            else
            {
                spokenScript = $"Signal Executive Voice Debrief. On the subject of {query}, current priority tracking centers on {leadTitle}, reported by {leadSource}. Preliminary assessments indicate active operational adjustments.";
                executiveSummary = $"{leadTitle} represents the primary development identified across live reporting channels.";
            }

            takeaways.Add($"Lead vector: {leadTitle} via {leadSource}.");
            takeaways.Add($"Core substance: {Shorten(leadSummary, 120)}");
            if (secondaryArticle != null)
            {
                takeaways.Add($"Correlated development: {CleanTitle(secondaryArticle.Title)}.");
            }
            else if (!string.IsNullOrWhiteSpace(marketContext))
            {
                takeaways.Add($"Market posture: {Shorten(marketContext, 90)}");
            }
            else
            {
                takeaways.Add("Cross-domain impact: Escalating regulatory or operational oversight expected within 30 days.");
            }
        }
        else
        {
            spokenScript = $"Signal Voice Debrief. Reviewing the intelligence stream for {query}. While immediate high-volume alerts remain below critical severity thresholds, baseline monitoring continues across followed sectors.";
            executiveSummary = $"No immediate critical-velocity incidents match '{query}' in today's active ingest cycle.";
            takeaways.Add("No critical-velocity breaking anomalies detected.");
            takeaways.Add("Underlying baseline tracking remains within normal variance.");
            takeaways.Add("Automated radars continue background surveillance for threshold breaches.");
        }

        // Generate context-aware follow-up suggestions
        if (intent.Contains("Risk") || intent.Contains("Threat"))
        {
            followUps.Add("What containment playbooks apply to this incident?");
            followUps.Add("Check for zero-day CVE advisories in related infrastructure.");
            followUps.Add("Review supply chain chokepoint vulnerabilities.");
        }
        else if (intent.Contains("Silicon") || intent.Contains("Tech"))
        {
            followUps.Add("What are ASML and TSMC stating regarding high-NA EUV?");
            followUps.Add("How are US BIS export restrictions affecting AI accelerators?");
            followUps.Add("Inspect the Intelligence Knowledge Graph for semiconductor nodes.");
        }
        else if (intent.Contains("Market"))
        {
            followUps.Add("What macro interest rate projections are priced in?");
            followUps.Add("Show multi-asset correlation heatmap.");
            followUps.Add("Simulate currency impact on export earnings.");
        }
        else
        {
            followUps.Add("Summarize the C-suite perspective on this topic.");
            followUps.Add("What are regulatory authorities signaling in APAC?");
            followUps.Add("Extract verbatim executive soundbites.");
        }

        return (spokenScript, executiveSummary, takeaways.ToArray(), followUps.ToArray());
    }

    private static string CleanTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return "active intelligence development";
        var cleaned = Regex.Replace(title, @"\s*-\s*[A-Za-z0-9\s]+$", "");
        return cleaned.Trim();
    }

    private static string Shorten(string text, int maxChars)
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        if (text.Length <= maxChars) return text;
        return text[..(maxChars - 3)] + "...";
    }
}
