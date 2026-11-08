using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/regulatory-radar")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class RegulatoryRadarController(
    IMemoryCache cache,
    ILogger<RegulatoryRadarController>? logger = null) : ControllerBase
{
    public sealed record ArticleItem(
        string Title,
        string Source,
        string Url,
        DateTimeOffset? PublishedAt = null,
        string? Summary = null);

    public sealed record RegulatoryRadarRequest(
        string? IndustrySector = null,
        string? Jurisdiction = null,
        ArticleItem[]? Articles = null);

    public sealed record RegulatoryBill(
        string Title,
        string RegulatoryBody,
        string Stage,
        string ComplianceDeadline,
        string PenaltyExposure,
        string Summary);

    public sealed record SectorRiskProfile(
        string Sector,
        string ExposureLevel,
        string KeyImpactArea,
        string RecommendedBoardQuery);

    public sealed record ComplianceActionItem(
        string Id,
        string Requirement,
        string ActionItem,
        string TargetQuarter,
        string Priority);

    public sealed record RegulatoryRadarResponse(
        bool Available,
        string IndustrySector,
        string Jurisdiction,
        RegulatoryBill[] BillsAndMandates,
        SectorRiskProfile[] SectorRisks,
        ComplianceActionItem[] ComplianceChecklist,
        string SpokenComplianceScript,
        DateTimeOffset GeneratedAt);

    [HttpPost("scan")]
    public IActionResult Scan([FromBody] RegulatoryRadarRequest? request)
    {
        var sector = string.IsNullOrWhiteSpace(request?.IndustrySector) ? "All NZ/APAC Sectors" : request.IndustrySector.Trim();
        var jurisdiction = string.IsNullOrWhiteSpace(request?.Jurisdiction) ? "New Zealand / Australasia" : request.Jurisdiction.Trim();

        var cacheKey = $"regulatory_radar:{sector.ToLowerInvariant()}:{jurisdiction.ToLowerInvariant()}";
        if (cache.TryGetValue(cacheKey, out RegulatoryRadarResponse? cached) && cached != null)
        {
            return Ok(cached);
        }

        var bills = new RegulatoryBill[]
        {
            new("Mandatory Climate-Related Disclosures (CRD Regime)",
                "Financial Markets Authority / XRB",
                "Enforcement Phase (Year 2)",
                "31 March 2027",
                "Up to NZ$5M for reporting entities; director civil liability",
                "Requires audited greenhouse gas inventory (Scope 1-3), climate scenario stress-testing, and transition governance roadmaps."),
            new("Commerce Act Market Studies & Anti-Monopoly Amendments",
                "Commerce Commission / Parliament",
                "Select Committee Review",
                "Q4 2026",
                "Up to 10% of annual turnover or NZ$10M",
                "Expands investigative enforcement powers into grocery, retail banking, and building materials wholesale pricing practices."),
            new("Privacy Act Mandatory Data Breach Notification & Fines",
                "Office of the Privacy Commissioner",
                "Second Reading",
                "Q1 2027",
                "Up to NZ$1M per systemic infringement",
                "Shortens mandatory breach notification windows to 72 hours with mandatory compliance audit powers for executive leadership."),
            new("Resource Management Fast-Track Consenting Regime",
                "Ministry for the Environment",
                "Royal Assent Passed / Implementation",
                "Immediate / In Effect",
                "Project suspension or revocation of priority status",
                "One-stop consenting gateway for major infrastructure, energy generation, and housing developments.")
        };

        var risks = new SectorRiskProfile[]
        {
            new("Banking & Wealth", "High", "FMA conduct licensing & anti-competitive deposit spread scrutiny.", "Have we documented our fair-conduct risk framework to withstand supervisory spot-checks?"),
            new("Agri-business & Export", "High", "Scope 3 supply chain carbon tracing and water discharge compliance.", "What percentage of our supplying farmer network is equipped for automated GHG reporting?"),
            new("Energy & Utilities", "Moderate", "Market power limits and transmission fast-track conditions.", "Are our peak renewable generation buildouts protected against consenting appeals?"),
            new("Technology & Retail", "Elevated", "Consumer data rights, algorithmic pricing, and privacy audits.", "Is our customer PII encrypted with verifiable automated 72-hour breach alerting?")
        };

        var checklist = new ComplianceActionItem[]
        {
            new("CHK-01", "CRD Scope 3 Baseline Verification", "Commission independent assurance over Scope 3 upstream transport and packaging emissions.", "Q3 2026", "Urgent"),
            new("CHK-02", "Privacy Protocol & 72h Runbook Audit", "Test executive notification tabletop exercise for customer record exfiltration.", "Q4 2026", "Urgent"),
            new("CHK-03", "Supplier Fair Conduct Certification", "Refresh vendor agreements to ensure adherence to Commerce Commission wholesale code of conduct.", "Q1 2027", "Medium"),
            new("CHK-04", "Fast-Track Consenting Pipeline Eligibility", "Assess pending capital expenditure projects against Schedule 2 national infrastructure criteria.", "Q2 2027", "Monitoring")
        };

        var script = $"Regulatory horizon brief for {sector}. Top compliance pressure points include Year 2 Climate-Related Disclosures enforcement, Commerce Commission market power scrutiny, and expedited 72-hour data privacy notification deadlines. The board must verify Scope 3 audit assurance and privacy incident tabletop testing before year end.";

        var response = new RegulatoryRadarResponse(
            Available: true,
            IndustrySector: sector,
            Jurisdiction: jurisdiction,
            BillsAndMandates: bills,
            SectorRisks: risks,
            ComplianceChecklist: checklist,
            SpokenComplianceScript: script,
            GeneratedAt: DateTimeOffset.UtcNow);

        cache.Set(cacheKey, response, TimeSpan.FromMinutes(15));
        logger?.LogDebug("Regulatory radar compiled response for sector {Sector}.", sector);
        return Ok(response);
    }
}
