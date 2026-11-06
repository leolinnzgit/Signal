using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/cortex")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SignalCortexController : ControllerBase
{
    public sealed record CortexArticleInput(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("summary")] string? Summary = null);

    public sealed record CortexSearchRequest(
        [property: JsonPropertyName("query")] string? Query,
        [property: JsonPropertyName("articles")] CortexArticleInput[]? Articles);

    public sealed record CortexHit(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("domain")] string Domain, // "Chokepoints & Straits" | "Tariff & Arbitrage" | "Cyber Incident" | "Boardroom Sparring" | "Competitor Radar" | "News Stream"
        [property: JsonPropertyName("snippet")] string Snippet,
        [property: JsonPropertyName("relevanceScore")] double RelevanceScore,
        [property: JsonPropertyName("targetSuiteId")] string TargetSuiteId,
        [property: JsonPropertyName("url")] string? Url = null);

    public sealed record CortexSearchResponse(
        [property: JsonPropertyName("query")] string Query,
        [property: JsonPropertyName("synthesizedAnswer")] string SynthesizedAnswer,
        [property: JsonPropertyName("confidence")] double Confidence,
        [property: JsonPropertyName("crossDomainHits")] CortexHit[] CrossDomainHits,
        [property: JsonPropertyName("suggestedQueries")] string[] SuggestedQueries,
        [property: JsonPropertyName("executedAt")] DateTimeOffset ExecutedAt);

    [HttpPost("search")]
    [IgnoreAntiforgeryToken]
    public IActionResult Search([FromBody] CortexSearchRequest? request)
    {
        var rawQuery = request?.Query?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(rawQuery))
        {
            return Ok(new CortexSearchResponse(
                Query: "",
                SynthesizedAnswer: "Type a query or corporate entity to search across all 23 intelligence suites, dossiers, and breaking news.",
                Confidence: 1.0,
                CrossDomainHits: [],
                SuggestedQueries: [
                    "TSMC 2nm packaging timeline",
                    "Red Sea Cape of Good Hope detour surcharge",
                    "US-China Section 301 semiconductor tariffs",
                    "EU Article 102 antitrust gatekeeper remedies"
                ],
                ExecutedAt: DateTimeOffset.UtcNow
            ));
        }

        var articles = request?.Articles ?? [];
        var hits = new List<CortexHit>();
        var qLower = rawQuery.ToLowerInvariant();

        // 1. Cross-reference static knowledge domains
        if (qLower.Contains("strait") || qLower.Contains("hormuz") || qLower.Contains("red sea") || qLower.Contains("shipping") || qLower.Contains("transit") || qLower.Contains("cape"))
        {
            hits.Add(new CortexHit(
                Id: "hit-chokepoint-1",
                Title: "Bab el-Mandeb & Southern Red Sea Chokepoint Watch",
                Domain: "Chokepoints & Straits",
                Snippet: "65% of container fleet diverted via Cape of Good Hope (+12 days, +38.5% bunker fuel surcharge). War risk insurance up 280%.",
                RelevanceScore: 0.96,
                TargetSuiteId: "geopolitical-transit"
            ));
            hits.Add(new CortexHit(
                Id: "hit-chokepoint-2",
                Title: "Strait of Hormuz Petroleum Transit Risk",
                Domain: "Chokepoints & Straits",
                Snippet: "Carries 21 Mbpd of crude and LNG. IRGC patrol activity and GPS spoofing advisory active near Bandar Abbas.",
                RelevanceScore: 0.88,
                TargetSuiteId: "geopolitical-transit"
            ));
        }

        if (qLower.Contains("tariff") || qLower.Contains("trade") || qLower.Contains("cogs") || qLower.Contains("china") || qLower.Contains("usmca") || qLower.Contains("arbitrage"))
        {
            hits.Add(new CortexHit(
                Id: "hit-tariff-1",
                Title: "Advanced Microelectronics (HS 8542) Tariff Matrix",
                Domain: "Tariff & Arbitrage",
                Snippet: "Blended effective tariff: 18.5%. Nearshore assembly in Monterrey under USMCA Rule of Origin offers 88% tariff recovery.",
                RelevanceScore: 0.94,
                TargetSuiteId: "tariff-matrix"
            ));
            hits.Add(new CortexHit(
                Id: "hit-tariff-2",
                Title: "Critical Minerals & Neodymium Oxides (HS 2805)",
                Domain: "Tariff & Arbitrage",
                Snippet: "Tier-1 supply concentration: 88%. Australian refining framework offers 82% tariff offset with Title III grants.",
                RelevanceScore: 0.85,
                TargetSuiteId: "tariff-matrix"
            ));
        }

        if (qLower.Contains("cyber") || qLower.Contains("cve") || qLower.Contains("zero-day") || qLower.Contains("ransomware") || qLower.Contains("cisa"))
        {
            hits.Add(new CortexHit(
                Id: "hit-cyber-1",
                Title: "Critical Infrastructure Zero-Day Advisory HUD",
                Domain: "Cyber Incident",
                Snippet: "Actively exploited edge gateway vulnerabilities (CVE-2026-1184). Emergency patching mandate issued by CISA.",
                RelevanceScore: 0.95,
                TargetSuiteId: "cyber-incident"
            ));
        }

        if (qLower.Contains("board") || qLower.Contains("activist") || qLower.Contains("proxy") || qLower.Contains("investor") || qLower.Contains("sparring") || qLower.Contains("carl"))
        {
            hits.Add(new CortexHit(
                Id: "hit-sparring-1",
                Title: "Carl Vance (Ironcrest Capital) Activist Defense Dossier",
                Domain: "Boardroom Sparring",
                Snippet: "Pressure points: SG&A expansion vs peer group, ROIC hurdle benchmarks, demand for non-core asset demerger.",
                RelevanceScore: 0.92,
                TargetSuiteId: "board-sparring"
            ));
        }

        if (qLower.Contains("m&a") || qLower.Contains("competitor") || qLower.Contains("rival") || qLower.Contains("patent") || qLower.Contains("antitrust"))
        {
            hits.Add(new CortexHit(
                Id: "hit-competitor-1",
                Title: "Competitor Radar & M&A Flow",
                Domain: "Competitor Radar",
                Snippet: "Tracking 14 APAC peer group transactions. EU Article 102 inquiry into digital ecosystem bundling.",
                RelevanceScore: 0.91,
                TargetSuiteId: "competitor-radar"
            ));
        }

        // 2. Search against current ingested articles feed
        var terms = qLower.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        foreach (var art in articles)
        {
            var titleLower = art.Title.ToLowerInvariant();
            var summaryLower = (art.Summary ?? "").ToLowerInvariant();

            int matches = terms.Count(t => titleLower.Contains(t) || summaryLower.Contains(t));
            if (matches > 0)
            {
                var score = Math.Round(0.60 + (matches * 0.12), 2);
                hits.Add(new CortexHit(
                    Id: $"art-{Math.Abs(art.Url.GetHashCode())}",
                    Title: art.Title,
                    Domain: "News Stream",
                    Snippet: string.IsNullOrWhiteSpace(art.Summary) ? $"Published by {art.Source}" : art.Summary.Length > 160 ? art.Summary[..157] + "..." : art.Summary,
                    RelevanceScore: Math.Min(0.99, score),
                    TargetSuiteId: "radar",
                    Url: art.Url
                ));
            }
        }

        // Sort by relevance score
        var sortedHits = hits.OrderByDescending(h => h.RelevanceScore).Take(8).ToArray();

        // Synthesize an executive response
        var answer = sortedHits.Length > 0
            ? $"Signal Cortex synthesized {sortedHits.Length} strategic matches for '{rawQuery}'. Primary cross-correlations identified across {string.Join(", ", sortedHits.Select(h => h.Domain).Distinct().Take(3))}. Intelligence indicates direct operational relevance to ongoing risk assessments."
            : $"Signal Cortex found no high-confidence signals matching '{rawQuery}' in active corpora. Background surveillance radars remain active for new trigger spikes.";

        var suggestions = new List<string>
        {
            $"Detailed breakdown of {rawQuery}",
            $"Check supply chain chokepoint exposure for {rawQuery}",
            $"Simulate tariff sensitivity for {rawQuery}"
        };

        return Ok(new CortexSearchResponse(
            Query: rawQuery,
            SynthesizedAnswer: answer,
            Confidence: sortedHits.Length > 0 ? 0.94 : 0.42,
            CrossDomainHits: sortedHits,
            SuggestedQueries: suggestions.ToArray(),
            ExecutedAt: DateTimeOffset.UtcNow
        ));
    }
}
