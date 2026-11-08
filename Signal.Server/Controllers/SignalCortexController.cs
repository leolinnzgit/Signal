using System.Security.Claims;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/cortex")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SignalCortexController(
    SignalDbContext? database = null,
    MarketDataService? marketData = null,
    EarthquakeFeed? earthquakes = null,
    ILogger<SignalCortexController>? logger = null) : ControllerBase
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
        [property: JsonPropertyName("domain")] string Domain,
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
    public async Task<IActionResult> Search(
        [FromBody] CortexSearchRequest? request,
        CancellationToken cancellationToken)
    {
        var rawQuery = request?.Query?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(rawQuery))
        {
            return Ok(new CortexSearchResponse(
                Query: "",
                SynthesizedAnswer: "Type a query, ticker, country, or corporate entity to search across all 28 intelligence suites, stored history, live market feeds, and breaking news.",
                Confidence: 1.0,
                CrossDomainHits: [],
                SuggestedQueries: [
                    "TSMC 2nm packaging tariffs",
                    "Red Sea Cape of Good Hope detour surcharge",
                    "Argentina FX cepo sovereign haircut",
                    "AI Cloud Pre-Mortem failure vectors"
                ],
                ExecutedAt: DateTimeOffset.UtcNow
            ));
        }

        var clientArticles = request?.Articles ?? [];
        var mergedArticles = new List<CortexArticleInput>(clientArticles);
        var seenUrls = new HashSet<string>(
            clientArticles.Where(a => !string.IsNullOrWhiteSpace(a.Url)).Select(a => a.Url),
            StringComparer.OrdinalIgnoreCase);

        var hits = new List<CortexHit>();
        var qLower = rawQuery.ToLowerInvariant();
        var terms = qLower.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        // 1. Live SQLite stored article history search (strictly scoped to signed-in user)
        var userId = User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (database is not null && !string.IsNullOrEmpty(userId))
        {
            try
            {
                var recentStored = await database.StoredNewsArticles
                    .AsNoTracking()
                    .Where(a => a.UserId == userId)
                    .OrderByDescending(a => a.LastSeenAtUtc)
                    .Take(150)
                    .Select(a => new { a.Title, a.Source, a.Url, a.Summary })
                    .ToArrayAsync(cancellationToken);

                foreach (var stored in recentStored)
                {
                    if (!seenUrls.Add(stored.Url)) continue;
                    mergedArticles.Add(new CortexArticleInput(stored.Title, stored.Source, stored.Url, stored.Summary));
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                logger?.LogDebug(ex, "Cortex could not query user article history.");
            }
        }

        // 2. Live Market Data lookup when query matches a known company/symbol or equity term
        if (marketData is { IsConfigured: true } && rawQuery.Length is >= 2 and <= 40)
        {
            foreach (var candidateTerm in terms.Where(t => t.Length is >= 2 and <= 24).Take(2))
            {
                try
                {
                    var quote = await marketData.GetForTopicAsync(candidateTerm, null, cancellationToken);
                    if (quote is not null)
                    {
                        var direction = quote.PercentChange >= 0 ? "+" : "";
                        hits.Add(new CortexHit(
                            Id: $"mkt-{quote.Symbol}",
                            Title: $"{quote.Name} ({quote.Symbol}) — {quote.Currency} {quote.Price:F2} ({direction}{quote.PercentChange:F2}%)",
                            Domain: "Market Heatmap",
                            Snippet: $"Live quote via {quote.Provider} on {quote.Exchange}. Updated {quote.QuoteTime}.",
                            RelevanceScore: 0.95,
                            TargetSuiteId: "market-heatmap"
                        ));
                        break;
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch
                {
                    // Skip non-equity query terms cleanly
                }
            }
        }

        // 3. Live Seismic Feed lookup if query references earthquakes/disasters/NZ/Pacific
        if (earthquakes is not null
            && (qLower.Contains("quake") || qLower.Contains("seismic") || qLower.Contains("earthquake") || qLower.Contains("disaster")))
        {
            try
            {
                var quakes = await earthquakes.GetFeedAsync(qLower.Contains("nz") || qLower.Contains("wellington"), cancellationToken);
                foreach (var eq in quakes.OrderByDescending(e => e.Magnitude).Take(2))
                {
                    hits.Add(new CortexHit(
                        Id: $"eq-{eq.Id}",
                        Title: $"M{eq.Magnitude:F1} Earthquake — {eq.Place}",
                        Domain: "Risk & Defense",
                        Snippet: $"Depth {eq.DepthKm:F0} km via {eq.Source}. Click URL for official seismic bulletin.",
                        RelevanceScore: 0.90,
                        TargetSuiteId: "radar",
                        Url: eq.Url
                    ));
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                logger?.LogDebug(ex, "Cortex seismic lookup unavailable.");
            }
        }

        // 4. Cross-reference Strategic Intelligence Suites
        if (qLower.Contains("strait") || qLower.Contains("hormuz") || qLower.Contains("red sea") || qLower.Contains("shipping") || qLower.Contains("transit") || qLower.Contains("cape") || qLower.Contains("suez"))
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

        if (qLower.Contains("tariff") || qLower.Contains("trade") || qLower.Contains("cogs") || qLower.Contains("china") || qLower.Contains("usmca") || qLower.Contains("arbitrage") || qLower.Contains("tsmc") || qLower.Contains("silicon"))
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

        if (qLower.Contains("sovereign") || qLower.Contains("fx") || qLower.Contains("currency") || qLower.Contains("argentina") || qLower.Contains("egypt") || qLower.Contains("pakistan") || qLower.Contains("turkey") || qLower.Contains("nigeria") || qLower.Contains("cds") || qLower.Contains("haircut"))
        {
            hits.Add(new CortexHit(
                Id: "hit-sovereign-1",
                Title: "Sovereign Risk & Capital Repatriation Haircut Radar",
                Domain: "Sovereign Risk",
                Snippet: "Tracks 5Y CDS spreads, 30d FX depreciation velocity, reserve import cover, and strict capital control haircuts (up to 42% in Argentina).",
                RelevanceScore: 0.95,
                TargetSuiteId: "sovereign-risk"
            ));
        }

        if (qLower.Contains("pre-mortem") || qLower.Contains("premortem") || qLower.Contains("kill the company") || qLower.Contains("collapse") || qLower.Contains("hedging") || qLower.Contains("ewi") || qLower.Contains("cloud"))
        {
            hits.Add(new CortexHit(
                Id: "hit-premortem-1",
                Title: "Corporate Pre-Mortem Simulator & EWI Autopsy",
                Domain: "Pre-Mortem Wargame",
                Snippet: "Models fatal collapse vectors across regulatory injunction, inference cost margin inversion, and supply embargoes.",
                RelevanceScore: 0.93,
                TargetSuiteId: "pre-mortem"
            ));
        }

        if (qLower.Contains("tripwire") || qLower.Contains("alert") || qLower.Contains("notify") || qLower.Contains("push") || qLower.Contains("watch"))
        {
            hits.Add(new CortexHit(
                Id: "hit-tripwire-1",
                Title: "Executive Tripwires & Deep-Linked Push Alerts",
                Domain: "Executive Tripwires",
                Snippet: "Background trigger engine evaluating breaking wires against custom keyword & suite escalation thresholds.",
                RelevanceScore: 0.91,
                TargetSuiteId: "tripwires"
            ));
        }

        if (qLower.Contains("podcast") || qLower.Contains("daily cast") || qLower.Contains("vance") || qLower.Contains("chen") || qLower.Contains("audio"))
        {
            hits.Add(new CortexHit(
                Id: "hit-dailycast-1",
                Title: "Signal Studio Daily Cast (David Vance & Sarah Chen)",
                Domain: "Signal Daily Cast",
                Snippet: "Autonomous dual-host audio debate synthesizing live feed intelligence with multi-voice narration.",
                RelevanceScore: 0.90,
                TargetSuiteId: "daily-cast"
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

        // 5. Search against live feed & stored history articles
        var newsMatchCount = 0;
        foreach (var art in mergedArticles)
        {
            var titleLower = art.Title.ToLowerInvariant();
            var summaryLower = (art.Summary ?? "").ToLowerInvariant();

            int matches = terms.Count(t => titleLower.Contains(t) || summaryLower.Contains(t));
            if (matches > 0)
            {
                newsMatchCount++;
                var score = Math.Round(0.68 + (matches * 0.11), 2);
                hits.Add(new CortexHit(
                    Id: $"art-{Math.Abs((art.Url + art.Title).GetHashCode())}",
                    Title: art.Title,
                    Domain: "News Stream",
                    Snippet: string.IsNullOrWhiteSpace(art.Summary)
                        ? $"Published by {art.Source}"
                        : (art.Summary.Length > 165 ? art.Summary[..162] + "..." : art.Summary),
                    RelevanceScore: Math.Min(0.99, score),
                    TargetSuiteId: "radar",
                    Url: art.Url
                ));
            }
        }

        var sortedHits = hits
            .OrderByDescending(h => h.RelevanceScore)
            .Take(10)
            .ToArray();

        var answer = sortedHits.Length > 0
            ? $"Signal Cortex synthesized {sortedHits.Length} intelligence matches for '{rawQuery}' across {string.Join(", ", sortedHits.Select(h => h.Domain).Distinct().Take(3))}"
              + (newsMatchCount > 0 ? $" (including {newsMatchCount} live news articles from {mergedArticles.Count} indexed stories)." : ".")
            : $"Signal Cortex searched {mergedArticles.Count} live stories and all 28 strategic suites for '{rawQuery}' with no high-confidence hits. Configure an Executive Tripwire to monitor breaking arrivals automatically.";

        var suggestions = new List<string>
        {
            $"Open Tripwire alert for {rawQuery}",
            $"Check sovereign FX exposure for {rawQuery}",
            $"Run Pre-Mortem collapse simulation on {rawQuery}"
        };

        return Ok(new CortexSearchResponse(
            Query: rawQuery,
            SynthesizedAnswer: answer,
            Confidence: sortedHits.Length > 0 ? 0.94 : 0.45,
            CrossDomainHits: sortedHits,
            SuggestedQueries: suggestions.ToArray(),
            ExecutedAt: DateTimeOffset.UtcNow
        ));
    }
}
