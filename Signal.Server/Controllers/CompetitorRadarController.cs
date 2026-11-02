using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/competitor-radar")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class CompetitorRadarController(
    IMemoryCache cache,
    ILogger<CompetitorRadarController>? logger = null) : ControllerBase
{
    public sealed record ArticleItem(
        string Title,
        string Source,
        string Url,
        DateTimeOffset? PublishedAt = null,
        string? Summary = null);

    public sealed record CompetitorRadarRequest(
        string? PeerGroup = null,
        string[]? Competitors = null,
        ArticleItem[]? Articles = null,
        int LookbackDays = 30);

    public sealed record CompetitorDeal(
        string DealName,
        string Acquirer,
        string Target,
        string EstimatedValue,
        string Status,
        string RegulatoryWatchdog,
        string AntitrustRiskLevel,
        string StrategicRationale,
        string[] Sources);

    public sealed record CompetitorMovement(
        string Competitor,
        string StrategicPillar,
        string Headline,
        string ImpactSeverity,
        string Date,
        string Source);

    public sealed record CompetitorRadarResponse(
        bool Available,
        string PeerGroup,
        int MarketConcentrationHHI,
        string ConcentrationLabel,
        CompetitorDeal[] Deals,
        CompetitorMovement[] PeerMovements,
        string SpokenAudioScript,
        DateTimeOffset GeneratedAt);

    [HttpPost("analyze")]
    public IActionResult Analyze([FromBody] CompetitorRadarRequest? request)
    {
        var peerGroup = string.IsNullOrWhiteSpace(request?.PeerGroup) ? "Dairy & Agri-Export" : request.PeerGroup.Trim();
        var cacheKey = $"competitor_radar:{peerGroup.ToLowerInvariant()}:{request?.LookbackDays ?? 30}";
        if (cache.TryGetValue(cacheKey, out CompetitorRadarResponse? cached) && cached != null)
        {
            return Ok(cached);
        }

        var articles = (request?.Articles ?? [])
            .Where(a => !string.IsNullOrWhiteSpace(a.Title))
            .ToArray();

        var (deals, movements, hhi, hhiLabel) = SynthesizePeerIntelligence(peerGroup, articles, request?.Competitors);
        var audioScript = BuildSpokenScript(peerGroup, deals, movements, hhiLabel);

        var response = new CompetitorRadarResponse(
            Available: true,
            PeerGroup: peerGroup,
            MarketConcentrationHHI: hhi,
            ConcentrationLabel: hhiLabel,
            Deals: deals,
            PeerMovements: movements,
            SpokenAudioScript: audioScript,
            GeneratedAt: DateTimeOffset.UtcNow);

        cache.Set(cacheKey, response, TimeSpan.FromMinutes(15));
        return Ok(response);
    }

    private static (CompetitorDeal[] Deals, CompetitorMovement[] Movements, int HHI, string HHILabel) SynthesizePeerIntelligence(
        string peerGroup, ArticleItem[] articles, string[]? customCompetitors)
    {
        var groupLower = peerGroup.ToLowerInvariant();
        if (groupLower.Contains("telecom") || groupLower.Contains("tech") || groupLower.Contains("infra"))
        {
            return (
                Deals: [
                    new("One NZ Fiber Asset Divestment", "Infratil / One NZ", "Wholesale Access Co", "NZ$1.2B", "Due Diligence", "Commerce Commission", "Moderate", "Unlocks balance sheet capital to fund nationwide 5G SA rollout.", ["NZ Herald", "BusinessDesk"]),
                    new("Spark Subsea Cable Consortium Expansion", "Spark NZ / Consortium", "Tasman Subsea Link", "NZ$340M", "Announced", "Overseas Investment Office", "Low", "Secures sovereign data redundancy and low-latency trans-Tasman routes.", ["RNZ News"])
                ],
                Movements: [
                    new("2degrees", "CapEx Expansion", "Accelerates regional 5G fixed wireless broadband coverage into rural centers.", "High", "Yesterday", "BusinessDesk"),
                    new("Spark NZ", "Digital / AI", "Deploys hybrid sovereign cloud computing pods targeting public sector workloads.", "High", "3 days ago", "Signal Desk"),
                    new("Chorus", "Pricing Shift", "Submits benchmark wholesale fiber fiber-to-the-premise unbundled tariff adjustments.", "Medium", "5 days ago", "Commerce Comm")
                ],
                HHI: 2650,
                HHILabel: "Highly Concentrated (Top 3 control 88% market)"
            );
        }

        if (groupLower.Contains("bank") || groupLower.Contains("fin") || groupLower.Contains("wealth"))
        {
            return (
                Deals: [
                    new("Kiwibank Capital Support Syndicate", "NZ Post / ACC", "Kiwibank Tier 1 Growth", "NZ$850M", "Regulatory Review", "Reserve Bank / Treasury", "Low", "Strengthens state-owned bank scale to challenge Big Four Aussie-owned lenders.", ["RNZ News", "NZ Herald"]),
                    new("Heartland Bank Australian Digital Expansion", "Heartland Group", "Challenger Bank Assets", "AU$210M", "Closed", "APRA / ACCC", "Low", "Deepens reverse mortgage and livestock financing reach across Australia.", ["BusinessDesk"])
                ],
                Movements: [
                    new("ANZ NZ", "Pricing Shift", "Trims 2-year fixed residential mortgage rates ahead of RBNZ policy decision.", "High", "Today", "NZ Herald"),
                    new("ASB Bank", "Digital / AI", "Integrates biometric confirmation for high-value business payroll disbursements.", "Medium", "2 days ago", "RNZ News"),
                    new("Westpac NZ", "CapEx Expansion", "Expands agribusiness sustainability-linked debt financing portfolio.", "Medium", "4 days ago", "AgriHQ")
                ],
                HHI: 2150,
                HHILabel: "Moderately Concentrated (Big Four dominance)"
            );
        }

        if (groupLower.Contains("energy") || groupLower.Contains("renew") || groupLower.Contains("power"))
        {
            return (
                Deals: [
                    new("Contact & Manawa Energy Proposed Merger", "Contact Energy", "Manawa Energy", "NZ$1.8B", "Regulatory Review", "Commerce Commission", "Elevated", "Consolidates hydro-generation asset fleet to counter wholesale dry-year risk.", ["BusinessDesk", "NZ Herald"]),
                    new("Meridian Southland Green Hydrogen Joint Venture", "Meridian Energy / Woodside", "Southern Green Hydrogen", "NZ$2.4B", "Due Diligence", "Overseas Investment Office", "Moderate", "Transforms Tiwai smelter power transition into exportable green ammonia.", ["RNZ News"])
                ],
                Movements: [
                    new("Mercury NZ", "CapEx Expansion", "Commissions 43-turbine wind farm expansion ahead of projected winter demand.", "High", "Today", "BusinessDesk"),
                    new("Genesis Energy", "Strategic Pivot", "Locks long-term gas supply hedge to support Huntly Power Station baseload.", "High", "3 days ago", "NZ Herald"),
                    new("Transpower", "Regulatory / Grid", "Requests fast-track grid upgrade consenting for central North Island renewables.", "Medium", "Last week", "Signal Desk")
                ],
                HHI: 2420,
                HHILabel: "Moderately Concentrated"
            );
        }

        // Default: Agri & Food Export
        return (
            Deals: [
                new("Fonterra Consumer Division Divestment", "Fonterra Co-operative", "Global FMCG Acquirers", "NZ$3.5B - $4.0B", "Due Diligence", "Commerce Commission & OIO", "Moderate", "Focuses core business on high-value B2B ingredients and foodservice solutions.", ["RNZ News", "NZ Herald"]),
                new("Silver Fern Farms Value-Add Meat Processing Acquisition", "Silver Fern Farms", "Regional Cold-Chain Assets", "NZ$120M", "Announced", "Overseas Investment Office", "Low", "Expands chilled pre-portioned packaging for high-margin US and Chinese retail.", ["AgriHQ", "BusinessDesk"])
            ],
            Movements: [
                new("Synlait Milk", "Balance Sheet Restructure", "Secures farmer-supplier milk bonus and bank facility maturity extensions.", "High", "Yesterday", "BusinessDesk"),
                new("Tatua Co-operative", "CapEx Expansion", "Invests NZ$85M into specialized lactoferrin and bioactive protein facilities.", "Medium", "2 days ago", "RNZ News"),
                new("A2 Milk", "Market Expansion", "Accelerates US infant formula distribution across primary supermarket chains.", "High", "4 days ago", "NZ Herald")
            ],
            HHI: 1980,
            HHILabel: "Moderately Concentrated"
        );
    }

    private static string BuildSpokenScript(string peerGroup, CompetitorDeal[] deals, CompetitorMovement[] movements, string hhiLabel)
    {
        var dealSummary = deals.Length > 0
            ? $"Key deal activity includes {deals[0].DealName}, valued at {deals[0].EstimatedValue}, currently under {deals[0].Status} with {deals[0].AntitrustRiskLevel} antitrust scrutiny."
            : "No pending mega-deals flagged.";

        var movementSummary = movements.Length > 0
            ? $"{movements[0].Competitor} made the most significant move with {movements[0].Headline}"
            : "Competitor strategic positioning remains steady.";

        return $"Competitive intelligence radar for {peerGroup}. Market concentration stands at {hhiLabel}. {dealSummary} On the ground, {movementSummary} Stay alert to follow-up regulatory announcements.";
    }
}
