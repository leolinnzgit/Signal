using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/daily-cast")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class DailyCastController : ControllerBase
{
    public sealed record CastArticleInput(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("summary")] string? Summary = null);

    public sealed record CastSynthesizeRequest(
        [property: JsonPropertyName("episodeTopic")] string? EpisodeTopic,
        [property: JsonPropertyName("articles")] CastArticleInput[]? Articles);

    public sealed record CastDialogTurn(
        [property: JsonPropertyName("turnIndex")] int TurnIndex,
        [property: JsonPropertyName("speaker")] string Speaker, // "david" | "sarah"
        [property: JsonPropertyName("speakerName")] string SpeakerName,
        [property: JsonPropertyName("speakerRole")] string SpeakerRole,
        [property: JsonPropertyName("avatarEmoji")] string AvatarEmoji,
        [property: JsonPropertyName("text")] string Text,
        [property: JsonPropertyName("durationSeconds")] double DurationSeconds);

    public sealed record CastChapter(
        [property: JsonPropertyName("timestampSeconds")] double TimestampSeconds,
        [property: JsonPropertyName("title")] string Title);

    public sealed record DailyCastResponse(
        [property: JsonPropertyName("episodeId")] string EpisodeId,
        [property: JsonPropertyName("episodeTitle")] string EpisodeTitle,
        [property: JsonPropertyName("showNotes")] string ShowNotes,
        [property: JsonPropertyName("totalDurationSeconds")] double TotalDurationSeconds,
        [property: JsonPropertyName("chapters")] CastChapter[] Chapters,
        [property: JsonPropertyName("dialogTurns")] CastDialogTurn[] DialogTurns,
        [property: JsonPropertyName("synthesizedAt")] DateTimeOffset SynthesizedAt);

    public sealed record CastPreset(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("category")] string Category,
        [property: JsonPropertyName("description")] string Description);

    private static readonly CastPreset[] DefaultPresets =
    [
        new(
            Id: "macro-divergence",
            Title: "The Macro Divergence: Rates, Spreads & Tech Capex",
            Category: "Macro & Markets",
            Description: "David and Sarah debate central bank rate cuts, Treasury curve steepening, and whether hyperscaler capex is compressing ROIC."
        ),
        new(
            Id: "chokepoints-nearshoring",
            Title: "Chokepoints & The Nearshoring Mirage",
            Category: "Geopolitics & Supply",
            Description: "A deep dive into Red Sea detour costs, USMCA rule-of-origin tariffs, and why moving manufacturing is harder than boardroom presentations suggest."
        ),
        new(
            Id: "silicon-sovereignty",
            Title: "Silicon Sovereignty & The Sub-2nm Race",
            Category: "Deep Tech & Security",
            Description: "High-NA EUV lithography tape-outs, cross-strait naval exercises, and sovereign AI compute clusters."
        )
    ];

    [HttpGet("episodes")]
    public IActionResult GetEpisodes()
    {
        return Ok(DefaultPresets);
    }

    [HttpPost("synthesize")]
    [IgnoreAntiforgeryToken]
    public IActionResult Synthesize([FromBody] CastSynthesizeRequest? request)
    {
        var topicId = request?.EpisodeTopic?.Trim().ToLowerInvariant() ?? "macro-divergence";
        var preset = DefaultPresets.FirstOrDefault(p => p.Id == topicId) ?? DefaultPresets[0];
        var articles = request?.Articles ?? [];

        var (turns, chapters) = topicId switch
        {
            "chokepoints-nearshoring" => BuildChokepointsTurns(articles),
            "silicon-sovereignty" => BuildSiliconTurns(articles),
            _ => BuildMacroTurns(articles)
        };

        var totalSeconds = turns.Sum(t => t.DurationSeconds);

        var showNotes = $"In this episode of Signal Daily Cast, David and Sarah break down '{preset.Title}'. They explore the operational realities behind breaking headlines, challenge conventional corporate consensus, and identify where executive leadership needs to hedge their exposure over the next 90 days.";

        var response = new DailyCastResponse(
            EpisodeId: preset.Id,
            EpisodeTitle: $"Signal Daily Cast: {preset.Title}",
            ShowNotes: showNotes,
            TotalDurationSeconds: totalSeconds,
            Chapters: chapters,
            DialogTurns: turns,
            SynthesizedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }

    private static (CastDialogTurn[], CastChapter[]) BuildMacroTurns(CastArticleInput[] articles)
    {
        var turns = new CastDialogTurn[]
        {
            new(1, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "Good morning and welcome to the Signal Daily Cast. I'm David Vance, here with Sarah Chen. Sarah, looking at the bond markets this morning, yields are pricing in a much slower easing cycle than tech equities seem to assume.", 10.5),
            new(2, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "That's right, David. While market equity multiples are hovering near 24 times forward earnings, the physical cost of capital is stubbornly anchored. If you look at hyperscaler earnings calls, capital expenditures are up 45% year-over-year, largely allocated to sovereign AI infrastructure.", 12.0),
            new(3, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "Which brings us back to the classic corporate question: where is the cash conversion? Building data centers is great for equipment suppliers, but enterprise CFOs are already scrutinizing software ROI.", 9.5),
            new(4, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "And here's the geopolitical wrinkle: it's not just an efficiency play. It's a sovereign containment race. Nations are mandating that localized compute stays within their borders under new data sovereignty laws.", 11.0),
            new(5, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "Bottom line for leadership this week: stress-test your debt refinancings at terminal rates above 4.5%, and don't assume equity markets will subsidize endless capex without dividend growth.", 10.0),
            new(6, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "Couldn't agree more. Lock in your energy supply contracts now, because kilowatt-hour costs are quickly becoming the new tier-one commodity bottleneck. Until tomorrow, stay sharp.", 9.5)
        };

        var chapters = new CastChapter[]
        {
            new(0.0, "Introduction & Yield Curve Realities"),
            new(22.5, "Hyperscaler Capex vs Cash Conversion"),
            new(43.0, "Sovereign Compute & Regulatory Walls"),
            new(54.0, "Executive Takeaways & Energy Sourcing")
        };

        return (turns, chapters);
    }

    private static (CastDialogTurn[], CastChapter[]) BuildChokepointsTurns(CastArticleInput[] articles)
    {
        var turns = new CastDialogTurn[]
        {
            new(1, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "Welcome to Signal Daily Cast. I'm Sarah Chen with David Vance. Today we're diving into maritime logistics. David, 65% of container traffic remains diverted around the Cape of Good Hope, and the freight surcharges are getting baked into retail shelves.", 11.0),
            new(2, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "It's fascinating, Sarah. Everyone in the boardroom talked about 'nearshoring to Mexico' as an instant silver bullet. But if your raw cathode powder or precision tooling still has to cross the Pacific, you haven't eliminated the bottleneck; you've just moved it.", 12.5),
            new(3, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "Exactly. In Monterrey and Querétaro, industrial park vacancy is under 2%, and local water and electrical hookups have 18-month lead times. You can't just flip a switch and replace Shenzhen overnight.", 10.5),
            new(4, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "So what does an executive do? You dual-source, and you hold 45 days of safety stock rather than just-in-time inventory. Yes, working capital goes up, but a halted assembly line costs 10 times more.", 11.0),
            new(5, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "And audit your tier-two suppliers! Most companies know their direct vendor, but they have zero visibility into where their vendor buys raw minerals. That's where the real vulnerability hides.", 10.0)
        };

        var chapters = new CastChapter[]
        {
            new(0.0, "The 12-Day Cape Detour Penalty"),
            new(23.5, "The Nearshoring Reality Check"),
            new(44.5, "Working Capital vs Line Shutdowns")
        };

        return (turns, chapters);
    }

    private static (CastDialogTurn[], CastChapter[]) BuildSiliconTurns(CastArticleInput[] articles)
    {
        var turns = new CastDialogTurn[]
        {
            new(1, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "Welcome back to Signal Daily Cast. David Vance here with Sarah Chen. Sarah, ASML and TSMC just completed their preliminary sub-2nm High-NA trial runs. The capital expenditure is staggering: each machine costs upwards of $380 million.", 12.0),
            new(2, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "It is a monumental technological feat, David. But it also concentrates 90% of global cutting-edge fabrication into a handful of square miles in Hsinchu and Tainan. If cross-strait airspace shuts down for even 48 hours, global tech halts.", 12.5),
            new(3, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "That's why Western governments are pouring tens of billions into domestic fabs in Arizona, Ohio, and Dresden. But training cleanroom technicians and establishing chemical supply chains is proving to be a multi-year slog.", 11.0),
            new(4, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "The lesson for enterprise boards: if your products depend on sub-7nm wafers, secure guaranteed packaging allocations 18 months in advance. The capacity queue isn't getting any shorter.", 10.5)
        };

        var chapters = new CastChapter[]
        {
            new(0.0, "High-NA EUV Machine Economics"),
            new(24.5, "Geographic Concentration Risk"),
            new(35.5, "Securing 18-Month Packaging Allocations")
        };

        return (turns, chapters);
    }
}
