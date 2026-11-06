using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/tariff-matrix")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class TariffMatrixController : ControllerBase
{
    public sealed record TradeProfile(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("hsCode")] string HsCode,
        [property: JsonPropertyName("sector")] string Sector,
        [property: JsonPropertyName("baselineTariffRate")] double BaselineTariffRate,
        [property: JsonPropertyName("tier1ConcentrationPercent")] int Tier1ConcentrationPercent,
        [property: JsonPropertyName("typicalGrossMarginPercent")] double TypicalGrossMarginPercent,
        [property: JsonPropertyName("primaryOrigins")] string[] PrimaryOrigins,
        [property: JsonPropertyName("dualUseExportControlEccn")] string DualUseExportControlEccn,
        [property: JsonPropertyName("executiveBrief")] string ExecutiveBrief);

    public sealed record CorridorAdjustment(
        [property: JsonPropertyName("corridor")] string Corridor, // "us-china" | "eu-china" | "apac-us" | "us-eu"
        [property: JsonPropertyName("tariffRatePercent")] double TariffRatePercent);

    public sealed record TariffSimulationRequest(
        [property: JsonPropertyName("profileId")] string? ProfileId,
        [property: JsonPropertyName("corridorAdjustments")] CorridorAdjustment[]? CorridorAdjustments,
        [property: JsonPropertyName("customTier1Concentration")] int? CustomTier1Concentration,
        [property: JsonPropertyName("customGrossMargin")] double? CustomGrossMargin);

    public sealed record ArbitrageOption(
        [property: JsonPropertyName("destination")] string Destination,
        [property: JsonPropertyName("ftaAgreement")] string FtaAgreement,
        [property: JsonPropertyName("tariffRecoveryPercent")] double TariffRecoveryPercent,
        [property: JsonPropertyName("leadTimeDeltaWeeks")] int LeadTimeDeltaWeeks,
        [property: JsonPropertyName("strategicRationale")] string StrategicRationale);

    public sealed record TariffSimulationResponse(
        [property: JsonPropertyName("profileId")] string ProfileId,
        [property: JsonPropertyName("profileName")] string ProfileName,
        [property: JsonPropertyName("blendedEffectiveTariffPercent")] double BlendedEffectiveTariffPercent,
        [property: JsonPropertyName("cogsImpactPercent")] double CogsImpactPercent,
        [property: JsonPropertyName("ebitdaMarginCompressionBps")] int EbitdaMarginCompressionBps,
        [property: JsonPropertyName("annualizedPnlVarianceUsd")] string AnnualizedPnlVarianceUsd,
        [property: JsonPropertyName("arbitrageOptions")] ArbitrageOption[] ArbitrageOptions,
        [property: JsonPropertyName("exportControlAlerts")] string[] ExportControlAlerts,
        [property: JsonPropertyName("executiveDirectives")] string[] ExecutiveDirectives,
        [property: JsonPropertyName("simulatedAt")] DateTimeOffset SimulatedAt);

    private static readonly TradeProfile[] DefaultProfiles =
    [
        new(
            Id: "semiconductors",
            Name: "Advanced Microelectronics & Sub-7nm Wafers",
            HsCode: "HS 8542.31",
            Sector: "Technology & Hardware",
            BaselineTariffRate: 15.0,
            Tier1ConcentrationPercent: 72,
            TypicalGrossMarginPercent: 54.0,
            PrimaryOrigins: ["Taiwan", "South Korea", "Japan", "Mainland China"],
            DualUseExportControlEccn: "3A090.a / 4A090",
            ExecutiveBrief: "Exposure to Section 301 tariffs, bilateral advanced computing restrictions, and TSMC/Samsung foundry capacity allocations."
        ),
        new(
            Id: "ev-batteries",
            Name: "EV Powertrains & Lithium Iron Phosphate (LFP) Cells",
            HsCode: "HS 8507.60",
            Sector: "Automotive & Clean Energy",
            BaselineTariffRate: 25.0,
            Tier1ConcentrationPercent: 68,
            TypicalGrossMarginPercent: 22.0,
            PrimaryOrigins: ["Mainland China", "South Korea", "Hungary", "Japan"],
            DualUseExportControlEccn: "1B018 / 1C018",
            ExecutiveBrief: "Subject to EU anti-subsidy duties (up to 35.3%) and US 100% Section 301 EV tariff regime with strict Inflation Reduction Act FEOC rules."
        ),
        new(
            Id: "rare-earths",
            Name: "Refined Rare Earth Oxides & Permanent Neodymium Magnets",
            HsCode: "HS 2805.30",
            Sector: "Critical Minerals & Defense",
            BaselineTariffRate: 12.0,
            Tier1ConcentrationPercent: 88,
            TypicalGrossMarginPercent: 38.0,
            PrimaryOrigins: ["Mainland China", "Australia", "Myanmar", "Vietnam"],
            DualUseExportControlEccn: "1C002.a / 1C010",
            ExecutiveBrief: "Near-monopoly processing bottlenecks with export licensing quotas and potential weaponized export curbs by Ministry of Commerce."
        ),
        new(
            Id: "industrial-machinery",
            Name: "Precision CNC Machine Tools & Industrial Robotics",
            HsCode: "HS 8479.50",
            Sector: "Industrial Manufacturing",
            BaselineTariffRate: 8.5,
            Tier1ConcentrationPercent: 52,
            TypicalGrossMarginPercent: 34.0,
            PrimaryOrigins: ["Germany", "Japan", "South Korea", "Mainland China"],
            DualUseExportControlEccn: "2B001.a / 2B201",
            ExecutiveBrief: "Exposed to bilateral trade dispute retaliatory tariffs and multi-axis machine tool export verification protocols."
        ),
        new(
            Id: "biopharma",
            Name: "Active Pharmaceutical Ingredients (API) & Biologics",
            HsCode: "HS 3004.90",
            Sector: "Life Sciences & Healthcare",
            BaselineTariffRate: 6.0,
            Tier1ConcentrationPercent: 64,
            TypicalGrossMarginPercent: 68.0,
            PrimaryOrigins: ["India", "Mainland China", "Ireland", "Switzerland"],
            DualUseExportControlEccn: "1C351 / 1C353",
            ExecutiveBrief: "Biosecure Act compliance requirements and FDA foreign inspection backlogs creating regional dual-sourcing urgency."
        )
    ];

    [HttpGet("profiles")]
    public IActionResult GetProfiles()
    {
        return Ok(DefaultProfiles);
    }

    [HttpPost("simulate")]
    [IgnoreAntiforgeryToken]
    public IActionResult Simulate([FromBody] TariffSimulationRequest? request)
    {
        var profileId = request?.ProfileId?.Trim().ToLowerInvariant() ?? "semiconductors";
        var profile = DefaultProfiles.FirstOrDefault(p => p.Id == profileId) ?? DefaultProfiles[0];

        var adjustments = request?.CorridorAdjustments ?? [];
        var tier1Concentration = request?.CustomTier1Concentration ?? profile.Tier1ConcentrationPercent;
        var grossMargin = request?.CustomGrossMargin ?? profile.TypicalGrossMarginPercent;

        // Calculate blended effective tariff
        double weightedTariff = profile.BaselineTariffRate;
        if (adjustments.Length > 0)
        {
            var usChina = adjustments.FirstOrDefault(a => a.Corridor.Equals("us-china", StringComparison.OrdinalIgnoreCase))?.TariffRatePercent ?? profile.BaselineTariffRate;
            var euChina = adjustments.FirstOrDefault(a => a.Corridor.Equals("eu-china", StringComparison.OrdinalIgnoreCase))?.TariffRatePercent ?? profile.BaselineTariffRate;
            var apacUs = adjustments.FirstOrDefault(a => a.Corridor.Equals("apac-us", StringComparison.OrdinalIgnoreCase))?.TariffRatePercent ?? (profile.BaselineTariffRate * 0.4);
            var usEu = adjustments.FirstOrDefault(a => a.Corridor.Equals("us-eu", StringComparison.OrdinalIgnoreCase))?.TariffRatePercent ?? 2.5;

            // Blend based on global corridor weights
            weightedTariff = (usChina * 0.45) + (euChina * 0.30) + (apacUs * 0.15) + (usEu * 0.10);
        }

        // COGS impact is proportional to Tier 1 supplier concentration and effective tariff
        var cogsImpactPercent = Math.Round((weightedTariff * (tier1Concentration / 100.0) * 0.65), 2);

        // EBITDA margin compression in basis points
        var marginCompressionBps = (int)Math.Round(cogsImpactPercent * (100.0 - grossMargin) * 0.08 * 100);

        // Projected P&L variance based on a benchmark $100M revenue business unit
        var annualizedVariance = $"-$" + Math.Round((cogsImpactPercent * 1.85), 1) + "M";

        // Generate tailored arbitrage re-routing pathways
        var arbitrage = GenerateArbitrageOptions(profile.Id);

        // Export control warnings
        string[] exportAlerts =
        [
            $"Dual-Use Classification: {profile.DualUseExportControlEccn} requires validated end-user license for entities on BIS Unverified List.",
            "De minimis thresholds tightened: Foreign-produced direct products incorporating >0% US-origin intellectual property subject to EAR.",
            "Anti-circumvention audits initiated by US Customs across transshipment hubs in Southeast Asia."
        ];

        // Executive directives
        string[] directives =
        [
            $"Initiate qualification of bonded assembly facilities in USMCA / CPTPP tariff-exempt zones.",
            $"Execute price pass-through clauses across existing customer contracts before fiscal year-end.",
            $"File for tariff exclusions under Section 301 Product Exclusion process citing lack of domestic capacity.",
            $"Restructure bill of materials (BOM) to unbundle tariff-heavy subassemblies from firmware licensing."
        ];

        var response = new TariffSimulationResponse(
            ProfileId: profile.Id,
            ProfileName: profile.Name,
            BlendedEffectiveTariffPercent: Math.Round(weightedTariff, 2),
            CogsImpactPercent: cogsImpactPercent,
            EbitdaMarginCompressionBps: marginCompressionBps,
            AnnualizedPnlVarianceUsd: annualizedVariance,
            ArbitrageOptions: arbitrage,
            ExportControlAlerts: exportAlerts,
            ExecutiveDirectives: directives,
            SimulatedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }

    private static ArbitrageOption[] GenerateArbitrageOptions(string profileId)
    {
        return profileId switch
        {
            "ev-batteries" => [
                new("Monterrey, Mexico", "USMCA Rule of Origin (Chapter 4)", 78.0, 3, "Qualifies for zero tariff and Section 30D consumer clean vehicle tax credit if cathode active materials processed regionally."),
                new("Debrecen, Hungary", "EU Internal Market & Customs Union", 65.0, 4, "Circumvents external anti-subsidy duties for EU automotive OEM integration."),
                new("Morocco (Tangier Med)", "EU-Morocco Association Agreement / US FTA", 54.0, 5, "Favorable bilateral investment treaty with access to domestic phosphate reserves for LFP.")
            ],
            "rare-earths" => [
                new("Western Australia (Kalgoorlie)", "US-Australia Critical Minerals Framework", 82.0, 8, "Eligible for US Defense Production Act Title III capital grants and zero tariff entry."),
                new("Vietnam (Hai Phong)", "CPTPP Tariff Schedule", 48.0, 4, "Secondary refining and separation hub with lower labor costs and preferential tariff rates."),
                new("Estonia (Sillamäe)", "EU Critical Raw Materials Act Corridor", 60.0, 6, "European processing facility with direct access to Scandinavian heavy mineral sands.")
            ],
            "biopharma" => [
                new("Cork, Ireland", "EU Common Customs Tariff / US Pharma Zero-for-Zero", 85.0, 2, "Patent box tax incentives (6.25%) combined with duty-free transatlantic pharmaceutical trade."),
                new("Hyderabad, India", "Generalized System of Preferences (GSP)", 52.0, 3, "High-volume certified chemical synthesis with 40% lower operational expenditure."),
                new("Singapore (Tuas Biomedical)", "US-Singapore FTA (USSFTA)", 75.0, 2, "Strict intellectual property protection and zero tariff entry under Rule of Origin certificate.")
            ],
            _ => [ // Semiconductors & default
                new("Penang, Malaysia", "CPTPP Free Trade Zone", 72.0, 3, "Established advanced packaging, testing, and wafer probing ecosystem with 0% tariff pass-through."),
                new("Querétaro, Mexico", "USMCA Chapter 6 (Electronics Origin)", 88.0, 2, "Duty-free overland transit to North American OEM hubs with 24-hour border clearance."),
                new("Dresden, Germany", "EU Chips Act Ecosystem", 64.0, 5, "Subsidized European silicon fab capacity with zero internal EU customs friction.")
            ]
        };
    }
}
