using System.Security.Claims;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/pre-mortem")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class PreMortemController(
    SignalDbContext? database = null,
    ILogger<PreMortemController>? logger = null) : ControllerBase
{
    public sealed record PreMortemInitiative(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("category")] string Category,
        [property: JsonPropertyName("capitalAtStakeUsd")] string CapitalAtStakeUsd,
        [property: JsonPropertyName("baselineRiskScore")] int BaselineRiskScore, // 0 - 100
        [property: JsonPropertyName("summary")] string Summary);

    public sealed record CollapseVector(
        [property: JsonPropertyName("vectorId")] string VectorId,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("severity")] string Severity, // "Critical" | "High" | "Moderate"
        [property: JsonPropertyName("failureMechanism")] string FailureMechanism,
        [property: JsonPropertyName("earlyWarningIndicators")] string[] EarlyWarningIndicators,
        [property: JsonPropertyName("preemptiveHedgingDirective")] string PreemptiveHedgingDirective);

    public sealed record PreMortemSimulateRequest(
        [property: JsonPropertyName("initiativeId")] string? InitiativeId,
        [property: JsonPropertyName("customTitle")] string? CustomTitle,
        [property: JsonPropertyName("horizonMonths")] int? HorizonMonths);

    public sealed record PreMortemLiveSignal(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("matchedVector")] string MatchedVector);

    public sealed record PreMortemDossier(
        [property: JsonPropertyName("initiativeId")] string InitiativeId,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("horizonMonths")] int HorizonMonths,
        [property: JsonPropertyName("executiveSummaryAutopsy")] string ExecutiveSummaryAutopsy,
        [property: JsonPropertyName("overallFatalityProbabilityPercent")] int OverallFatalityProbabilityPercent,
        [property: JsonPropertyName("collapseVectors")] CollapseVector[] CollapseVectors,
        [property: JsonPropertyName("boardRecommendation")] string BoardRecommendation,
        [property: JsonPropertyName("simulatedAt")] DateTimeOffset SimulatedAt,
        [property: JsonPropertyName("liveRiskSignals")] PreMortemLiveSignal[]? LiveRiskSignals = null);

    private static readonly PreMortemInitiative[] DefaultInitiatives =
    [
        new(
            Id: "ai-cloud-migration",
            Title: "Autonomous Enterprise AI Cloud Transformation",
            Category: "Technology & Infrastructure",
            CapitalAtStakeUsd: "$45M USD",
            BaselineRiskScore: 78,
            Summary: "Complete core architecture shift to multi-tenant frontier LLM pipelines and automated agent workflows."
        ),
        new(
            Id: "pan-european-fintech-mna",
            Title: "Pan-European Cross-Border Fintech Acquisition",
            Category: "M&A / Inorganic Growth",
            CapitalAtStakeUsd: "$120M USD",
            BaselineRiskScore: 68,
            Summary: "Acquiring Tier-2 payments processor to secure cross-border SEPA and multi-currency rails across 14 EU member states."
        ),
        new(
            Id: "critical-materials-foundry",
            Title: "Rare-Earth & Advanced Substrate Foundry Joint Venture",
            Category: "Supply Chain & Manufacturing",
            CapitalAtStakeUsd: "$85M USD",
            BaselineRiskScore: 84,
            Summary: "Building on-shore processing joint venture for gallium/germanium wafer packaging to decouple from East Asian export curbs."
        ),
        new(
            Id: "direct-consumer-health",
            Title: "Global Direct-to-Consumer Biometric Health Platform",
            Category: "Product Expansion",
            CapitalAtStakeUsd: "$30M USD",
            BaselineRiskScore: 62,
            Summary: "Direct-to-consumer connected health wearable ecosystem with recurring subscription and health analytics."
        )
    ];

    [HttpGet("initiatives")]
    public IActionResult GetInitiatives()
    {
        return Ok(DefaultInitiatives);
    }

    [HttpPost("simulate")]
    [IgnoreAntiforgeryToken]
    public async Task<IActionResult> Simulate(
        [FromBody] PreMortemSimulateRequest? request,
        CancellationToken cancellationToken)
    {
        var initiativeId = request?.InitiativeId?.Trim().ToLowerInvariant() ?? "ai-cloud-migration";
        var matched = DefaultInitiatives.FirstOrDefault(i => i.Id == initiativeId);
        var title = !string.IsNullOrWhiteSpace(request?.CustomTitle)
            ? request.CustomTitle.Trim()
            : (matched?.Title ?? "Strategic Enterprise Expansion");
        var horizon = request?.HorizonMonths is > 0 and <= 60 ? request.HorizonMonths.Value : 18;

        CollapseVector[] vectors = initiativeId switch
        {
            "ai-cloud-migration" =>
            [
                new(
                    VectorId: "ai-regulatory",
                    Name: "Regulatory Non-Compliance & Audit Injunction",
                    Severity: "Critical",
                    FailureMechanism: "Unexplainable hallucination outputs in customer-facing financial advice trigger landmark EU AI Act Article 52 investigations and mandatory operational suspension.",
                    EarlyWarningIndicators: ["Model drift exceeds 3.5% monthly divergence", "Consumer compliance complaints increase > 15%", "Vendor black-box API change unannounced"],
                    PreemptiveHedgingDirective: "Mandate deterministic rule-based verification guardrails with immutable audit trails before any model inference reaches end-users."
                ),
                new(
                    VectorId: "ai-cost-explosion",
                    Name: "Inference Token Cost Margin Inversion",
                    Severity: "High",
                    FailureMechanism: "Compound agent tool calls and retrieval token context explosion inflate unit operating costs by 410%, wiping out gross margins.",
                    EarlyWarningIndicators: ["Average tokens per transaction exceeds 18,000", "Cloud vendor API tier pricing rises by > 12%", "Cache hit ratio drops under 65%"],
                    PreemptiveHedgingDirective: "Deploy local lightweight SLM routing for triage and establish hard token quotas per tenant with circuit-breaker throttling."
                ),
                new(
                    VectorId: "ai-vendor-lockin",
                    Name: "Hyperscaler Architecture Hostage & Deprecation",
                    Severity: "Moderate",
                    FailureMechanism: "Cloud partner unilaterally deprecates proprietary embedding schema, forcing 6 months of database re-indexing downtime.",
                    EarlyWarningIndicators: ["Proprietary SDK footprint exceeds 70% of codebase", "Multi-cloud latency benchmarks abandoned"],
                    PreemptiveHedgingDirective: "Enforce strict open-standard interface wrappers (OpenAI-compatible endpoints) and bi-annual disaster recovery failover drill to secondary cloud."
                )
            ],
            "critical-materials-foundry" =>
            [
                new(
                    VectorId: "supply-embargo",
                    Name: "Geopolitical Feedstock Export Embargo",
                    Severity: "Critical",
                    FailureMechanism: "Hostile trade retaliation places unrefined gallium and precursor gases under zero-quota export licensing, shutting down smelting.",
                    EarlyWarningIndicators: ["Port customs clearing delays exceed 45 days", "Spot market precursor premiums jump > 60%", "Consular diplomatic friction elevates"],
                    PreemptiveHedgingDirective: "Establish a 9-month strategic physical reserve stockpile in domestic bonded warehouses and pre-contract alternative Australian feedstock."
                ),
                new(
                    VectorId: "capex-overrun",
                    Name: "Specialty Environmental Permitting & Capex Overrun",
                    Severity: "High",
                    FailureMechanism: "Hydrofluoric acid handling permits stalled in municipal courts; construction delays double debt financing service burden.",
                    EarlyWarningIndicators: ["Local environmental EPA review exceeds 180 days", "EPC contractor contingency budget 80% consumed"],
                    PreemptiveHedgingDirective: "Structure EPC contract as fixed-price turnkey with liquidated damages and obtain multi-jurisdiction secondary site option."
                ),
                new(
                    VectorId: "talent-poach",
                    Name: "Foundry Process Engineering Brain Drain",
                    Severity: "Moderate",
                    FailureMechanism: "Rival sovereign-backed consortium poaches top 12 metallurgical engineers with 3x compensation packages.",
                    EarlyWarningIndicators: ["Senior staff turnover in specialized metallurgy exceeds 20%", "Glassdoor / LinkedIn recruitment outreach spikes"],
                    PreemptiveHedgingDirective: "Grant long-term golden handcuff retention vesting and enforce strict 18-month non-compete covenants backed by IP litigation fund."
                )
            ],
            _ =>
            [
                new(
                    VectorId: "market-rejection",
                    Name: "Unit Economics & Customer Churn Squeeze",
                    Severity: "Critical",
                    FailureMechanism: "Customer acquisition costs double while enterprise willingness-to-pay drops amid macroeconomic contraction, creating fatal cash burn.",
                    EarlyWarningIndicators: ["LTV/CAC ratio falls below 2.0x", "Sales cycle length stretches past 120 days", "Net revenue retention drops under 90%"],
                    PreemptiveHedgingDirective: "Impose strict capital gating tied to quarterly cohort unit economic milestones before committing Phase 2 expansion budget."
                ),
                new(
                    VectorId: "cyber-breach",
                    Name: "Catastrophic Customer Data Exfiltration",
                    Severity: "High",
                    FailureMechanism: "Third-party supply chain software compromise exposes sensitive client data, resulting in brand paralysis and legal liability.",
                    EarlyWarningIndicators: ["Unpatched CVE vulnerability backlog grows", "Security posture scoring drops below SOC2 compliance"],
                    PreemptiveHedgingDirective: "Mandate zero-trust network segmentation and continuous red-teaming penetration testing with automated credential revocation."
                ),
                new(
                    VectorId: "antitrust-block",
                    Name: "Regulatory & Antitrust Intervention",
                    Severity: "High",
                    FailureMechanism: "Competition authority imposes burdensome behavioral remedies that eliminate core synergy assumptions.",
                    EarlyWarningIndicators: ["Regulator requests Phase 2 deep-dive information inquiry", "Competitor trade lobby files formal objections"],
                    PreemptiveHedgingDirective: "Prepare pre-negotiated asset divestiture package to satisfy antitrust regulators within 60 days of filing."
                )
            ]
        };

        var liveSignals = new List<PreMortemLiveSignal>();
        var userId = User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (database is not null && !string.IsNullOrEmpty(userId))
        {
            try
            {
                string[] searchTerms = initiativeId switch
                {
                    "ai-cloud-migration" => ["ai", "cloud", "model", "eu ai", "hyperscaler", "gpu", "regulation"],
                    "critical-materials-foundry" => ["gallium", "rare earth", "semiconductor", "tariff", "embargo", "china", "supply"],
                    "pan-european-fintech-mna" => ["fintech", "sepa", "eu", "antitrust", "payments", "regulator"],
                    _ => ["health", "biometric", "breach", "fda", "churn", "subscription"]
                };

                var stored = await database.StoredNewsArticles
                    .AsNoTracking()
                    .Where(a => a.UserId == userId)
                    .OrderByDescending(a => a.LastSeenAtUtc)
                    .Take(100)
                    .Select(a => new { a.Title, a.Source, a.Url, a.Summary })
                    .ToArrayAsync(cancellationToken);

                foreach (var art in stored)
                {
                    var haystack = string.Concat(art.Title, " ", art.Summary);
                    if (searchTerms.Any(term => Regex.IsMatch(haystack, $@"\b{Regex.Escape(term)}\b", RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(150))))
                    {
                        liveSignals.Add(new PreMortemLiveSignal(
                            art.Title,
                            art.Source,
                            art.Url,
                            vectors[0].Name));
                        if (liveSignals.Count >= 3) break;
                    }
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                logger?.LogDebug(ex, "Pre-Mortem live DB signal scan skipped.");
            }
        }

        var fatalityPercent = initiativeId switch
        {
            "ai-cloud-migration" => 64,
            "critical-materials-foundry" => 72,
            "pan-european-fintech-mna" => 58,
            _ => 52
        };

        if (liveSignals.Count > 0)
        {
            fatalityPercent = Math.Min(92, fatalityPercent + Math.Min(5, liveSignals.Count * 2));
        }

        var summary = $"PRE-MORTEM AUTOPSY SCENARIO: By month {horizon}, '{title}' has experienced catastrophic operational failure resulting in total impairment of allocated capital. The failure did not originate from unpredictable macro black swans, but rather from unmitigated internal fragility and delayed response to known early warning indicators.";

        var recommendation = fatalityPercent > 65
            ? "BOARD DIRECTIVE: HALT CAPITAL DEPLOYMENT. The initiative exhibits critical single-point failure vectors that cannot be hedged under current governance. Require executive sponsor to present redesigned architecture within 45 days."
            : "BOARD DIRECTIVE: CONDITIONAL APPROVAL WITH GATED TRANCHES. Release 30% seed allocation only. Tie subsequent capital releases strictly to verifiable mitigation of Early Warning Indicators.";

        var dossier = new PreMortemDossier(
            InitiativeId: initiativeId,
            Title: title,
            HorizonMonths: horizon,
            ExecutiveSummaryAutopsy: summary,
            OverallFatalityProbabilityPercent: fatalityPercent,
            CollapseVectors: vectors,
            BoardRecommendation: recommendation,
            SimulatedAt: DateTimeOffset.UtcNow,
            LiveRiskSignals: liveSignals.ToArray());

        return Ok(dossier);
    }
}
