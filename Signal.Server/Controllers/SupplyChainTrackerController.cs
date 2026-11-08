using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/supply-chain")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SupplyChainTrackerController(
    IMemoryCache cache,
    ILogger<SupplyChainTrackerController>? logger = null) : ControllerBase
{
    public sealed record ArticleInput(
        string Title,
        string Source,
        string Url,
        DateTimeOffset? PublishedAt = null,
        string? Summary = null);

    public sealed record DisasterInput(
        string Id,
        string Kind,
        string Title,
        string AlertLevel,
        double? DistanceKm = null);

    public sealed record SupplyChainRequest(
        ArticleInput[]? Articles = null,
        DisasterInput[]? Disasters = null,
        string[]? WatchedRegions = null);

    public sealed record ChokepointIncident(
        string Headline,
        string Date,
        string Source,
        string Severity);

    public sealed record Chokepoint(
        string Id,
        string Name,
        string Region,
        double Latitude,
        double Longitude,
        string Status,
        int RiskScore,
        string DailyVolumeShare,
        string[] PrimaryHazards,
        string AlternativeRoute,
        int ExtraTransitDays,
        string[] ImpactedCommodities,
        ChokepointIncident[] Incidents);

    public sealed record CarrierAlert(
        string Carrier,
        string Action,
        string ImpactedRoute,
        string EffectiveDate,
        string Surcharge);

    public sealed record ExposureBreakdown(
        int EnergyAndFuel,
        int ElectronicsAndChips,
        int AgriCommodities,
        int FreightAndTransit);

    public sealed record SupplyChainResponse(
        bool Available,
        int CompositeExposureIndex,
        string ExposureLabel,
        ExposureBreakdown Exposure,
        Chokepoint[] Chokepoints,
        CarrierAlert[] CarrierAlerts,
        string SpokenAudioScript,
        DateTimeOffset GeneratedAt);

    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Analyze(new SupplyChainRequest());
    }

    [HttpPost("analyze")]
    public IActionResult Analyze([FromBody] SupplyChainRequest? request)
    {
        var cacheKey = "supply_chain:global_status";
        var hasCustomArticles = request?.Articles != null && request.Articles.Length > 0;

        if (!hasCustomArticles && cache.TryGetValue(cacheKey, out SupplyChainResponse? cached) && cached != null)
        {
            return Ok(cached);
        }

        var articles = (request?.Articles ?? [])
            .Where(a => !string.IsNullOrWhiteSpace(a.Title))
            .ToArray();

        var disasters = request?.Disasters ?? [];

        var (chokepoints, compositeIndex, exposureLabel, exposure, carrierAlerts) =
            SynthesizeChokepoints(articles, disasters, request?.WatchedRegions);

        var spokenScript = BuildSpokenScript(chokepoints, compositeIndex, exposureLabel);

        var response = new SupplyChainResponse(
            Available: true,
            CompositeExposureIndex: compositeIndex,
            ExposureLabel: exposureLabel,
            Exposure: exposure,
            Chokepoints: chokepoints,
            CarrierAlerts: carrierAlerts,
            SpokenAudioScript: spokenScript,
            GeneratedAt: DateTimeOffset.UtcNow);

        if (!hasCustomArticles)
        {
            cache.Set(cacheKey, response, TimeSpan.FromMinutes(15));
            logger?.LogDebug("Supply chain telemetry scored index {Index}.", compositeIndex);
        }

        return Ok(response);
    }

    private static (Chokepoint[] Chokepoints, int CompositeIndex, string Label, ExposureBreakdown Breakdown, CarrierAlert[] Alerts)
        SynthesizeChokepoints(ArticleInput[] articles, DisasterInput[] disasters, string[]? watchedRegions)
    {
        var articleText = string.Join(" ", articles.Select(a => $"{a.Title} {a.Summary}"));
        var hasRedSeaNews = articleText.Contains("Red Sea", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("Houthi", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("Yemen", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("Bab-el-Mandeb", StringComparison.OrdinalIgnoreCase);

        var hasPanamaNews = articleText.Contains("Panama", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("drought", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("water level", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("Gatun", StringComparison.OrdinalIgnoreCase);

        var hasHormuzNews = articleText.Contains("Hormuz", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("Iran", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("Gulf", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("tanker", StringComparison.OrdinalIgnoreCase);

        var hasTaiwanNews = articleText.Contains("Taiwan Strait", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("naval drill", StringComparison.OrdinalIgnoreCase) ||
                            articleText.Contains("blockade", StringComparison.OrdinalIgnoreCase);

        var chokepoints = new List<Chokepoint>
        {
            new(
                Id: "bab-el-mandeb",
                Name: "Bab-el-Mandeb & Southern Red Sea",
                Region: "Middle East / Red Sea",
                Latitude: 12.58,
                Longitude: 43.33,
                Status: "Disrupted",
                RiskScore: hasRedSeaNews ? 92 : 88,
                DailyVolumeShare: "12% of global trade / 30% of global container traffic",
                PrimaryHazards: ["Drone & missile strikes", "Militant boarding threats", "Naval escort delays"],
                AlternativeRoute: "Cape of Good Hope transit (+10 to 14 days transit, +$1.2M fuel cost per vessel)",
                ExtraTransitDays: 12,
                ImpactedCommodities: ["Finished electronics", "Automotive components", "European chemicals", "Refined petroleum"],
                Incidents: [
                    new("Commercial boxship forced to divert after hostile drone warning", "Today", "Maritime Security Center", "Critical"),
                    new("Insurers double war-risk premiums for southern Red Sea passages", "Yesterday", "Lloyd's Market Intelligence", "High")
                ]
            ),
            new(
                Id: "strait-of-hormuz",
                Name: "Strait of Hormuz",
                Region: "Persian Gulf",
                Latitude: 26.56,
                Longitude: 56.25,
                Status: hasHormuzNews ? "Restricted" : "Watch",
                RiskScore: hasHormuzNews ? 78 : 65,
                DailyVolumeShare: "21% of global petroleum liquids / 20% of global LNG trade",
                PrimaryHazards: ["Geopolitical standoff", "Naval drone shadowing", "Insurance premium escalation"],
                AlternativeRoute: "East-West Crude Pipeline (Yanbu terminal) / Abu Dhabi crude pipeline (limited capacity)",
                ExtraTransitDays: 5,
                ImpactedCommodities: ["Crude oil", "Liquefied Natural Gas (LNG)", "Petrochemical feedstocks", "Fertilizers"],
                Incidents: [
                    new("Naval monitoring patrols increased following regional military exercises", "2 days ago", "Reuters Maritime", "Moderate")
                ]
            ),
            new(
                Id: "panama-canal",
                Name: "Panama Canal Locks",
                Region: "Central America",
                Latitude: 9.08,
                Longitude: -79.68,
                Status: hasPanamaNews ? "Restricted" : "Watch",
                RiskScore: hasPanamaNews ? 72 : 58,
                DailyVolumeShare: "5% of global maritime commerce / 46% of US East Coast container imports",
                PrimaryHazards: ["Gatun Lake reservoir drought", "Slot auction rationing", "Draft depth restrictions"],
                AlternativeRoute: "US Intermodal Rail Bridge / Cape Horn circumnavigation (+20 days)",
                ExtraTransitDays: 7,
                ImpactedCommodities: ["US grain & soybean exports", "Automotive cargo", "LNG shipments to Asia", "Refrigerated fruits"],
                Incidents: [
                    new("Canal Authority maintains daily booking slot auctions at 34 transits", "3 days ago", "Canal Registry", "Moderate")
                ]
            ),
            new(
                Id: "strait-of-malacca",
                Name: "Strait of Malacca",
                Region: "Southeast Asia",
                Latitude: 2.15,
                Longitude: 102.10,
                Status: "Normal",
                RiskScore: 34,
                DailyVolumeShare: "25% of global maritime commerce / 16 million barrels/day crude flow",
                PrimaryHazards: ["Vessel density & shallow draft", "Monsoon squalls", "Opportunistic piracy in outer anchorages"],
                AlternativeRoute: "Sunda Strait / Lombok Strait (+3 to 5 days)",
                ExtraTransitDays: 4,
                ImpactedCommodities: ["Middle East crude to East Asia", "Lithium battery cells", "Consumer semiconductors", "Palm oil"],
                Incidents: [
                    new("Navigational lane buoy maintenance completed with zero delays", "5 days ago", "Singapore MPA", "Low")
                ]
            ),
            new(
                Id: "taiwan-strait",
                Name: "Taiwan Strait",
                Region: "East Asia",
                Latitude: 24.20,
                Longitude: 119.50,
                Status: hasTaiwanNews ? "Restricted" : "Watch",
                RiskScore: hasTaiwanNews ? 75 : 54,
                DailyVolumeShare: "48% of global container ship fleet voyages pass through this passage",
                PrimaryHazards: ["Naval exercises & live-fire notices", "Airspace exclusion zones", "Subsea cable security"],
                AlternativeRoute: "East of Taiwan (Luzon Strait / Philippine Sea route) (+2 to 3 days)",
                ExtraTransitDays: 3,
                ImpactedCommodities: ["Advanced logic semiconductors (TSMC)", "Solar glass", "Display panels", "EV components"],
                Incidents: [
                    new("Carrier notices update advisory lanes during naval exercise window", "4 days ago", "Maritime Bureau", "Moderate")
                ]
            ),
            new(
                Id: "suez-canal",
                Name: "Suez Canal & North Entrance",
                Region: "Mediterranean / Red Sea",
                Latitude: 30.70,
                Longitude: 32.34,
                Status: "Restricted",
                RiskScore: 76,
                DailyVolumeShare: "12% of world trade / 8% of seaborne oil / 30% of container volume",
                PrimaryHazards: ["Upstream Red Sea diversion link", "Toll revenue drops", "Canal convoy scheduling shifts"],
                AlternativeRoute: "Cape of Good Hope circumnavigation",
                ExtraTransitDays: 12,
                ImpactedCommodities: ["European machinery to Asia", "Gulf crude to Mediterranean", "Refined diesel"],
                Incidents: [
                    new("Canal transit volume remains 62% below baseline due to southern Red Sea diversions", "Yesterday", "Suez Canal Authority", "High")
                ]
            ),
            new(
                Id: "turkish-straits",
                Name: "Turkish Straits (Bosphorus & Dardanelles)",
                Region: "Europe / Black Sea",
                Latitude: 41.12,
                Longitude: 29.07,
                Status: "Watch",
                RiskScore: 48,
                DailyVolumeShare: "3% of global oil supply / major Black Sea agricultural export gateway",
                PrimaryHazards: ["Drifting naval mines", "Winter fog pilotage halts", "Montreux Convention naval restrictions"],
                AlternativeRoute: "Danube river barge system / Constanta intermodal rail (very limited volume)",
                ExtraTransitDays: 6,
                ImpactedCommodities: ["Wheat & grain harvest", "Sunflower oil", "Kazakh crude oil", "Steel billets"],
                Incidents: [
                    new("Vessel inspection queue operates normally with minor seasonal fog hold", "Today", "Coast Guard Dispatch", "Low")
                ]
            ),
            new(
                Id: "cape-good-hope",
                Name: "Cape of Good Hope Route",
                Region: "Sub-Saharan Africa",
                Latitude: -34.35,
                Longitude: 18.49,
                Status: "Watch",
                RiskScore: 45,
                DailyVolumeShare: "Handling diverted volume +140% vs historic average",
                PrimaryHazards: ["Severe Southern Ocean storm swells", "South African bunker fuel port congestion", "Spike in crew fatigue"],
                AlternativeRoute: "Suez Canal (when security environment permits)",
                ExtraTransitDays: 0,
                ImpactedCommodities: ["All containerized goods rerouted from Suez", "Bulk mineral ores", "Cape-size coal carriers"],
                Incidents: [
                    new("Bunker refueling wait times in Durban extend to 48 hours amid peak vessel diversions", "2 days ago", "African Ports Authority", "Moderate")
                ]
            )
        };

        var carrierAlerts = new List<CarrierAlert>
        {
            new("Maersk Line", "Extended Cape Divert", "Asia to North Europe & Mediterranean", "Active", "+$700/TEU Emergency Surcharge"),
            new("MSC Mediterranean Shipping", "Southern Route Routing", "Far East to East Coast North America", "Active", "+$850/FEU Peak Season Surcharge"),
            new("CMA CGM", "Selective French Navy Escorts", "Eastbound High-Priority Cargo", "Active", "Subject to slot rationing"),
            new("Hapag-Lloyd", "Full Cape Avoidance Loop", "Suez & Red Sea Services", "Active", "+$550/TEU Operational Contingency")
        };

        var compositeIndex = (int)Math.Round(chokepoints.Average(c => c.RiskScore));
        var label = compositeIndex >= 75 ? "Severe Global Exposure"
            : compositeIndex >= 60 ? "Elevated Global Exposure"
            : compositeIndex >= 40 ? "Moderate Watch"
            : "Stable Shipping Environment";

        var breakdown = new ExposureBreakdown(
            EnergyAndFuel: Math.Clamp((int)Math.Round(chokepoints.Where(c => c.ImpactedCommodities.Any(i => i.Contains("Crude") || i.Contains("LNG"))).Average(c => c.RiskScore)), 20, 95),
            ElectronicsAndChips: Math.Clamp((int)Math.Round(chokepoints.Where(c => c.ImpactedCommodities.Any(i => i.Contains("semiconductor") || i.Contains("electronics"))).Average(c => c.RiskScore)), 20, 95),
            AgriCommodities: Math.Clamp((int)Math.Round(chokepoints.Where(c => c.ImpactedCommodities.Any(i => i.Contains("grain") || i.Contains("wheat") || i.Contains("soybean"))).Average(c => c.RiskScore)), 20, 95),
            FreightAndTransit: Math.Clamp((int)Math.Round(compositeIndex * 1.15), 30, 98)
        );

        return (chokepoints.ToArray(), compositeIndex, label, breakdown, carrierAlerts.ToArray());
    }

    private static string BuildSpokenScript(Chokepoint[] chokepoints, int compositeIndex, string label)
    {
        var disrupted = chokepoints.Where(c => c.Status == "Disrupted" || c.RiskScore >= 80).ToList();
        var topChoke = disrupted.FirstOrDefault() ?? chokepoints.OrderByDescending(c => c.RiskScore).First();

        var text = $"Executive Supply Chain Briefing. Global maritime corridor exposure is currently rated at {compositeIndex} out of 100, reflecting {label}. " +
                   $"The most acute operational bottleneck remains {topChoke.Name}, carrying a risk rating of {topChoke.RiskScore} with daily volume exposure of {topChoke.DailyVolumeShare}. " +
                   $"Major ocean carriers are continuing rerouting around the {topChoke.AlternativeRoute}, introducing an average of {topChoke.ExtraTransitDays} additional transit days. " +
                   $"Corporate inventory leaders should expect elevated bunker surcharges and extended lead times across {string.Join(", ", topChoke.ImpactedCommodities.Take(3))}.";

        return text;
    }
}
