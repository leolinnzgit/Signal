using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/scenario-simulator")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ScenarioSimulatorController(
    IMemoryCache cache,
    ILogger<ScenarioSimulatorController>? logger = null) : ControllerBase
{
    public sealed record ScenarioAssetItem(
        string Symbol,
        string Name,
        decimal Price,
        decimal PercentChange);

    public sealed record ScenarioSimulationRequest(
        string Scenario,
        ScenarioAssetItem[]? BaselineAssets = null,
        string? IndustryFocus = null);

    public sealed record ScenarioOrderImpact(
        int OrderLevel,
        string Domain,
        string ImpactSummary,
        string TransmissionChannel,
        string Severity);

    public sealed record ScenarioMitigationItem(
        string Priority,
        string Action,
        string OwnerRole);

    public sealed record ScenarioSimulationResponse(
        bool Available,
        string Scenario,
        string ExecutiveSummary,
        int ResilienceScore,
        string RiskLevel,
        ScenarioOrderImpact[] Impacts,
        ScenarioMitigationItem[] MitigationPlan,
        DateTimeOffset SimulatedAt);

    [HttpPost("simulate")]
    public IActionResult Simulate([FromBody] ScenarioSimulationRequest? request)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.Scenario))
        {
            return BadRequest(new { error = "Scenario prompt is required." });
        }

        var scenario = request.Scenario.Trim();
        var cacheKey = $"scenario_sim:{scenario.ToLowerInvariant()}:{request.IndustryFocus ?? "general"}";
        if (cache.TryGetValue(cacheKey, out ScenarioSimulationResponse? cached) && cached != null)
        {
            return Ok(cached);
        }

        var impacts = ProjectScenarioImpacts(scenario, request.BaselineAssets);
        var resilience = CalculateResilienceScore(scenario, impacts);
        var riskLevel = resilience < 50 ? "High Vulnerability" : resilience < 75 ? "Moderate Exposure" : "Resilient Posture";
        var mitigation = BuildMitigationPlan(scenario, impacts);

        var summary = $"Simulation of '{scenario}': Anticipates sharp 1st-order liquidity adjustments transmitting into 2nd-order operational friction, requiring multi-quarter capital rebalancing.";

        var response = new ScenarioSimulationResponse(
            Available: true,
            Scenario: scenario,
            ExecutiveSummary: summary,
            ResilienceScore: resilience,
            RiskLevel: riskLevel,
            Impacts: impacts,
            MitigationPlan: mitigation,
            SimulatedAt: DateTimeOffset.UtcNow);

        cache.Set(cacheKey, response, TimeSpan.FromMinutes(20));
        logger?.LogDebug("Scenario simulator evaluated '{Scenario}'.", scenario);
        return Ok(response);
    }

    private static ScenarioOrderImpact[] ProjectScenarioImpacts(string scenario, ScenarioAssetItem[]? assets)
    {
        var impacts = new List<ScenarioOrderImpact>();
        var sLower = scenario.ToLowerInvariant();

        // 1st Order: Immediate asset / liquidity reaction
        if (sLower.Contains("ocr") || sLower.Contains("rate") || sLower.Contains("interest") || sLower.Contains("inflation"))
        {
            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 1,
                Domain: "Wholesale Yields & Foreign Exchange",
                ImpactSummary: "Short-term wholesale curve steepening; NZD exchange rate reprices within 24 hours.",
                TransmissionChannel: "Interbank liquidity & currency swap spreads",
                Severity: "Elevated"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 2,
                Domain: "Corporate Borrowing & Commercial Debt",
                ImpactSummary: "Refinancing spreads widen for mid-market corporate facilities; capex decisions deferred.",
                TransmissionChannel: "Bank lending covenants & debt rollover hurdles",
                Severity: "High"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 3,
                Domain: "Strategic Capital Allocation & M&A",
                ImpactSummary: "Valuation multiples compress; private equity and cross-border transactions pivot to distressed assets.",
                TransmissionChannel: "Terminal discount rate adjustments & hurdle rate resets",
                Severity: "Moderate"));
        }
        else if (sLower.Contains("port") || sLower.Contains("strike") || sLower.Contains("freight") || sLower.Contains("supply"))
        {
            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 1,
                Domain: "Port Berth Capacity & Demurrage Fees",
                ImpactSummary: "Container dwell times quadruple; ocean freight congestion surcharges activated immediately.",
                TransmissionChannel: "Terminal logistics bottleneck",
                Severity: "High"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 2,
                Domain: "Inventory Buffer Depletion & Spot Surcharges",
                ImpactSummary: "Just-in-time manufacturing lines face component stockouts within 14 days; air freight spot rates surge.",
                TransmissionChannel: "Tier-1 component delivery failure",
                Severity: "High"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 3,
                Domain: "Dual-Sourcing Mandates & Nearshoring",
                ImpactSummary: "Board governance mandates minimum 60-day strategic inventory reserves and regional logistics diversification.",
                TransmissionChannel: "Supply chain risk committee regulatory audits",
                Severity: "Elevated"));
        }
        else if (sLower.Contains("tariff") || sLower.Contains("trade") || sLower.Contains("export") || sLower.Contains("china") || sLower.Contains("us"))
        {
            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 1,
                Domain: "Export Margin Compression & Customs Clearance",
                ImpactSummary: "Bilateral trade levies immediately increase delivered customs cost for key export commodities.",
                TransmissionChannel: "Customs declaration fee increases",
                Severity: "High"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 2,
                Domain: "Channel Redirection & Warehousing Gluts",
                ImpactSummary: "Exporters redirect volume into secondary Southeast Asian hubs; spot storage costs spike.",
                TransmissionChannel: "Cold-chain logistics overflow",
                Severity: "Elevated"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 3,
                Domain: "Bilateral Trade Agreements & Supply Chain Decoupling",
                ImpactSummary: "Corporate restructuring of foreign distribution entities and long-term origin re-certification.",
                TransmissionChannel: "Rules-of-origin compliance audits",
                Severity: "Elevated"));
        }
        else
        {
            // Default generic shock model
            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 1,
                Domain: "Immediate Equity & Bond Sentiment Shock",
                ImpactSummary: "Primary sector benchmarks drop 1.5% to 2.5%; risk premiums widen across commercial paper.",
                TransmissionChannel: "Intraday algorithmic execution & margin calls",
                Severity: "Elevated"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 2,
                Domain: "Operational Working Capital Constraints",
                ImpactSummary: "Suppliers demand tightened payment terms; cash conversion cycles stretch by 18 days.",
                TransmissionChannel: "Working capital drawdown & trade credit insurance pullback",
                Severity: "High"));

            impacts.Add(new ScenarioOrderImpact(
                OrderLevel: 3,
                Domain: "Executive Restructuring & Forward Guidance Downgrade",
                ImpactSummary: "Executive committee resets annual EBITDA guidance and initiates selective hiring freeze.",
                TransmissionChannel: "Audited financial restatement & stakeholder re-rating",
                Severity: "Moderate"));
        }

        return [.. impacts];
    }

    private static int CalculateResilienceScore(string scenario, ScenarioOrderImpact[] impacts)
    {
        var highSeverityCount = impacts.Count(i => i.Severity.Equals("High", StringComparison.OrdinalIgnoreCase));
        var baseScore = 80;
        baseScore -= highSeverityCount * 12;
        return Math.Clamp(baseScore, 25, 95);
    }

    private static ScenarioMitigationItem[] BuildMitigationPlan(string scenario, ScenarioOrderImpact[] impacts)
    {
        return
        [
            new ScenarioMitigationItem(
                Priority: "Immediate (Day 1-7)",
                Action: "Draw down pre-arranged revolving credit facilities to secure 90 days of operational buffer.",
                OwnerRole: "Chief Financial Officer"),

            new ScenarioMitigationItem(
                Priority: "Operational (Day 8-30)",
                Action: "Execute secondary supply agreements and pre-book strategic freight allocations.",
                OwnerRole: "Chief Operating Officer"),

            new ScenarioMitigationItem(
                Priority: "Governance (Day 31-90)",
                Action: "Convene special Board Risk Committee meeting to evaluate revised hurdle rates and capex sequencing.",
                OwnerRole: "Board Chair / CEO")
        ];
    }
}
