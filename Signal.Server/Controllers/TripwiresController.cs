using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/tripwires")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class TripwiresController(
    SignalDbContext database,
    ILogger<TripwiresController>? logger = null) : ControllerBase
{
    public sealed record TripwireDto(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("keywords")] string[] Keywords,
        [property: JsonPropertyName("targetSuiteId")] string TargetSuiteId,
        [property: JsonPropertyName("targetEntityId")] string TargetEntityId,
        [property: JsonPropertyName("severity")] string Severity,
        [property: JsonPropertyName("enabled")] bool Enabled,
        [property: JsonPropertyName("pushOnMatch")] bool PushOnMatch,
        [property: JsonPropertyName("triggerCount")] int TriggerCount,
        [property: JsonPropertyName("lastTriggeredAtUtc")] DateTime? LastTriggeredAtUtc,
        [property: JsonPropertyName("lastMatchedTitle")] string LastMatchedTitle,
        [property: JsonPropertyName("lastMatchedUrl")] string LastMatchedUrl,
        [property: JsonPropertyName("deepLinkUrl")] string DeepLinkUrl);

    public sealed record TripwireUpsertRequest(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("keywords")] string[]? Keywords,
        [property: JsonPropertyName("targetSuiteId")] string? TargetSuiteId,
        [property: JsonPropertyName("targetEntityId")] string? TargetEntityId,
        [property: JsonPropertyName("severity")] string? Severity,
        [property: JsonPropertyName("enabled")] bool? Enabled,
        [property: JsonPropertyName("pushOnMatch")] bool? PushOnMatch);

    public sealed record TripwireEvalArticleInput(
        [property: JsonPropertyName("title")] string? Title,
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("source")] string? Source,
        [property: JsonPropertyName("summary")] string? Summary = null,
        [property: JsonPropertyName("topics")] string[]? Topics = null);

    public sealed record TripwireRuleInput(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("keywords")] string[]? Keywords,
        [property: JsonPropertyName("targetSuiteId")] string? TargetSuiteId,
        [property: JsonPropertyName("targetEntityId")] string? TargetEntityId,
        [property: JsonPropertyName("severity")] string? Severity,
        [property: JsonPropertyName("enabled")] bool Enabled = true);

    public sealed record TripwireEvaluateRequest(
        [property: JsonPropertyName("articles")] TripwireEvalArticleInput[]? Articles,
        [property: JsonPropertyName("rules")] TripwireRuleInput[]? Rules);

    public sealed record TripwiresStateResponse(
        [property: JsonPropertyName("authenticated")] bool Authenticated,
        [property: JsonPropertyName("tripwires")] TripwireDto[] Tripwires,
        [property: JsonPropertyName("presets")] TripwireDto[] Presets);

    private static readonly TripwireDto[] PresetTemplates =
    [
        new(
            Id: "preset-red-sea-chokepoint",
            Name: "Red Sea & Hormuz Transit Disruption",
            Keywords: ["red sea", "hormuz", "bab el-mandeb", "cape of good hope", "suez", "reroute"],
            TargetSuiteId: "geopolitical-transit",
            TargetEntityId: "red-sea",
            Severity: "Critical",
            Enabled: true,
            PushOnMatch: true,
            TriggerCount: 0,
            LastTriggeredAtUtc: null,
            LastMatchedTitle: "",
            LastMatchedUrl: "",
            DeepLinkUrl: "/?suite=geopolitical-transit&focus=red-sea"
        ),
        new(
            Id: "preset-sovereign-argentina-egp",
            Name: "EM Sovereign Debt & FX Controls Shock",
            Keywords: ["argentina", "cepo", "peso", "egypt", "pound", "imf bailout", "sovereign default", "devaluation"],
            TargetSuiteId: "sovereign-risk",
            TargetEntityId: "argentina",
            Severity: "High",
            Enabled: true,
            PushOnMatch: true,
            TriggerCount: 0,
            LastTriggeredAtUtc: null,
            LastMatchedTitle: "",
            LastMatchedUrl: "",
            DeepLinkUrl: "/?suite=sovereign-risk&focus=argentina"
        ),
        new(
            Id: "preset-premortem-ai-compliance",
            Name: "Pre-Mortem EWI: AI Regulatory Injunction",
            Keywords: ["eu ai act", "ai liability", "algorithmic injunction", "model audit", "ftc inquiry", "antitrust"],
            TargetSuiteId: "pre-mortem",
            TargetEntityId: "ai-cloud-migration",
            Severity: "High",
            Enabled: true,
            PushOnMatch: true,
            TriggerCount: 0,
            LastTriggeredAtUtc: null,
            LastMatchedTitle: "",
            LastMatchedUrl: "",
            DeepLinkUrl: "/?suite=pre-mortem&focus=ai-cloud-migration"
        ),
        new(
            Id: "preset-tariff-silicon-export",
            Name: "Section 301 & Semiconductor Tariff Shock",
            Keywords: ["section 301", "tariff", "bis export", "asml", "euv", "tsmc", "rare earth", "gallium"],
            TargetSuiteId: "tariff-matrix",
            TargetEntityId: "semiconductors",
            Severity: "Critical",
            Enabled: true,
            PushOnMatch: true,
            TriggerCount: 0,
            LastTriggeredAtUtc: null,
            LastMatchedTitle: "",
            LastMatchedUrl: "",
            DeepLinkUrl: "/?suite=tariff-matrix&focus=semiconductors"
        ),
        new(
            Id: "preset-cyber-edge-zeroday",
            Name: "CISA Zero-Day & Ransomware Infrastructure Alert",
            Keywords: ["zero-day", "cisa", "kev", "ransomware", "cve-2026", "edge gateway", "wiper"],
            TargetSuiteId: "cyber-incident",
            TargetEntityId: "edge-infrastructure",
            Severity: "Critical",
            Enabled: true,
            PushOnMatch: true,
            TriggerCount: 0,
            LastTriggeredAtUtc: null,
            LastMatchedTitle: "",
            LastMatchedUrl: "",
            DeepLinkUrl: "/?suite=cyber-incident&focus=edge-infrastructure"
        )
    ];

    private string? CurrentUserId => User?.FindFirstValue(ClaimTypes.NameIdentifier);

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId))
        {
            return Ok(new TripwiresStateResponse(false, [], PresetTemplates));
        }

        var rows = await database.ExecutiveTripwires
            .AsNoTracking()
            .Where(t => t.UserId == userId)
            .OrderByDescending(t => t.CreatedAtUtc)
            .ToArrayAsync(cancellationToken);

        return Ok(new TripwiresStateResponse(true, rows.Select(ToDto).ToArray(), PresetTemplates));
    }

    [HttpPost]
    [Authorize]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> Upsert(
        [FromBody] TripwireUpsertRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var name = (request?.Name ?? "").Trim();
        if (name.Length < 2 || name.Length > 160)
            return BadRequest(new { error = "Tripwire name must be between 2 and 160 characters." });

        var keywords = (request?.Keywords ?? [])
            .Select(k => (k ?? "").Trim())
            .Where(k => k.Length is >= 2 and <= 60)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(12)
            .ToArray();

        if (keywords.Length == 0)
            return BadRequest(new { error = "Add at least one monitoring keyword (2-60 characters)." });

        var targetSuiteId = SanitizeId(request?.TargetSuiteId, "radar", 80);
        var targetEntityId = SanitizeId(request?.TargetEntityId, "", 120);
        var severity = NormalizeSeverity(request?.Severity);

        var id = string.IsNullOrWhiteSpace(request?.Id) ? $"tw-{Guid.NewGuid():N}" : SanitizeId(request.Id, "", 64);
        var existing = id.Length > 0
            ? await database.ExecutiveTripwires.SingleOrDefaultAsync(t => t.Id == id && t.UserId == userId, cancellationToken)
            : null;

        if (existing is null)
        {
            var count = await database.ExecutiveTripwires.CountAsync(t => t.UserId == userId, cancellationToken);
            if (count >= 25)
                return BadRequest(new { error = "Maximum of 25 executive tripwires allowed per account." });

            existing = new ExecutiveTripwire
            {
                Id = id.Length > 0 ? id : $"tw-{Guid.NewGuid():N}",
                UserId = userId,
                CreatedAtUtc = DateTime.UtcNow
            };
            database.ExecutiveTripwires.Add(existing);
        }

        existing.Name = name;
        existing.KeywordsJson = JsonSerializer.Serialize(keywords);
        existing.TargetSuiteId = targetSuiteId;
        existing.TargetEntityId = targetEntityId;
        existing.Severity = severity;
        existing.Enabled = request?.Enabled ?? true;
        existing.PushOnMatch = request?.PushOnMatch ?? true;

        await database.SaveChangesAsync(cancellationToken);
        logger?.LogInformation("Saved executive tripwire {TripwireId} ({Name}) for user {UserId}.", existing.Id, existing.Name, userId);

        return Ok(ToDto(existing));
    }

    [HttpDelete("{id}")]
    [Authorize]
    public async Task<IActionResult> Delete(string id, CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var sanitizedId = SanitizeId(id, "", 64);
        if (sanitizedId.Length == 0) return BadRequest(new { error = "Invalid tripwire ID." });

        var existing = await database.ExecutiveTripwires
            .SingleOrDefaultAsync(t => t.Id == sanitizedId && t.UserId == userId, cancellationToken);
        if (existing is null) return NotFound();

        database.ExecutiveTripwires.Remove(existing);
        await database.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    [HttpPost("evaluate")]
    [IgnoreAntiforgeryToken]
    [RequestSizeLimit(128_000)]
    public async Task<IActionResult> Evaluate(
        [FromBody] TripwireEvaluateRequest? request,
        CancellationToken cancellationToken)
    {
        var candidates = new List<TripwireEvaluatorService.TripwireCandidateArticle>();
        if (request?.Articles is { Length: > 0 })
        {
            foreach (var item in request.Articles.Take(120))
            {
                if (string.IsNullOrWhiteSpace(item.Title)) continue;
                candidates.Add(new TripwireEvaluatorService.TripwireCandidateArticle(
                    item.Title,
                    item.Url ?? "",
                    item.Source ?? "Wire",
                    item.Summary ?? "",
                    item.Topics));
            }
        }

        var userId = CurrentUserId;
        if (candidates.Count == 0 && !string.IsNullOrEmpty(userId))
        {
            var stored = await database.StoredNewsArticles
                .AsNoTracking()
                .Where(a => a.UserId == userId)
                .OrderByDescending(a => a.LastSeenAtUtc)
                .Take(80)
                .ToArrayAsync(cancellationToken);

            foreach (var s in stored)
            {
                candidates.Add(new TripwireEvaluatorService.TripwireCandidateArticle(
                    s.Title,
                    s.Url,
                    s.Source,
                    s.Summary));
            }
        }

        var rulesToEvaluate = new List<(string Id, string Name, string[] Keywords, string Severity, string SuiteId, string EntityId)>();
        if (request?.Rules is { Length: > 0 })
        {
            foreach (var rule in request.Rules.Where(r => r.Enabled).Take(30))
            {
                var kws = (rule.Keywords ?? []).Where(k => !string.IsNullOrWhiteSpace(k)).Select(k => k.Trim()).ToArray();
                if (kws.Length == 0) continue;
                rulesToEvaluate.Add((
                    rule.Id ?? "custom",
                    rule.Name ?? "Custom Tripwire",
                    kws,
                    NormalizeSeverity(rule.Severity),
                    SanitizeId(rule.TargetSuiteId, "radar", 80),
                    SanitizeId(rule.TargetEntityId, "", 120)));
            }
        }
        else if (!string.IsNullOrEmpty(userId))
        {
            var saved = await database.ExecutiveTripwires
                .AsNoTracking()
                .Where(t => t.UserId == userId && t.Enabled)
                .ToArrayAsync(cancellationToken);

            foreach (var s in saved)
            {
                rulesToEvaluate.Add((
                    s.Id,
                    s.Name,
                    TripwireEvaluatorService.ParseKeywords(s.KeywordsJson),
                    s.Severity,
                    s.TargetSuiteId,
                    s.TargetEntityId));
            }
        }

        if (rulesToEvaluate.Count == 0)
        {
            foreach (var preset in PresetTemplates)
            {
                rulesToEvaluate.Add((preset.Id, preset.Name, preset.Keywords, preset.Severity, preset.TargetSuiteId, preset.TargetEntityId));
            }
        }

        var matches = new List<TripwireEvaluatorService.TripwireMatchResult>();
        foreach (var rule in rulesToEvaluate)
        {
            var hit = TripwireEvaluatorService.MatchArticleSet(
                rule.Id,
                rule.Name,
                rule.Keywords,
                rule.Severity,
                rule.SuiteId,
                rule.EntityId,
                candidates);
            if (hit is not null) matches.Add(hit);
        }

        return Ok(new
        {
            evaluatedArticles = candidates.Count,
            evaluatedRules = rulesToEvaluate.Count,
            matches,
            evaluatedAt = DateTimeOffset.UtcNow
        });
    }

    private static TripwireDto ToDto(ExecutiveTripwire entity) => new(
        Id: entity.Id,
        Name: entity.Name,
        Keywords: TripwireEvaluatorService.ParseKeywords(entity.KeywordsJson),
        TargetSuiteId: entity.TargetSuiteId,
        TargetEntityId: entity.TargetEntityId,
        Severity: entity.Severity,
        Enabled: entity.Enabled,
        PushOnMatch: entity.PushOnMatch,
        TriggerCount: entity.TriggerCount,
        LastTriggeredAtUtc: entity.LastTriggeredAtUtc,
        LastMatchedTitle: entity.LastMatchedTitle,
        LastMatchedUrl: entity.LastMatchedUrl,
        DeepLinkUrl: TripwireEvaluatorService.BuildDeepLinkUrl(entity.TargetSuiteId, entity.TargetEntityId));

    private static string NormalizeSeverity(string? severity) => (severity ?? "").Trim().ToLowerInvariant() switch
    {
        "critical" => "Critical",
        "elevated" => "Elevated",
        _ => "High"
    };

    private static string SanitizeId(string? value, string fallback, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        var clean = new string(value.Trim().Where(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.').ToArray());
        if (clean.Length == 0) return fallback;
        return clean.Length <= maxLen ? clean : clean[..maxLen];
    }
}
