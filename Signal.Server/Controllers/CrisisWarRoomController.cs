using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/crisis-war-room")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class CrisisWarRoomController(
    IMemoryCache cache,
    ILogger<CrisisWarRoomController>? logger = null) : ControllerBase
{
    public sealed record ArticleItem(
        string Title,
        string Source,
        string Url,
        DateTimeOffset? PublishedAt = null,
        string? Summary = null);

    public sealed record CrisisWarRoomRequest(
        string? IncidentTitle = null,
        string? Severity = null,
        string? AffectedEntity = null,
        ArticleItem[]? Articles = null);

    public sealed record CrisisTimelineMilestone(
        string Timestamp,
        string Milestone,
        string Source,
        string SeverityDelta);

    public sealed record StakeholderImpact(
        string Group,
        string ExposureLevel,
        string ImmediateRisk,
        string MitigationAction);

    public sealed record CrisisHoldingStatement(
        string Audience,
        string Statement,
        string GuidanceTone);

    public sealed record HostileQuestion(
        string Question,
        string SuggestedResponse,
        string LandminesToAvoid);

    public sealed record CrisisWarRoomResponse(
        bool Available,
        string IncidentId,
        string IncidentTitle,
        string AffectedEntity,
        string SeverityLevel,
        string ContainmentStatus,
        CrisisTimelineMilestone[] Timeline,
        StakeholderImpact[] StakeholderImpacts,
        CrisisHoldingStatement[] HoldingStatements,
        HostileQuestion[] AnticipatedQuestions,
        string UrgentSituationScript,
        DateTimeOffset ActivatedAt);

    [HttpPost("activate")]
    public IActionResult Activate([FromBody] CrisisWarRoomRequest? request)
    {
        var title = string.IsNullOrWhiteSpace(request?.IncidentTitle)
            ? "Critical Infrastructure Supply Chain Disruption"
            : request.IncidentTitle.Trim();
        var entity = string.IsNullOrWhiteSpace(request?.AffectedEntity)
            ? "Primary Regional Operations"
            : request.AffectedEntity.Trim();
        var severity = string.IsNullOrWhiteSpace(request?.Severity) ? "High" : request.Severity.Trim();

        var incidentId = $"crisis-{Guid.NewGuid():N}"[..15];
        var articles = (request?.Articles ?? []).Where(a => !string.IsNullOrWhiteSpace(a.Title)).ToArray();

        var timeline = new CrisisTimelineMilestone[]
        {
            new("T - 4 hours", $"{entity} telemetry detects cascading routing anomalies across primary distribution channels.", "Operations Center", "+2 Critical"),
            new("T - 2 hours", "National broadcast wires pick up early customer complaints and service failure rumors.", "Signal Wire Monitor", "+1 Escalating"),
            new("T - 45 mins", "Regulator issues formal request for information regarding compliance breach and failover plans.", "Regulatory Desk", "Holding"),
            new("Current Status", "Crisis response team mobilized; executive incident command standing by for media statements.", "Executive Command", "Stabilizing")
        };

        var impacts = new StakeholderImpact[]
        {
            new("Customers / Clients", "High", "Service outage or fulfillment delay sparking public churn and reputation damage.", "Provide proactive status transparency, dedicated hotline, and rapid service-credit assurance."),
            new("Shareholders & Board", "Elevated", "Negative headline drift and volatility in asset valuation.", "Deliver confidential director brief before next market session open."),
            new("Regulators & Watchdogs", "High", "Fines for statutory reporting non-compliance or breach of service standards.", "Submit preliminary notification within the statutory 72-hour disclosure window."),
            new("Staff & Frontline Teams", "Medium", "Operational burnout and inconsistent public communications.", "Issue single-source internal briefing talking points and enforce social media silence.")
        };

        var holdingStatements = new CrisisHoldingStatement[]
        {
            new("Media & Public",
                $"\"{entity} is actively managing an operational disruption affecting select services. Our engineering and incident command teams mobilized immediately, and root-cause mitigation is well underway. We apologize for the inconvenience and will provide verified updates via our incident center at 30-minute intervals.\"",
                "Calm, accountable, fact-anchored"),
            new("Regulators & Statutory Bodies",
                $"\"We have activated our formal incident management plan and are preparing a comprehensive briefing paper covering timelines, impacted nodes, and containment steps for regulatory review.\"",
                "Transparent, compliant, proactive"),
            new("Internal Staff",
                $"\"Team, our sole focus is swift restoration and exceptional customer empathy. Please direct all media inquiries without comment to the executive media desk.\"",
                "Decisive, protective, unifying")
        };

        var questions = new HostileQuestion[]
        {
            new("Was this incident foreseeable, and did executive leadership ignore previous audit warnings?",
                "\"Our focus today is 100% on restoration and customer safety. We conduct regular audits and will thoroughly investigate the exact triggers as soon as full operational integrity is verified.\"",
                "Do not speculate on past audits or assign individual blame before post-incident review."),
            new("Will affected customers receive financial compensation for commercial losses?",
                "\"We are prioritizing full recovery first. We will review customer impacts individually in accordance with our service level commitments.\"",
                "Avoid promising blanket payouts or denying liability prematurely on record.")
        };

        var script = $"Incident command alert for {entity}. Severity is rated {severity}. Containment status is active response. Key immediate risk centers on customer service disruption and regulatory disclosure deadlines. All teams must adhere strictly to verified holding statements. Next executive update in 30 minutes.";

        var response = new CrisisWarRoomResponse(
            Available: true,
            IncidentId: incidentId,
            IncidentTitle: title,
            AffectedEntity: entity,
            SeverityLevel: severity,
            ContainmentStatus: "Active Response",
            Timeline: timeline,
            StakeholderImpacts: impacts,
            HoldingStatements: holdingStatements,
            AnticipatedQuestions: questions,
            UrgentSituationScript: script,
            ActivatedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }
}
