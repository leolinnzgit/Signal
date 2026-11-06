using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/briefing-studio")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class BriefingStudioController : ControllerBase
{
    public sealed record BroadcastTemplate(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("targetDurationSeconds")] int TargetDurationSeconds,
        [property: JsonPropertyName("aspectRatios")] string[] AspectRatios, // ["16:9", "9:16"]
        [property: JsonPropertyName("themeColor")] string ThemeColor,
        [property: JsonPropertyName("description")] string Description);

    public sealed record StudioArticleInput(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("summary")] string? Summary);

    public sealed record StoryboardRequest(
        [property: JsonPropertyName("templateId")] string? TemplateId,
        [property: JsonPropertyName("aspectRatio")] string? AspectRatio,
        [property: JsonPropertyName("articles")] StudioArticleInput[]? Articles);

    public sealed record GraphicDataPoint(
        [property: JsonPropertyName("label")] string Label,
        [property: JsonPropertyName("value")] string Value,
        [property: JsonPropertyName("color")] string? Color = null);

    public sealed record StoryboardScene(
        [property: JsonPropertyName("sceneIndex")] int SceneIndex,
        [property: JsonPropertyName("durationSeconds")] double DurationSeconds,
        [property: JsonPropertyName("headline")] string Headline,
        [property: JsonPropertyName("subheadline")] string Subheadline,
        [property: JsonPropertyName("narrationScript")] string NarrationScript,
        [property: JsonPropertyName("graphicType")] string GraphicType, // "bar-chart" | "threat-dial" | "ticker-alert" | "quote-focus"
        [property: JsonPropertyName("graphicData")] GraphicDataPoint[] GraphicData);

    public sealed record StoryboardResponse(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("templateId")] string TemplateId,
        [property: JsonPropertyName("aspectRatio")] string AspectRatio,
        [property: JsonPropertyName("totalDurationSeconds")] double TotalDurationSeconds,
        [property: JsonPropertyName("tickerHeadlines")] string[] TickerHeadlines,
        [property: JsonPropertyName("scenes")] StoryboardScene[] Scenes,
        [property: JsonPropertyName("generatedAt")] DateTimeOffset GeneratedAt);

    private static readonly BroadcastTemplate[] DefaultTemplates =
    [
        new(
            Id: "market-open",
            Title: "Morning Market Open Pulse",
            TargetDurationSeconds: 30,
            AspectRatios: ["16:9", "9:16"],
            ThemeColor: "#38bdf8",
            Description: "Rapid 30-second financial pulse tracking overnight futures, Treasury yields, tech momentum, and currency crosses."
        ),
        new(
            Id: "threat-matrix",
            Title: "Strategic Threat Matrix & Flashpoints",
            TargetDurationSeconds: 45,
            AspectRatios: ["16:9", "9:16"],
            ThemeColor: "#f87171",
            Description: "Geopolitical and cyber threat command briefing highlighting active chokepoints, critical CVEs, and supply vulnerabilities."
        ),
        new(
            Id: "csuite-wrap",
            Title: "C-Suite Strategic Executive Digest",
            TargetDurationSeconds: 60,
            AspectRatios: ["16:9", "9:16"],
            ThemeColor: "#a855f7",
            Description: "Comprehensive board-level digest synthesizing competitor M&A, regulatory antitrust rulings, and quarterly milestones."
        )
    ];

    [HttpGet("templates")]
    public IActionResult GetTemplates()
    {
        return Ok(DefaultTemplates);
    }

    [HttpPost("storyboard")]
    [IgnoreAntiforgeryToken]
    public IActionResult GenerateStoryboard([FromBody] StoryboardRequest? request)
    {
        var templateId = request?.TemplateId?.Trim().ToLowerInvariant() ?? "threat-matrix";
        var aspectRatio = request?.AspectRatio?.Trim() ?? "16:9";
        var template = DefaultTemplates.FirstOrDefault(t => t.Id == templateId) ?? DefaultTemplates[1];

        var articles = request?.Articles ?? [];

        // Build scenes based on template
        var scenes = templateId switch
        {
            "market-open" => BuildMarketOpenScenes(articles),
            "csuite-wrap" => BuildCSuiteWrapScenes(articles),
            _ => BuildThreatMatrixScenes(articles)
        };

        var ticker = articles.Length > 0
            ? articles.Select(a => $"{a.Source.ToUpperInvariant()}: {a.Title}").Take(8).ToArray()
            : [
                "SIGNAL WIRE: Taiwan Strait maritime transit monitoring active ADIZ incursions.",
                "MACRO: US 10-Year Treasury Yields steady at 4.28% ahead of CPI data.",
                "ENERGY: Brent crude futures consolidate near $82.40 on Red Sea routing premiums.",
                "TECH: TSMC completes trial 2nm wafer tape-out with high numerical-aperture EUV."
            ];

        var totalSeconds = scenes.Sum(s => s.DurationSeconds);

        var response = new StoryboardResponse(
            Title: $"SIGNAL BROADCAST • {template.Title.ToUpperInvariant()}",
            TemplateId: template.Id,
            AspectRatio: aspectRatio,
            TotalDurationSeconds: totalSeconds,
            TickerHeadlines: ticker,
            Scenes: scenes,
            GeneratedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }

    private static StoryboardScene[] BuildThreatMatrixScenes(StudioArticleInput[] articles)
    {
        var leadTitle = articles.FirstOrDefault()?.Title ?? "Global Maritime Chokepoints Face Sustained Detour Pressure";
        var leadSource = articles.FirstOrDefault()?.Source ?? "Signal Intelligence";

        return
        [
            new(
                SceneIndex: 1,
                DurationSeconds: 10.0,
                Headline: "STRATEGIC THREAT RADAR OVERVIEW",
                Subheadline: "Live Telemetry from 7 Global Maritime Chokepoints",
                NarrationScript: "Good morning. Signal Threat Command reports critical risk postures across the southern Red Sea and Hormuz corridors. 65% of global container transit remains diverted via the Cape of Good Hope.",
                GraphicType: "threat-dial",
                GraphicData: [
                    new("Bab el-Mandeb", "CRITICAL", "#ef4444"),
                    new("Strait of Hormuz", "HIGH", "#f97316"),
                    new("Taiwan Strait", "ELEVATED", "#eab308"),
                    new("Strait of Malacca", "NORMAL", "#10b981")
                ]
            ),
            new(
                SceneIndex: 2,
                DurationSeconds: 12.0,
                Headline: leadTitle.Length > 55 ? leadTitle[..52] + "..." : leadTitle,
                Subheadline: $"Source Verification: {leadSource}",
                NarrationScript: $"Focusing on breaking developments: {leadTitle}. Intelligence analysts note commercial detour costs have stabilized at 38% fuel surcharges, adding 12 sailing days for European inbound logistics.",
                GraphicType: "bar-chart",
                GraphicData: [
                    new("Cape Reroute", "+12.0 Days", "#f87171"),
                    new("Bunker Surcharge", "+38.5%", "#fb923c"),
                    new("War Risk Premium", "+280%", "#f87171"),
                    new("Schedule Reliability", "52.4%", "#eab308")
                ]
            ),
            new(
                SceneIndex: 3,
                DurationSeconds: 10.0,
                Headline: "EXECUTIVE DIRECTIVES & PLAYBOOKS",
                Subheadline: "Recommended Immediate Containment Measures",
                NarrationScript: "Recommended executive actions: lock in 45-day bunker fuel futures hedges, advance tier-1 European delivery windows by 12 days, and review war risk hull deductibles with maritime syndicates.",
                GraphicType: "ticker-alert",
                GraphicData: [
                    new("Directive 1", "Lock in 45-day bunker fuel futures hedges"),
                    new("Directive 2", "Advance European delivery windows by 12 days"),
                    new("Directive 3", "Audit tier-2 supply buffers outside high-risk lanes")
                ]
            )
        ];
    }

    private static StoryboardScene[] BuildMarketOpenScenes(StudioArticleInput[] articles)
    {
        return
        [
            new(
                SceneIndex: 1,
                DurationSeconds: 10.0,
                Headline: "MORNING MARKET OPEN PULSE",
                Subheadline: "Global Equity Futures & Cross-Asset Momentum",
                NarrationScript: "Signal Market Pulse. Global indices opened firm this morning led by semiconductor equipment manufacturers, while crude oil consolidates as geopolitical risk premiums remain priced in.",
                GraphicType: "bar-chart",
                GraphicData: [
                    new("S&P 500 Futures", "+0.42%", "#10b981"),
                    new("Nasdaq 100", "+0.78%", "#10b981"),
                    new("US 10-Yr Yield", "4.28%", "#38bdf8"),
                    new("Brent Crude", "$82.40", "#f59e0b")
                ]
            ),
            new(
                SceneIndex: 2,
                DurationSeconds: 10.0,
                Headline: "SECTOR LIQUIDITY & TECH MOMENTUM",
                Subheadline: "Sub-2nm Foundry Capex & AI Server Delivery Schedules",
                NarrationScript: "Technology leadership continues with advanced packaging capacity fully allocated through next year. Cloud capital expenditure forecasts point to sustained enterprise deployment.",
                GraphicType: "threat-dial",
                GraphicData: [
                    new("Semiconductors", "OVERWEIGHT", "#10b981"),
                    new("Enterprise Software", "NEUTRAL", "#38bdf8"),
                    new("Clean Energy", "CAUTION", "#f59e0b"),
                    new("Commercial RE", "UNDERWEIGHT", "#ef4444")
                ]
            ),
            new(
                SceneIndex: 3,
                DurationSeconds: 10.0,
                Headline: "STRATEGIC MACRO WATCH",
                Subheadline: "Upcoming Central Bank & Trade Policy Catalysts",
                NarrationScript: "Traders and strategic planners are watching upcoming central bank inflation releases and new bilateral export control guidelines scheduled for publication later this week.",
                GraphicType: "ticker-alert",
                GraphicData: [
                    new("CPI Print", "Forecast 2.6% YoY"),
                    new("Central Bank Rate", "Held at 5.25% terminal"),
                    new("Currency Cross", "USD/JPY steady at 154.20")
                ]
            )
        ];
    }

    private static StoryboardScene[] BuildCSuiteWrapScenes(StudioArticleInput[] articles)
    {
        return
        [
            new(
                SceneIndex: 1,
                DurationSeconds: 12.0,
                Headline: "C-SUITE STRATEGIC EXECUTIVE DIGEST",
                Subheadline: "Weekly Board Briefing & Multi-Domain Synthesis",
                NarrationScript: "Welcome to the C-Suite Strategic Wrap. This week's intelligence centers on aggressive competitor M&A consolidation in APAC, coupled with tighter cross-border antitrust scrutiny across digital marketplaces.",
                GraphicType: "bar-chart",
                GraphicData: [
                    new("Rival M&A Pace", "14 Deals Announced", "#38bdf8"),
                    new("Antitrust Inquiries", "3 Formal Filings", "#f87171"),
                    new("EBITDA Variance", "-40 bps", "#f59e0b"),
                    new("Capital Deployed", "$1.4B YTD", "#10b981")
                ]
            ),
            new(
                SceneIndex: 2,
                DurationSeconds: 12.0,
                Headline: "REGULATORY & GOVERNANCE DEVELOPMENTS",
                Subheadline: "Compliance Directives & Dual-Use Export Restrictions",
                NarrationScript: "On the regulatory horizon, new dual-use technology classifications under ECCN 3A090 are requiring certified end-user validations, prompting leadership to accelerate nearshore assembly diversification.",
                GraphicType: "threat-dial",
                GraphicData: [
                    new("Antitrust Gatekeeper", "HIGH", "#f87171"),
                    new("Export Control Compliance", "CRITICAL", "#ef4444"),
                    new("ESG Disclosure Audit", "NORMAL", "#10b981"),
                    new("Labor Pact Negotiation", "ELEVATED", "#eab308")
                ]
            ),
            new(
                SceneIndex: 3,
                DurationSeconds: 10.0,
                Headline: "STRATEGIC HORIZON TARGETS",
                Subheadline: "Key Milestones for the Next 90 Days",
                NarrationScript: "Leadership priorities for the quarter: finalize secondary wafer packaging agreements, complete the independent antitrust compliance audit, and prepare contingency logistics for fall trade lane shifts.",
                GraphicType: "ticker-alert",
                GraphicData: [
                    new("Priority 1", "Execute nearshoring assembly in Monterrey"),
                    new("Priority 2", "Submit EU interoperability compliance brief"),
                    new("Priority 3", "Present revised capital allocation plan to Board")
                ]
            )
        ];
    }
}
