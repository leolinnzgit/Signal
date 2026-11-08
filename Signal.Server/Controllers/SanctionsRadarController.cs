using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/sanctions-radar")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SanctionsRadarController(
    IMemoryCache cache,
    ILogger<SanctionsRadarController>? logger = null) : ControllerBase
{
    public sealed record ArticleInput(
        string Title,
        string Source,
        string Url,
        DateTimeOffset? PublishedAt = null,
        string? Summary = null);

    public sealed record JurisdictionRisk(
        string Jurisdiction,
        string RiskLevel,
        string FocusArea,
        string EnforcementTrend,
        int MeasuresCount,
        string Description);

    public sealed record SanctionMeasure(
        string Id,
        string Title,
        string Regime,
        string Category,
        string Severity,
        string[] ImpactedSectors,
        string ExposureAssessment,
        string[] ComplianceDirectives,
        string Source,
        string EffectiveDate,
        string? ArticleUrl = null);

    public sealed record ComplianceDirective(
        string Urgency,
        string Action,
        string TargetDomain);

    public sealed record SanctionsRadarRequest(
        ArticleInput[]? Articles = null,
        string[]? WatchedJurisdictions = null);

    public sealed record SanctionsRadarResponse(
        bool Available,
        string GlobalEnforcementLevel,
        int CompositeRiskIndex,
        string PolicySummary,
        int ActiveSanctionsActions,
        int ExportBansInEffect,
        int TariffDisputes,
        int DesignatedEntitiesCount,
        JurisdictionRisk[] Jurisdictions,
        SanctionMeasure[] Measures,
        ComplianceDirective[] Directives,
        string SpokenAudioScript,
        DateTimeOffset GeneratedAt);

    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Analyze(new SanctionsRadarRequest());
    }

    [HttpPost("analyze")]
    public IActionResult Analyze([FromBody] SanctionsRadarRequest? request)
    {
        var cacheKey = "sanctions_radar:global_status";
        var hasCustomArticles = request?.Articles != null && request.Articles.Length > 0;

        if (!hasCustomArticles && cache.TryGetValue(cacheKey, out SanctionsRadarResponse? cached) && cached != null)
        {
            return Ok(cached);
        }

        var articles = (request?.Articles ?? [])
            .Where(a => !string.IsNullOrWhiteSpace(a.Title))
            .ToArray();

        var (level, riskIndex, summary, activeSanctions, exportBans, tariffDisputes, entityCount, jurisdictions, measures, directives) =
            SynthesizeSanctionsPosture(articles, request?.WatchedJurisdictions);

        var spokenScript = BuildSpokenScript(level, riskIndex, summary, measures, directives);

        var response = new SanctionsRadarResponse(
            Available: true,
            GlobalEnforcementLevel: level,
            CompositeRiskIndex: riskIndex,
            PolicySummary: summary,
            ActiveSanctionsActions: activeSanctions,
            ExportBansInEffect: exportBans,
            TariffDisputes: tariffDisputes,
            DesignatedEntitiesCount: entityCount,
            Jurisdictions: jurisdictions,
            Measures: measures,
            Directives: directives,
            SpokenAudioScript: spokenScript,
            GeneratedAt: DateTimeOffset.UtcNow);

        if (!hasCustomArticles)
        {
            cache.Set(cacheKey, response, TimeSpan.FromMinutes(10));
            logger?.LogDebug("Sanctions radar evaluated {Count} measures.", measures.Length);
        }

        return Ok(response);
    }

    private static (
        string Level,
        int RiskIndex,
        string Summary,
        int ActiveSanctions,
        int ExportBans,
        int TariffDisputes,
        int EntityCount,
        JurisdictionRisk[] Jurisdictions,
        SanctionMeasure[] Measures,
        ComplianceDirective[] Directives)
        SynthesizeSanctionsPosture(ArticleInput[] articles, string[]? watchedJurisdictions)
    {
        var matchedMeasures = new List<SanctionMeasure>();

        foreach (var art in articles)
        {
            var text = $"{art.Title} {art.Summary}";
            var isExportControl = text.Contains("export control", StringComparison.OrdinalIgnoreCase) ||
                                  text.Contains("Entity List", StringComparison.OrdinalIgnoreCase) ||
                                  text.Contains("lithography", StringComparison.OrdinalIgnoreCase) ||
                                  text.Contains("semiconductor ban", StringComparison.OrdinalIgnoreCase) ||
                                  text.Contains("dual-use", StringComparison.OrdinalIgnoreCase) ||
                                  text.Contains("ASML", StringComparison.OrdinalIgnoreCase);

            var isFinancialSanction = text.Contains("sanction", StringComparison.OrdinalIgnoreCase) ||
                                      text.Contains("OFAC", StringComparison.OrdinalIgnoreCase) ||
                                      text.Contains("OFSI", StringComparison.OrdinalIgnoreCase) ||
                                      text.Contains("SDN", StringComparison.OrdinalIgnoreCase) ||
                                      text.Contains("secondary sanction", StringComparison.OrdinalIgnoreCase) ||
                                      text.Contains("banking ban", StringComparison.OrdinalIgnoreCase);

            var isTariff = text.Contains("tariff", StringComparison.OrdinalIgnoreCase) ||
                           text.Contains("trade duty", StringComparison.OrdinalIgnoreCase) ||
                           text.Contains("Section 301", StringComparison.OrdinalIgnoreCase) ||
                           text.Contains("dumping", StringComparison.OrdinalIgnoreCase) ||
                           text.Contains("trade war", StringComparison.OrdinalIgnoreCase);

            var isMineralOrEnergy = text.Contains("gallium", StringComparison.OrdinalIgnoreCase) ||
                                    text.Contains("germanium", StringComparison.OrdinalIgnoreCase) ||
                                    text.Contains("antimony", StringComparison.OrdinalIgnoreCase) ||
                                    text.Contains("rare earth", StringComparison.OrdinalIgnoreCase) ||
                                    text.Contains("oil cap", StringComparison.OrdinalIgnoreCase) ||
                                    text.Contains("shadow fleet", StringComparison.OrdinalIgnoreCase) ||
                                    text.Contains("dark fleet", StringComparison.OrdinalIgnoreCase);

            if (isExportControl || isFinancialSanction || isTariff || isMineralOrEnergy)
            {
                var category = isExportControl ? "Export Controls & Dual-Use"
                             : isTariff ? "Tariffs & Trade Remedies"
                             : isMineralOrEnergy ? "Critical Minerals & Commodities"
                             : "Financial & Banking Sanctions";

                var severity = isExportControl || isFinancialSanction ? "Critical" : "High";
                var regime = isExportControl ? "US BIS Entity List / Dual-Use"
                           : isTariff ? "International Trade Remedy / Tariff Schedule"
                           : isMineralOrEnergy ? "Resource Export Quota & Price Cap"
                           : "OFAC / Multilateral Sanctions";

                matchedMeasures.Add(new SanctionMeasure(
                    Id: $"meas-usr-{Guid.NewGuid():N}"[..12],
                    Title: art.Title,
                    Regime: regime,
                    Category: category,
                    Severity: severity,
                    ImpactedSectors: ["Cross-Border Technology", "Global Trade Logistics", "International Banking & FX"],
                    ExposureAssessment: !string.IsNullOrWhiteSpace(art.Summary) ? art.Summary : "Active regulatory enforcement or trade restriction reported in live news tracking.",
                    ComplianceDirectives: [
                        "Screen supply chain counterparties against updated sanctioned entity watchlists.",
                        "Audit bill-of-materials for restricted dual-use components and country-of-origin rules.",
                        "Verify cross-border payment routing to ensure no sanctioned intermediaries are touched."
                    ],
                    Source: art.Source,
                    EffectiveDate: art.PublishedAt?.ToString("g") ?? "Immediate",
                    ArticleUrl: art.Url
                ));
            }
        }

        // Authoritative baseline measures representing active global regulatory frameworks
        var baselineMeasures = new List<SanctionMeasure>
        {
            new(
                Id: "meas-bis-semiconductor-rules",
                Title: "Sub-14nm Logic & High-Bandwidth Memory (HBM) Advanced Export Restrictions",
                Regime: "US BIS Export Administration Regulations (EAR)",
                Category: "Export Controls & Dual-Use",
                Severity: "Critical",
                ImpactedSectors: ["Semiconductors & AI Accelerators", "EUV/DUV Lithography", "Cloud Hyperscalers"],
                ExposureAssessment: "Mandatory presumption of denial on export licenses for advanced AI accelerators and EDA software to foreign restricted jurisdictions.",
                ComplianceDirectives: [
                    "Require end-use certification for all shipments of GPUs exceeding 4800 TOPS performance density.",
                    "Audit third-party distributor channels across Southeast Asia and the Middle East for diversion risks.",
                    "Verify non-involvement of US persons in restricted fabrication facilities."
                ],
                Source: "Bureau of Industry & Security (BIS)",
                EffectiveDate: "Active Enforcement"
            ),
            new(
                Id: "meas-ofac-shadow-fleet-sdn",
                Title: "Secondary Financial Sanctions on Maritime Shadow Fleet Tankers & Crude Insurers",
                Regime: "US Treasury OFAC & G7 Price Cap Coalition",
                Category: "Maritime & Shadow Fleet",
                Severity: "Critical",
                ImpactedSectors: ["Commercial Maritime Shipping", "Marine Protection & Indemnity (P&I)", "Energy Trading"],
                ExposureAssessment: "Designation of over 120 unflagged or flag-of-convenience crude carriers evading maritime price caps, freezing US assets and barring dollar clearing.",
                ComplianceDirectives: [
                    "Perform automated AIS voyage reconstruction to identify AIS spoofing and ship-to-ship transfers.",
                    "Mandate verified attestation of maritime insurance from International Group P&I clubs.",
                    "Screen beneficial vessel ownership against OFAC Non-SDN and Specially Designated Nationals lists."
                ],
                Source: "US Department of the Treasury (OFAC)",
                EffectiveDate: "Immediate Enforcement"
            ),
            new(
                Id: "meas-critical-minerals-quota",
                Title: "Export Licensing Controls & Quota Allocations on Gallium, Germanium & Antimony",
                Regime: "China Ministry of Commerce (MOFCOM)",
                Category: "Critical Minerals & Commodities",
                Severity: "High",
                ImpactedSectors: ["Defense Radar & Optics", "Compound Semiconductor Wafers", "Fiber Optic Infrared Sensors"],
                ExposureAssessment: "Exporters must secure individual state council licenses with comprehensive customer disclosures; delivery lead times extended by 6 to 12 weeks.",
                ComplianceDirectives: [
                    "Establish strategic buffer inventory for gallium arsenide (GaAs) and germanium substrates.",
                    "Qualify secondary refining sources in North America, Australia, or Japan.",
                    "Conduct end-user compliance reviews before submitting dual-use export declaration filings."
                ],
                Source: "MOFCOM Trade Policy Bulletin",
                EffectiveDate: "Active Quotas"
            ),
            new(
                Id: "meas-section-301-tariffs",
                Title: "Escalated Section 301 Tariffs on Electric Vehicles, Battery Cells & Strategic Steel",
                Regime: "US Trade Representative (USTR) & EU Trade Commission",
                Category: "Tariffs & Trade Remedies",
                Severity: "High",
                ImpactedSectors: ["Automotive & EV Platforms", "Lithium-Ion Battery Supply Chains", "Solar PV Modules"],
                ExposureAssessment: "Tariff rates elevated up to 100% on imported complete electric vehicles and 25% to 50% on lithium-ion batteries and permanent magnets.",
                ComplianceDirectives: [
                    "Audit rules-of-origin documentation to ensure tariff classification compliance.",
                    "Review supply contracts for tariff pass-through and force majeure adjustment clauses.",
                    "Evaluate bonded warehouse and foreign trade zone (FTZ) mitigation strategies."
                ],
                Source: "Office of the US Trade Representative",
                EffectiveDate: "In Effect"
            )
        };

        var allMeasures = matchedMeasures.Concat(baselineMeasures).Take(8).ToArray();

        var exportCount = allMeasures.Count(m => m.Category == "Export Controls & Dual-Use");
        var sanctionCount = allMeasures.Count(m => m.Category == "Financial & Banking Sanctions" || m.Category == "Maritime & Shadow Fleet");
        var tariffCount = allMeasures.Count(m => m.Category == "Tariffs & Trade Remedies");
        var mineralCount = allMeasures.Count(m => m.Category == "Critical Minerals & Commodities");

        var riskIndex = Math.Min(96, 68 + (exportCount * 6) + (sanctionCount * 5) + (tariffCount * 4) + (mineralCount * 4));

        string level;
        string summary;

        if (riskIndex >= 85)
        {
            level = "Severe Sanctions Pressure — Multi-Jurisdiction Scrutiny";
            summary = "Broad coordination across OFAC, BIS, and EU sanctions regimes with targeted export bans on dual-use compute and shadow fleet maritime interdiction.";
        }
        else if (riskIndex >= 72)
        {
            level = "Heightened Enforcement — Strategic Trade Controls";
            summary = "Tightened licensing thresholds on semiconductors and critical mineral quotas alongside escalating tariff disputes on clean tech.";
        }
        else
        {
            level = "Guarded Monitoring — Baseline Trade Compliance";
            summary = "Routine sanctions list updates and trade policy reviews within expected international regulatory frameworks.";
        }

        var jurisdictions = new JurisdictionRisk[]
        {
            new(
                Jurisdiction: "United States (OFAC & BIS)",
                RiskLevel: exportCount > 0 ? "Critical" : "High",
                FocusArea: "Advanced AI Compute, Semiconductor EDA & Financial Secondary Sanctions",
                EnforcementTrend: "Aggressive",
                MeasuresCount: exportCount + sanctionCount,
                Description: "Active enforcement of Foreign Direct Product Rules and stringent scrutiny on third-country intermediary transshipments."
            ),
            new(
                Jurisdiction: "European Union (EU Sanctions)",
                RiskLevel: "High",
                FocusArea: "Circumvention Tracking, Dual-Use Goods & Shadow Tanker Interdiction",
                EnforcementTrend: "Escalating",
                MeasuresCount: sanctionCount,
                Description: "Strict enforcement of 14th and 15th sanctions packages focusing on transit bans and asset freeze mandates."
            ),
            new(
                Jurisdiction: "China (MOFCOM)",
                RiskLevel: mineralCount > 0 ? "High" : "Elevated",
                FocusArea: "Critical Minerals (Gallium/Germanium/Antimony) & Unreliable Entity List",
                EnforcementTrend: "Escalating",
                MeasuresCount: mineralCount + tariffCount,
                Description: "Export licensing quotas on critical defense tech minerals and targeted counter-sanction listings."
            ),
            new(
                Jurisdiction: "United Kingdom (OFSI)",
                RiskLevel: "Elevated",
                FocusArea: "Maritime Insurance Prohibitions & Professional Legal Services Bans",
                EnforcementTrend: "Stable",
                MeasuresCount: sanctionCount,
                Description: "Strict liability enforcement on financial facilitators and compliance audits for London maritime syndicates."
            ),
            new(
                Jurisdiction: "Multilateral / G7 Coalition",
                RiskLevel: "High",
                FocusArea: "Maritime Price Cap Verification & Cross-Border Sovereign Wealth Screening",
                EnforcementTrend: "Active",
                MeasuresCount: sanctionCount + exportCount,
                Description: "Coordinated diplomatic and customs enforcement aimed at closing evasion corridors in Central Asia and the Gulf."
            )
        };

        var directives = new ComplianceDirective[]
        {
            new(
                Urgency: "Immediate (P0)",
                Action: "Screen all active customer, supplier, and logistics counterparty records against updated OFAC SDN and BIS Entity Lists.",
                TargetDomain: "Watchlist Screening & KYC"
            ),
            new(
                Urgency: "Immediate (P0)",
                Action: "Audit marine transport documentation for dark fleet indicators, AIS gaps, and non-Group P&I club coverage.",
                TargetDomain: "Maritime Logistics & Freight"
            ),
            new(
                Urgency: "Next 24 Hours (P1)",
                Action: "Review advanced compute and dual-use hardware bill-of-materials against updated EAR foreign direct product thresholds.",
                TargetDomain: "Export Control & Technology"
            ),
            new(
                Urgency: "Next 48 Hours (P2)",
                Action: "Quantify tariff exposure under updated Section 301 and anti-dumping schedules across component supply agreements.",
                TargetDomain: "Customs & Trade Valuation"
            )
        };

        var totalDesignatedEntities = 120 + (exportCount * 8) + (sanctionCount * 14);

        return (level, riskIndex, summary, sanctionCount, exportCount, tariffCount, totalDesignatedEntities, jurisdictions, allMeasures, directives);
    }

    private static string BuildSpokenScript(
        string level,
        int riskIndex,
        string summary,
        SanctionMeasure[] measures,
        ComplianceDirective[] directives)
    {
        var topMeasure = measures.FirstOrDefault();
        var immediateDirective = directives.FirstOrDefault()?.Action ?? "Maintain rigorous counterparty screening.";

        var sb = new System.Text.StringBuilder();
        sb.Append($"Attention. Signal Global Sanctions, Tariffs, and Export Controls Executive Flash Briefing. ");
        sb.Append($"Global economic statecraft and trade compliance posture is currently at {level}, with a composite trade risk index of {riskIndex} out of 100. ");
        sb.Append($"{summary} ");

        if (topMeasure != null)
        {
            sb.Append($"Primary regulatory action: {topMeasure.Title}, governed by {topMeasure.Regime}, classified under {topMeasure.Category}. ");
            sb.Append($"{topMeasure.ExposureAssessment} ");
        }

        sb.Append($"Immediate compliance directive: {immediateDirective} ");
        sb.Append($"All enterprise trade compliance officers and logistics directors should review counterparty exposure immediately.");

        return sb.ToString();
    }
}
