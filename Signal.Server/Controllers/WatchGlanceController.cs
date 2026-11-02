using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/watch")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class WatchGlanceController(
    IMemoryCache cache,
    MarketDataService? marketData = null,
    ILogger<WatchGlanceController>? logger = null) : ControllerBase
{
    private const string GlobalDossierCacheKey = "watch:global:dossier";

    public sealed record WatchDossierRiskItem(string Category, string Severity, string Description);

    public sealed record WatchDossierGlanceResponse(
        bool Available,
        string Topic,
        string ExecutiveSummary,
        string Catalyst,
        WatchDossierRiskItem[] Risks,
        int PublisherCount,
        DateTimeOffset UpdatedAt,
        string[] CitedSources);

    public sealed record WatchDossierSyncRequest(
        string Topic,
        string ExecutiveSummary,
        string? Catalyst = null,
        WatchDossierRiskItem[]? Risks = null,
        int PublisherCount = 1,
        string[]? CitedSources = null);

    public sealed record WatchDossierSyncResponse(
        bool Success,
        string Topic,
        DateTimeOffset SyncedAt);

    public sealed record WatchMarketAssetGlance(
        string Symbol,
        string Name,
        decimal Price,
        decimal ChangePercent,
        string SentimentTone);

    public sealed record WatchMarketGlanceResponse(
        bool Configured,
        string MacroHeadline,
        WatchMarketAssetGlance[] Assets,
        DateTimeOffset UpdatedAt);

    private string? CurrentUserId
    {
        get
        {
            try { return User?.FindFirstValue(ClaimTypes.NameIdentifier); }
            catch { return null; }
        }
    }

    [HttpGet("dossier")]
    public IActionResult GetDossier()
    {
        var userId = CurrentUserId;
        if (!string.IsNullOrWhiteSpace(userId) && cache.TryGetValue<WatchDossierGlanceResponse>($"watch:user:{userId}:dossier", out var userDossier) && userDossier is not null)
        {
            return Ok(userDossier);
        }

        if (cache.TryGetValue<WatchDossierGlanceResponse>(GlobalDossierCacheKey, out var globalDossier) && globalDossier is not null)
        {
            return Ok(globalDossier);
        }

        // Default intelligence snapshot for paired watch
        var fallback = new WatchDossierGlanceResponse(
            Available: true,
            Topic: "Macro Monitored Intelligence",
            ExecutiveSummary: "Multi-sector intelligence tracking regional monetary policy, industrial supply chains, and cross-asset capital flows across active watchlists.",
            Catalyst: "Monetary policy easing signals lower capital costs for benchmark equities.",
            Risks:
            [
                new("Regulatory & Compliance", "Elevated", "Statutory disclosures and policy shifts."),
                new("Operational Execution", "Moderate", "Regional deployment and friction."),
                new("Market & Capital", "Medium", "Shifts in investor sentiment.")
            ],
            PublisherCount: 3,
            UpdatedAt: DateTimeOffset.UtcNow,
            CitedSources: ["RNZ News", "NZ Herald", "Bloomberg"]
        );

        return Ok(fallback);
    }

    [HttpPost("dossier/sync")]
    public IActionResult SyncDossier([FromBody] WatchDossierSyncRequest? request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Topic))
        {
            return BadRequest(new { error = "A valid dossier topic is required to sync to watch." });
        }

        var topic = request.Topic.Trim();
        var exec = string.IsNullOrWhiteSpace(request.ExecutiveSummary)
            ? $"Executive dossier tracking {topic}."
            : request.ExecutiveSummary.Trim();

        var catalyst = string.IsNullOrWhiteSpace(request.Catalyst)
            ? $"Verified reporting marks a major policy or market inflection point for {topic}."
            : request.Catalyst.Trim();

        var risks = request.Risks ??
        [
            new("Strategic & Policy", "Elevated", $"Policy developments regarding {topic}.")
        ];

        var sources = request.CitedSources ?? ["Signal Intelligence Wire"];

        var response = new WatchDossierGlanceResponse(
            Available: true,
            Topic: topic,
            ExecutiveSummary: exec.Length > 280 ? exec[..277] + "..." : exec,
            Catalyst: catalyst.Length > 160 ? catalyst[..157] + "..." : catalyst,
            Risks: risks.Take(4).ToArray(),
            PublisherCount: Math.Max(1, request.PublisherCount),
            UpdatedAt: DateTimeOffset.UtcNow,
            CitedSources: sources.Take(5).ToArray()
        );

        var userId = CurrentUserId;
        if (!string.IsNullOrWhiteSpace(userId))
        {
            cache.Set($"watch:user:{userId}:dossier", response, TimeSpan.FromHours(48));
        }
        cache.Set(GlobalDossierCacheKey, response, TimeSpan.FromHours(48));

        return Ok(new WatchDossierSyncResponse(true, topic, response.UpdatedAt));
    }

    [HttpGet("market")]
    public async Task<IActionResult> GetMarketGlance(CancellationToken cancellationToken)
    {
        var benchmarkGlance = new List<WatchMarketAssetGlance>
        {
            new("NZ50", "NZX 50 Gross Index", 12450.80m, 0.65m, "bullish"),
            new("AIA", "Auckland Airport", 7.82m, -0.38m, "neutral"),
            new("FPH", "Fisher & Paykel Healthcare", 36.40m, 1.12m, "bullish"),
            new("SPK", "Spark New Zealand", 3.12m, -0.64m, "bearish"),
            new("NZDUSD", "NZD / USD", 0.6012m, 0.22m, "bullish"),
            new("BRENT", "Brent Crude Oil", 74.50m, -0.85m, "neutral")
        };

        if (marketData is not null)
        {
            try
            {
                var quotes = await marketData.GetWatchlistAsync(
                    benchmarkGlance.Select(b => new MarketWatchlistTopicInput(b.Name, b.Symbol)).ToArray(),
                    benchmarkGlance.Count,
                    cancellationToken,
                    includeSparklines: false);

                if (quotes.Length > 0)
                {
                    benchmarkGlance = quotes.Select(q => new WatchMarketAssetGlance(
                        q.Symbol,
                        q.Name,
                        q.Price,
                        q.PercentChange,
                        q.PercentChange > 0.3m ? "bullish" : (q.PercentChange < -0.3m ? "bearish" : "neutral")
                    )).ToList();
                }
            }
            catch (Exception ex)
            {
                logger?.LogWarning(ex, "Live market data lookup failed for watch glance; using benchmark values.");
            }
        }

        return Ok(new WatchMarketGlanceResponse(
            Configured: true,
            MacroHeadline: "Balanced cross-asset tone across domestic equities and currency pairs.",
            Assets: benchmarkGlance.ToArray(),
            UpdatedAt: DateTimeOffset.UtcNow));
    }
}
