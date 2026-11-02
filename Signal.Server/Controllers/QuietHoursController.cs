using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/quiet-hours")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class QuietHoursController(
    IMemoryCache cache,
    ILogger<QuietHoursController>? logger = null) : ControllerBase
{
    private const string DefaultConfigKeyPrefix = "quiet_hours_config:";

    public sealed record QuietHoursConfig(
        bool Enabled,
        string StartTime,
        string EndTime,
        string[] ActiveDays,
        decimal ShockThresholdPercent,
        string[] VipEntities,
        bool PushCrisisOnly);

    public sealed record QuietHoursEvaluateRequest(
        string Title,
        string Source,
        string? Summary = null,
        decimal? PriceChangePercent = null,
        string? Symbol = null,
        QuietHoursConfig? Config = null);

    public sealed record QuietHoursEvaluateResponse(
        bool IsQuietHoursActive,
        string TriageAction, // "break_through_crisis_alert" | "suppress_to_morning_briefing"
        string CrisisSeverity, // "Crisis" | "Urgent" | "Normal"
        string Reason,
        bool BreakthroughAllowed,
        DateTimeOffset EvaluatedAt);

    private string CurrentUserId
    {
        get
        {
            try
            {
                return User?.FindFirstValue(ClaimTypes.NameIdentifier) ?? "anonymous";
            }
            catch
            {
                return "anonymous";
            }
        }
    }

    [HttpGet("config")]
    public IActionResult GetConfig()
    {
        var key = $"{DefaultConfigKeyPrefix}{CurrentUserId}";
        if (cache.TryGetValue(key, out QuietHoursConfig? config) && config != null)
        {
            return Ok(config);
        }

        var defaultConfig = new QuietHoursConfig(
            Enabled: true,
            StartTime: "22:00",
            EndTime: "06:30",
            ActiveDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
            ShockThresholdPercent: 2.5m,
            VipEntities: ["RBNZ", "Treasury", "Reserve Bank", "Fonterra", "Air New Zealand"],
            PushCrisisOnly: true);

        return Ok(defaultConfig);
    }

    [HttpPost("config")]
    public IActionResult SaveConfig([FromBody] QuietHoursConfig? config)
    {
        if (config == null) return BadRequest(new { error = "Config is required." });

        var key = $"{DefaultConfigKeyPrefix}{CurrentUserId}";
        cache.Set(key, config, TimeSpan.FromDays(30));
        return Ok(new { success = true, config });
    }

    [HttpPost("evaluate")]
    public IActionResult Evaluate([FromBody] QuietHoursEvaluateRequest? request)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.Title))
        {
            return BadRequest(new { error = "Article title is required." });
        }

        var config = request.Config ?? GetCurrentConfigOrFallback();
        var now = DateTimeOffset.UtcNow;
        var isQuietHoursActive = IsTimeInQuietHours(now, config);

        if (!config.Enabled || !isQuietHoursActive)
        {
            return Ok(new QuietHoursEvaluateResponse(
                IsQuietHoursActive: false,
                TriageAction: "deliver_standard_notification",
                CrisisSeverity: "Normal",
                Reason: "Quiet hours currently inactive; standard notification rules apply.",
                BreakthroughAllowed: true,
                EvaluatedAt: now));
        }

        // Crisis detection rules
        var criticalTerms = new[]
        {
            "fraud", "halt", "downgrade", "liquidation", "emergency", "fatal",
            "investigation", "probe", "collapse", "court injunction", "hostile takeover",
            "insolvent", "evacuation", "strike notice", "cyberattack"
        };

        var text = $"{request.Title} {request.Summary}".ToLowerInvariant();
        var isCriticalKeywordMatch = criticalTerms.Any(term => text.Contains(term, StringComparison.OrdinalIgnoreCase));

        var shockThreshold = config.ShockThresholdPercent > 0 ? config.ShockThresholdPercent : 2.5m;
        var isMarketShock = request.PriceChangePercent.HasValue && Math.Abs(request.PriceChangePercent.Value) >= shockThreshold;

        var isVipEntityMatch = config.VipEntities.Any(vip =>
            !string.IsNullOrWhiteSpace(vip) &&
            (text.Contains(vip, StringComparison.OrdinalIgnoreCase) ||
             (request.Symbol != null && request.Symbol.Equals(vip, StringComparison.OrdinalIgnoreCase))));

        if (isMarketShock)
        {
            return Ok(new QuietHoursEvaluateResponse(
                IsQuietHoursActive: true,
                TriageAction: "break_through_crisis_alert",
                CrisisSeverity: "Crisis",
                Reason: $"Market shock of {request.PriceChangePercent:+0.00;-0.00}% exceeds VIP alert threshold (±{shockThreshold}%).",
                BreakthroughAllowed: true,
                EvaluatedAt: now));
        }

        if (isCriticalKeywordMatch && isVipEntityMatch)
        {
            return Ok(new QuietHoursEvaluateResponse(
                IsQuietHoursActive: true,
                TriageAction: "break_through_crisis_alert",
                CrisisSeverity: "Crisis",
                Reason: "Critical event matches monitored VIP entity watchlist.",
                BreakthroughAllowed: true,
                EvaluatedAt: now));
        }

        if (isCriticalKeywordMatch)
        {
            return Ok(new QuietHoursEvaluateResponse(
                IsQuietHoursActive: true,
                TriageAction: "break_through_crisis_alert",
                CrisisSeverity: "Urgent",
                Reason: "High-severity operational or regulatory crisis indicator detected.",
                BreakthroughAllowed: true,
                EvaluatedAt: now));
        }

        // Suppressed to morning briefing
        return Ok(new QuietHoursEvaluateResponse(
            IsQuietHoursActive: true,
            TriageAction: "suppress_to_morning_briefing",
            CrisisSeverity: "Normal",
            Reason: "Non-critical development batched for tomorrow morning's Executive Daily Briefing.",
            BreakthroughAllowed: false,
            EvaluatedAt: now));
    }

    private QuietHoursConfig GetCurrentConfigOrFallback()
    {
        var key = $"{DefaultConfigKeyPrefix}{CurrentUserId}";
        if (cache.TryGetValue(key, out QuietHoursConfig? config) && config != null)
        {
            return config;
        }

        return new QuietHoursConfig(
            Enabled: true,
            StartTime: "22:00",
            EndTime: "06:30",
            ActiveDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
            ShockThresholdPercent: 2.5m,
            VipEntities: ["RBNZ", "Treasury", "Fonterra", "Air New Zealand"],
            PushCrisisOnly: true);
    }

    private static bool IsTimeInQuietHours(DateTimeOffset now, QuietHoursConfig config)
    {
        if (!config.Enabled) return false;

        // Check active day
        var dayName = now.DayOfWeek.ToString();
        if (config.ActiveDays != null && config.ActiveDays.Length > 0 &&
            !config.ActiveDays.Contains(dayName, StringComparer.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!TimeSpan.TryParse(config.StartTime, out var start) ||
            !TimeSpan.TryParse(config.EndTime, out var end))
        {
            return false;
        }

        var current = now.TimeOfDay;
        if (start <= end)
        {
            return current >= start && current <= end;
        }
        else
        {
            // Overnight window, e.g. 22:00 to 06:30
            return current >= start || current <= end;
        }
    }
}
