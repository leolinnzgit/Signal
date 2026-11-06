using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/geopolitical-transit")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class GeopoliticalTransitController(
    IMemoryCache cache,
    ILogger<GeopoliticalTransitController>? logger = null) : ControllerBase
{
    public sealed record ChokepointZone(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("region")] string Region,
        [property: JsonPropertyName("coordinates")] double[] Coordinates, // [Lat, Lon]
        [property: JsonPropertyName("threatLevel")] string ThreatLevel, // "Normal" | "Elevated" | "High" | "Critical"
        [property: JsonPropertyName("dailyTeuVolume")] int DailyTeuVolume,
        [property: JsonPropertyName("dailyOilBarrelsMbpd")] double DailyOilBarrelsMbpd,
        [property: JsonPropertyName("detourDays")] double DetourDays,
        [property: JsonPropertyName("fuelCostDeltaPercent")] double FuelCostDeltaPercent,
        [property: JsonPropertyName("airspaceStatus")] string AirspaceStatus, // "Open" | "Advisory" | "Restricted" | "Closed"
        [property: JsonPropertyName("keyCommodities")] string[] KeyCommodities,
        [property: JsonPropertyName("activeNotams")] string[] ActiveNotams,
        [property: JsonPropertyName("strategicBrief")] string StrategicBrief);

    public sealed record AirspaceAdvisory(
        [property: JsonPropertyName("zoneId")] string ZoneId,
        [property: JsonPropertyName("regionName")] string RegionName,
        [property: JsonPropertyName("flightLevelFloor")] string FlightLevelFloor,
        [property: JsonPropertyName("issuingAuthority")] string IssuingAuthority,
        [property: JsonPropertyName("hazardType")] string HazardType,
        [property: JsonPropertyName("commercialRerouteCostIndex")] double CommercialRerouteCostIndex);

    public sealed record TransitCorrelatedArticle(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("url")] string Url,
        [property: JsonPropertyName("relevance")] string Relevance);

    public sealed record TransitAssessmentRequest(
        [property: JsonPropertyName("chokepointId")] string? ChokepointId,
        [property: JsonPropertyName("articles")] TransitCorrelatedArticle[]? Articles);

    public sealed record TransitAssessmentResponse(
        [property: JsonPropertyName("chokepointId")] string ChokepointId,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("riskScore")] int RiskScore, // 0 - 100
        [property: JsonPropertyName("statusDescription")] string StatusDescription,
        [property: JsonPropertyName("alternativeRoute")] string AlternativeRoute,
        [property: JsonPropertyName("estimatedDailyTradeDisruptionUsd")] string EstimatedDailyTradeDisruptionUsd,
        [property: JsonPropertyName("executiveActionItems")] string[] ExecutiveActionItems,
        [property: JsonPropertyName("correlatedArticles")] TransitCorrelatedArticle[] CorrelatedArticles,
        [property: JsonPropertyName("assessedAt")] DateTimeOffset AssessedAt);

    private static readonly ChokepointZone[] DefaultChokepoints =
    [
        new(
            Id: "hormuz",
            Name: "Strait of Hormuz",
            Region: "Middle East / Persian Gulf",
            Coordinates: [26.5667, 56.2500],
            ThreatLevel: "High",
            DailyTeuVolume: 42000,
            DailyOilBarrelsMbpd: 21.0,
            DetourDays: 14.5,
            FuelCostDeltaPercent: 42.0,
            AirspaceStatus: "Advisory",
            KeyCommodities: ["Crude Oil", "LNG", "Condensates", "Petrochemicals"],
            ActiveNotams: ["FAA KICZ NOTAM A0012/26: Flight level restriction FL260-FL350 over Gulf of Oman", "EASA CZIB-2026-03: GPS spoofing reported near Bandar Abbas"],
            StrategicBrief: "Persian Gulf arterial corridor carrying 20% of global petroleum liquids. IRGC fast-boat patrols and GPS spoofing active near Qeshm island."
        ),
        new(
            Id: "bab-el-mandeb",
            Name: "Bab el-Mandeb & Southern Red Sea",
            Region: "Horn of Africa / Red Sea",
            Coordinates: [12.5833, 43.3333],
            ThreatLevel: "Critical",
            DailyTeuVolume: 68000,
            DailyOilBarrelsMbpd: 8.8,
            DetourDays: 12.0,
            FuelCostDeltaPercent: 38.5,
            AirspaceStatus: "Restricted",
            KeyCommodities: ["Manufactured Goods", "Electronics", "Refined Products", "Grain"],
            ActiveNotams: ["UK CAA NOTAM V0044/26: Anti-ship ballistic missile danger zone off Al-Hudaydah", "FAA Warning: Drone & missile launch vectors southwest Yemen"],
            StrategicBrief: "65% of container transit diverted via Cape of Good Hope. War risk insurance premiums elevated 280% over 5-year historical medians."
        ),
        new(
            Id: "taiwan-strait",
            Name: "Taiwan Strait & Bashi Channel",
            Region: "East Asia / Western Pacific",
            Coordinates: [24.0000, 119.5000],
            ThreatLevel: "Elevated",
            DailyTeuVolume: 125000,
            DailyOilBarrelsMbpd: 14.2,
            DetourDays: 6.0,
            FuelCostDeltaPercent: 18.0,
            AirspaceStatus: "Advisory",
            KeyCommodities: ["Advanced Semiconductor Chips", "Consumer Electronics", "Display Glass", "Auto Components"],
            ActiveNotams: ["Taipei FIR Advisory: Live-fire exercises in designated exclusion blocks", "Fukuoka FIR Advisory: Unannounced military drone orbits west of Yonaguni"],
            StrategicBrief: "Carries 48% of global container ship fleet and over 80% of top-tier sub-5nm microchips. PLA naval joint patrol exercises remain periodic."
        ),
        new(
            Id: "malacca",
            Name: "Strait of Malacca & Singapore Strait",
            Region: "Southeast Asia",
            Coordinates: [2.5000, 101.5000],
            ThreatLevel: "Normal",
            DailyTeuVolume: 180000,
            DailyOilBarrelsMbpd: 16.5,
            DetourDays: 3.5,
            FuelCostDeltaPercent: 9.5,
            AirspaceStatus: "Open",
            KeyCommodities: ["Crude Oil", "LNG", "Dry Bulk Minerals", "Electronics"],
            ActiveNotams: ["Singapore CAAS Advisory: High density low-altitude UAV harbor surveying", "Kuala Lumpur FIR: Seasonal monsoon squall vectoring"],
            StrategicBrief: "Primary maritime gateway linking Indian and Pacific Oceans. High tanker density with average anchorage wait time under 18 hours."
        ),
        new(
            Id: "panama-canal",
            Name: "Panama Canal (Miraflores & Gatun)",
            Region: "Central America",
            Coordinates: [9.0800, -79.6800],
            ThreatLevel: "Elevated",
            DailyTeuVolume: 38000,
            DailyOilBarrelsMbpd: 2.4,
            DetourDays: 16.0,
            FuelCostDeltaPercent: 32.0,
            AirspaceStatus: "Open",
            KeyCommodities: ["US Gulf LNG", "LPG", "Grain", "Automotive"],
            ActiveNotams: ["Panama AAC Advisory: Gatun Lake meteorological sensor flight clearance", "Colón Approach: Standard visual corridors"],
            StrategicBrief: "Gatun Lake freshwater levels at 81.4 ft. Draft limit held at 44.0 ft with 32 daily reservation slots across Neopanamax and Panamax locks."
        ),
        new(
            Id: "bosporus",
            Name: "Turkish Straits (Bosporus & Dardanelles)",
            Region: "Black Sea / Mediterranean",
            Coordinates: [41.1167, 29.0667],
            ThreatLevel: "Elevated",
            DailyTeuVolume: 22000,
            DailyOilBarrelsMbpd: 3.2,
            DetourDays: 8.0,
            FuelCostDeltaPercent: 22.0,
            AirspaceStatus: "Advisory",
            KeyCommodities: ["Wheat & Agricultural Grain", "Sunflower Oil", "Crude Oil", "Steel"],
            ActiveNotams: ["Black Sea NOTAM: Drifting naval mine risk northern Black Sea waters", "Istanbul FIR: Military escort radar corridors"],
            StrategicBrief: "Regulated by Montreux Convention. Grain shipment escort queues average 3.2 days under Black Sea maritime safety corridors."
        ),
        new(
            Id: "arctic-route",
            Name: "Bering Strait & Northern Sea Route",
            Region: "Arctic / North Pacific",
            Coordinates: [65.9833, -168.9500],
            ThreatLevel: "Elevated",
            DailyTeuVolume: 6500,
            DailyOilBarrelsMbpd: 1.8,
            DetourDays: -10.0, // Shorter route compared to Suez, but high geopolitical risk
            FuelCostDeltaPercent: -15.0,
            AirspaceStatus: "Advisory",
            KeyCommodities: ["Arctic LNG", "Nickel", "Palladium", "Crude Oil"],
            ActiveNotams: ["Anchorage Oceanic FIR: Polar communications blackouts during solar coronal events", "Murmansk FIR: Icebreaker escort exclusion sectors"],
            StrategicBrief: "High seasonal ice variability and sovereign Russian maritime clearance requirements. Transit cut by 35% distance vs Suez, but uninsurable for Western tiers."
        )
    ];

    [HttpGet("chokepoints")]
    public IActionResult GetChokepoints()
    {
        return Ok(DefaultChokepoints);
    }

    [HttpGet("airspace-advisories")]
    public IActionResult GetAirspaceAdvisories()
    {
        AirspaceAdvisory[] advisories =
        [
            new("bab-el-mandeb", "Southern Red Sea & Gulf of Aden", "SFC to UNL", "UK CAA / FAA", "Anti-ship missile & military drone vectors", 1.45),
            new("hormuz", "Persian Gulf & Gulf of Oman", "FL260 to FL350", "FAA / EASA", "GPS jamming & naval electronic warfare", 1.25),
            new("taiwan-strait", "Taiwan Strait ADIZ", "SFC to FL400", "Taipei CAA / Fukuoka FIR", "Live-fire military exercises & ADIZ incursions", 1.18),
            new("black-sea", "Northern Black Sea & Crimean Coast", "SFC to UNL", "Eurocontrol / EASA", "Active air defense interception & missile corridors", 1.55)
        ];
        return Ok(advisories);
    }

    [HttpPost("assess")]
    [IgnoreAntiforgeryToken]
    public IActionResult AssessTransit([FromBody] TransitAssessmentRequest? request)
    {
        var chokepointId = request?.ChokepointId?.Trim().ToLowerInvariant() ?? "bab-el-mandeb";
        var chokepoint = DefaultChokepoints.FirstOrDefault(c => c.Id == chokepointId) ?? DefaultChokepoints[1];

        // Calculate dynamic risk score based on threat level and context articles
        var baseScore = chokepoint.ThreatLevel switch
        {
            "Critical" => 88,
            "High" => 74,
            "Elevated" => 56,
            _ => 28
        };

        var articles = request?.Articles ?? [];
        if (articles.Length > 0)
        {
            var text = string.Join(" ", articles.Select(a => $"{a.Title} {a.Relevance}"));
            if (text.Contains("attack", StringComparison.OrdinalIgnoreCase) ||
                text.Contains("missile", StringComparison.OrdinalIgnoreCase) ||
                text.Contains("drone", StringComparison.OrdinalIgnoreCase) ||
                text.Contains("strait", StringComparison.OrdinalIgnoreCase))
            {
                baseScore = Math.Min(98, baseScore + 8);
            }
        }

        var alternative = chokepoint.Id switch
        {
            "bab-el-mandeb" => "Reroute via Cape of Good Hope (+10 to 14 sailing days, +$920k bunker fuel per round trip)",
            "hormuz" => "Pipeline transfer via East-West Petroline (Yanbu terminal) and Fujairah pipeline bypass",
            "taiwan-strait" => "Eastern Taiwan / Philippine Sea deepwater corridor (+3 to 5 days, extra maritime insurance)",
            "panama-canal" => "Magellan Strait or overland US West Coast rail intermodal (landbridge)",
            "bosporus" => "Danube river barge corridor or overland Romanian/Bulgarian rail transshipment",
            _ => "Standard southern hemisphere oceanic deep-sea navigation"
        };

        var disruptionEstimate = chokepoint.Id switch
        {
            "bab-el-mandeb" => "$3.8B daily merchandise value delayed",
            "hormuz" => "$9.4B daily hydrocarbon flow at risk",
            "taiwan-strait" => "$5.2B daily high-tech electronics & components affected",
            "panama-canal" => "$1.1B daily dry bulk and LNG rerouted",
            _ => "$650M daily regional freight friction"
        };

        string[] actions = chokepoint.Id switch
        {
            "bab-el-mandeb" => [
                "Lock in 45-day bunker fuel futures hedges against sustained Cape reroute premiums.",
                "Advance European tier-1 delivery windows by 12 days to compensate for transit delay.",
                "Review war risk hull & machinery insurance deductibles with maritime underwriters."
            ],
            "hormuz" => [
                "Verify crude inventory buffers for 30-day refinery continuity.",
                "Enable secondary off-take agreements through Mediterranean and Fujairah export docks.",
                "Instruct carrier partners to maintain satellite tracking and electronic warfare safeguards."
            ],
            "taiwan-strait" => [
                "Audit tier-2 advanced packaging wafer inventory held outside the perimeter.",
                "Reserve air-cargo capacity options on Tokyo-Haneda and Seoul-Incheon routes.",
                "Monitor cross-strait ADIZ exercise notices for scheduled civilian airspace closures."
            ],
            _ => [
                "Maintain real-time AIS vessel ping surveillance through supply chain dashboards.",
                "Pre-book intermodal rail connections at receiving deepwater ports.",
                "Issue inventory alerts to assembly plants for components with lead times > 21 days."
            ]
        };

        var response = new TransitAssessmentResponse(
            ChokepointId: chokepoint.Id,
            Name: chokepoint.Name,
            RiskScore: baseScore,
            StatusDescription: $"{chokepoint.Name} is currently operating at {chokepoint.ThreatLevel} threat posture. Detour penalty: +{chokepoint.DetourDays} days.",
            AlternativeRoute: alternative,
            EstimatedDailyTradeDisruptionUsd: disruptionEstimate,
            ExecutiveActionItems: actions,
            CorrelatedArticles: articles,
            AssessedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }
}
