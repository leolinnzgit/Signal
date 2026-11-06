using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/board-sparring")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class BoardSparringController : ControllerBase
{
    public sealed record SparringPersona(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("organization")] string Organization,
        [property: JsonPropertyName("avatarEmoji")] string AvatarEmoji,
        [property: JsonPropertyName("archetype")] string Archetype, // "Activist Investor" | "Hostile Regulator" | "Short Seller" | "Labor Lead" | "Sovereign Co-Investor"
        [property: JsonPropertyName("pressurePoints")] string[] PressurePoints,
        [property: JsonPropertyName("openingStatement")] string OpeningStatement);

    public sealed record DialogTurn(
        [property: JsonPropertyName("sender")] string Sender, // "user" | "adversary"
        [property: JsonPropertyName("text")] string Text);

    public sealed record SparringRequest(
        [property: JsonPropertyName("personaId")] string? PersonaId,
        [property: JsonPropertyName("userMessage")] string? UserMessage,
        [property: JsonPropertyName("dialogHistory")] DialogTurn[]? DialogHistory);

    public sealed record PostureTelemetry(
        [property: JsonPropertyName("leverage")] int Leverage,             // 0 (no leverage) - 100 (dominant)
        [property: JsonPropertyName("credibility")] int Credibility,       // 0 (unsubstantiated) - 100 (rock-solid)
        [property: JsonPropertyName("defensiveness")] int Defensiveness,   // 0 (calm & centered) - 100 (panicked/reactive)
        [property: JsonPropertyName("concessionVelocity")] int ConcessionVelocity); // 0 (yielding nothing) - 100 (bleeding ground)

    public sealed record SparringResponse(
        [property: JsonPropertyName("personaId")] string PersonaId,
        [property: JsonPropertyName("adversaryReply")] string AdversaryReply,
        [property: JsonPropertyName("posture")] PostureTelemetry Posture,
        [property: JsonPropertyName("trapsDetected")] string[] TrapsDetected,
        [property: JsonPropertyName("recommendedPivot")] string RecommendedPivot);

    public sealed record ScorecardRequest(
        [property: JsonPropertyName("personaId")] string? PersonaId,
        [property: JsonPropertyName("dialogHistory")] DialogTurn[]? DialogHistory);

    public sealed record SparringScorecard(
        [property: JsonPropertyName("personaId")] string PersonaId,
        [property: JsonPropertyName("overallGrade")] string OverallGrade, // "A+" | "A" | "B+" | "B" | "C" | "Needs Drill"
        [property: JsonPropertyName("executiveReadinessScore")] int ExecutiveReadinessScore, // 0 - 100
        [property: JsonPropertyName("strengths")] string[] Strengths,
        [property: JsonPropertyName("vulnerabilities")] string[] Vulnerabilities,
        [property: JsonPropertyName("tacticalRecommendations")] string[] TacticalRecommendations);

    private static readonly SparringPersona[] DefaultPersonas =
    [
        new(
            Id: "carl-vance",
            Name: "Carl Vance",
            Title: "Managing Partner & Founder",
            Organization: "Ironcrest Capital (Activist Fund)",
            AvatarEmoji: "🦈",
            Archetype: "Activist Investor",
            PressurePoints: ["Capital allocation decay", "EBITDA margin lag vs peer group", "Board seat demands", "Demerger/spin-off of non-core assets"],
            OpeningStatement: "Let's be direct: your SG&A has expanded 420 bps faster than revenue for three consecutive quarters, while your peers trade at a 3.5x premium. You have 60 seconds to explain why we shouldn't initiate a proxy contest for three board seats at the next AGM."
        ),
        new(
            Id: "elena-rostova",
            Name: "Dr. Elena Rostova",
            Title: "Commissioner for Competition & Markets",
            Organization: "European Regulatory Authority",
            AvatarEmoji: "⚖️",
            Archetype: "Hostile Regulator",
            PressurePoints: ["Market gatekeeper status", "Ecosystem bundling", "Data exclusivity", "Penalties up to 10% of global turnover"],
            OpeningStatement: "Your recent platform updates effectively foreclose third-party interoperability while steering 82% of enterprise traffic into your proprietary stack. Under Article 102, this exhibits prima facie exclusionary abuse. On what statutory basis do you defend this conduct?"
        ),
        new(
            Id: "marcus-sterling",
            Name: "Marcus Sterling",
            Title: "Chief Investment Officer",
            Organization: "Apex Forensic Research (Short-Seller)",
            AvatarEmoji: "📉",
            Archetype: "Short Seller",
            PressurePoints: ["Deferred revenue irregularities", "Customer churn obfuscation", "Working capital burn", "Off-balance sheet guarantees"],
            OpeningStatement: "We just published a 74-page forensic report showing your unbilled receivables surged 38% while enterprise renewal duration plummeted. It looks like you're pulling forward next quarter's bookings to disguise an organic growth stall. Care to refute line 41?"
        ),
        new(
            Id: "sarah-jenkins",
            Name: "Sarah Jenkins",
            Title: "General Secretary",
            Organization: "Federated Industrial & Tech Council",
            AvatarEmoji: "📢",
            Archetype: "Labor Lead",
            PressurePoints: ["Automation redundancies", "Real wage erosion", "Executive bonus optics", "Strike mandate authorization"],
            OpeningStatement: "While the C-suite approved a $45M share buyback and 30% bonus uplifts, your regional operating centers are facing a mandatory 15% headcount reduction disguised as 'efficiency realignment'. 91% of our membership has already authorized strike action. What is your counteroffer?"
        ),
        new(
            Id: "david-chen",
            Name: "David Chen",
            Title: "Head of Global Direct Investments",
            Organization: "Sovereign Strategic Holdings",
            AvatarEmoji: "🏛️",
            Archetype: "Sovereign Co-Investor",
            PressurePoints: ["Cross-border geopolitical friction", "Sanction exposure", "Veto rights on strategic pivoting", "Capital lockup terms"],
            OpeningStatement: "Our sovereign commitment is grounded in long-term geopolitical neutrality and capital preservation. Your latest regional expansion risks triggering secondary sanctions in key export jurisdictions. If you cannot provide indemnified ring-fencing, we will exercise our step-in veto rights immediately."
        )
    ];

    [HttpGet("personas")]
    public IActionResult GetPersonas()
    {
        return Ok(DefaultPersonas);
    }

    [HttpPost("spar")]
    [IgnoreAntiforgeryToken]
    public IActionResult Spar([FromBody] SparringRequest? request)
    {
        var personaId = request?.PersonaId?.Trim().ToLowerInvariant() ?? "carl-vance";
        var persona = DefaultPersonas.FirstOrDefault(p => p.Id == personaId) ?? DefaultPersonas[0];
        var text = request?.UserMessage?.Trim() ?? "";

        if (string.IsNullOrWhiteSpace(text))
        {
            return BadRequest(new { error = "User message cannot be empty." });
        }

        // Analyze user sentiment and traps
        var traps = new List<string>();
        var leverage = 50;
        var credibility = 65;
        var defensiveness = 30;
        var concessionVelocity = 20;

        var lower = text.ToLowerInvariant();

        // Trap 1: Apologetic / Submissive language
        if (lower.Contains("sorry") || lower.Contains("apologize") || lower.Contains("regret") || lower.Contains("mistake"))
        {
            traps.Add("Apologetic phrasing: Conceded moral/operational ground before establishing baseline facts.");
            leverage -= 18;
            defensiveness += 25;
            concessionVelocity += 35;
        }

        // Trap 2: Vague future promises without data
        if (lower.Contains("hopefully") || lower.Contains("we believe") || lower.Contains("soon") || lower.Contains("in the future"))
        {
            traps.Add("Speculative commitment: Relied on soft aspirations rather than audited metrics or hard operational deliverables.");
            credibility -= 15;
            leverage -= 10;
        }

        // Positive signal: Hard data or metric cited
        if (Regex.IsMatch(text, @"\b(\d+[\.\d]*%|\$\d+[\.\d]*[BMKbmk]?|\d+\s*(bps|basis points|months|quarters))\b"))
        {
            credibility += 20;
            leverage += 12;
        }

        // Trap 3: Aggressive / dismissive denial
        if (lower.Contains("nonsense") || lower.Contains("ridiculous") || lower.Contains("lie") || lower.Contains("fake"))
        {
            traps.Add("Emotional escalation: Attacked the questioner rather than neutralizing the premise with evidence.");
            defensiveness += 35;
            leverage -= 15;
        }

        // Keep bounds 5 - 95
        leverage = Math.Clamp(leverage, 8, 95);
        credibility = Math.Clamp(credibility, 10, 95);
        defensiveness = Math.Clamp(defensiveness, 5, 95);
        concessionVelocity = Math.Clamp(concessionVelocity, 5, 95);

        // Generate tailored adversarial rebuttal
        var (reply, pivot) = GeneratePersonaRebuttal(persona, text, leverage, defensiveness);

        var response = new SparringResponse(
            PersonaId: persona.Id,
            AdversaryReply: reply,
            Posture: new PostureTelemetry(leverage, credibility, defensiveness, concessionVelocity),
            TrapsDetected: traps.ToArray(),
            RecommendedPivot: pivot);

        return Ok(response);
    }

    [HttpPost("scorecard")]
    [IgnoreAntiforgeryToken]
    public IActionResult GenerateScorecard([FromBody] ScorecardRequest? request)
    {
        var personaId = request?.PersonaId?.Trim().ToLowerInvariant() ?? "carl-vance";
        var turns = request?.DialogHistory ?? [];

        var userTurnsCount = turns.Count(t => t.Sender.Equals("user", StringComparison.OrdinalIgnoreCase));
        var score = Math.Min(95, 60 + (userTurnsCount * 6));

        string grade = score switch
        {
            >= 90 => "A",
            >= 80 => "B+",
            >= 70 => "B",
            >= 60 => "C+",
            _ => "Needs Drill"
        };

        var scorecard = new SparringScorecard(
            PersonaId: personaId,
            OverallGrade: grade,
            ExecutiveReadinessScore: score,
            Strengths: [
                "Maintained steady executive cadence across rapid-fire counter-questions.",
                "Reinforced long-term strategic moats and governance boundaries.",
                "Prevented uncalculated off-the-cuff financial commitments."
            ],
            Vulnerabilities: [
                "Allowed adversary to dictate the agenda on margin compression.",
                "Could introduce counter-leverage earlier by querying their alternative scenario viability."
            ],
            TacticalRecommendations: [
                "Open future confrontations with audited comparative peer data.",
                "Pivot from defensive explanations to proactive capital efficiency milestones.",
                "Pre-commit to an independent review committee to disarm proxy momentum."
            ]);

        return Ok(scorecard);
    }

    private static (string Reply, string Pivot) GeneratePersonaRebuttal(
        SparringPersona persona,
        string userText,
        int leverage,
        int defensiveness)
    {
        return persona.Id switch
        {
            "carl-vance" => (
                defensiveness > 50
                    ? "That sounds like rationalization from an entrenched leadership team. Our models show a pure-play spin-off unlocks $1.2B in shareholder value tomorrow. If you can't beat our hurdle rate, why shouldn't the board let our nominees execute it?"
                    : "You point to strategic reinvestment, but the market isn't buying the payback horizon. Give me one verifiable operational milestone by Q3 that proves your capital expenditure isn't destroying ROIC.",
                "Pivot: 'Carl, our ROIC hurdle is 18%, verified by independent audit. Let's look at the actual cash generation of the consolidated platform before proposing value-destructive breakups.'"
            ),
            "elena-rostova" => (
                leverage < 40
                    ? "Your submission does not address the core foreclosure mechanism. By pre-installing your telemetry and restricting standard API handoffs, you impose switching costs that stifle market innovation. We require structural commitments, not verbal comfort."
                    : "Even if your compliance framework meets baseline standards, our preliminary market testing indicates systemic lock-in for enterprise purchasers. What technical guarantees will you offer for impartial third-party interoperability?",
                "Pivot: 'Commissioner, our APIs operate on open ISO standards with over 4,000 active third-party integrations. We are prepared to submit our interoperability metrics to the Directorate tomorrow.'"
            ),
            "marcus-sterling" => (
                defensiveness > 50
                    ? "If everything is above board, why did two senior controllers resign in the last four months? The optics are terrible, and your DSO trajectory is a classic red flag. The market is pricing in restatements."
                    : "You claim cash conversion will normalize by year-end, but your channel partners report elevated inventory stacks. Who is carrying the financing burden if consumer demand slows another 5%?",
                "Pivot: 'Marcus, our DSO is within our historical 42-day window, and 94% of receivables are investment-grade verified. Our audit committee just reaffirmed our unqualified opinion.'"
            ),
            "sarah-jenkins" => (
                leverage < 50
                    ? "Warm words about 'workforce transition' don't pay mortgages. If your executive incentives are tied to automation KPIs while frontline workers bear the cost of redundancies, we will shut down operations across all three distribution centers next week."
                    : "We acknowledge the technology shift is inevitable, but workforce retraining cannot be unfunded lip service. Will the board commit 5% of the automation savings directly into guaranteed redeployment packages?",
                "Pivot: 'Sarah, no team member will be phased out without a fully funded 12-month reskilling pathway and guaranteed internal transfer priority. Let's review the redeployment pact together.'"
            ),
            _ => (
                "Your reassurance is noted, but our sovereign fund mandate allows zero ambiguity on jurisdictional compliance. We need formal, binding covenants that no capital is exposed to cross-border sanction vectors.",
                "Pivot: 'David, our legal structure completely ring-fences APAC assets into an independent trust with sovereign observer seats. Your risk exposure remains entirely insulated.'"
            )
        };
    }
}
