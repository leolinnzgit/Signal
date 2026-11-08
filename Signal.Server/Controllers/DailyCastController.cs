using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/daily-cast")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class DailyCastController(
    AzureSpeechAudioRenderer? speechRenderer = null,
    SignalDbContext? database = null,
    MarketDataService? marketData = null,
    ILogger<DailyCastController>? logger = null) : ControllerBase
{
    public sealed record CastArticleInput(
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("summary")] string? Summary = null);

    public sealed record CastSynthesizeRequest(
        [property: JsonPropertyName("episodeTopic")] string? EpisodeTopic,
        [property: JsonPropertyName("articles")] CastArticleInput[]? Articles);

    public sealed record CastAudioTurnInput(
        [property: JsonPropertyName("speaker")] string Speaker,
        [property: JsonPropertyName("text")] string Text);

    public sealed record CastAudioRequest(
        [property: JsonPropertyName("dialogTurns")] CastAudioTurnInput[]? DialogTurns,
        [property: JsonPropertyName("gapMs")] int GapMs = 350);

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
        [property: JsonPropertyName("synthesizedAt")] DateTimeOffset SynthesizedAt,
        [property: JsonPropertyName("liveArticleCount")] int LiveArticleCount = 0,
        [property: JsonPropertyName("neuralAudioAvailable")] bool NeuralAudioAvailable = false);

    public sealed record CastPreset(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("category")] string Category,
        [property: JsonPropertyName("description")] string Description);

    private static readonly CastPreset[] DefaultPresets =
    [
        new(
            Id: "live-wire",
            Title: "Today's Live Wire: Breaking Feed & Market Debate",
            Category: "Live Intelligence",
            Description: "David and Sarah dynamically debate your top live news wires, portfolio tickers, and stored history."
        ),
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

    [HttpGet("audio-status")]
    public IActionResult GetAudioStatus()
    {
        return Ok(new
        {
            neuralAvailable = speechRenderer?.Enabled == true,
            requiresAuth = true,
            authenticated = User?.Identity?.IsAuthenticated == true
        });
    }

    [HttpPost("synthesize")]
    [IgnoreAntiforgeryToken]
    public async Task<IActionResult> Synthesize(
        [FromBody] CastSynthesizeRequest? request,
        CancellationToken cancellationToken)
    {
        var requestedId = request?.EpisodeTopic?.Trim().ToLowerInvariant();
        var mergedArticles = new List<CastArticleInput>();
        var seenTitles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (request?.Articles is { Length: > 0 })
        {
            foreach (var art in request.Articles)
            {
                if (string.IsNullOrWhiteSpace(art.Title)) continue;
                var cleanTitle = CleanHeadline(art.Title);
                if (seenTitles.Add(cleanTitle))
                {
                    mergedArticles.Add(art with { Title = cleanTitle });
                }
            }
        }

        // Enrich with signed-in user's SQLite article history (strictly scoped by UserId)
        var userId = User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (database is not null && !string.IsNullOrEmpty(userId))
        {
            try
            {
                var stored = await database.StoredNewsArticles
                    .AsNoTracking()
                    .Where(a => a.UserId == userId)
                    .OrderByDescending(a => a.LastSeenAtUtc)
                    .Take(12)
                    .Select(a => new { a.Title, a.Source, a.Summary })
                    .ToArrayAsync(cancellationToken);

                foreach (var item in stored)
                {
                    var cleanTitle = CleanHeadline(item.Title);
                    if (seenTitles.Add(cleanTitle))
                    {
                        mergedArticles.Add(new CastArticleInput(cleanTitle, item.Source, item.Summary));
                    }
                }
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
            {
                logger?.LogDebug(ex, "Daily Cast could not read user stored news articles.");
            }
        }

        // Optional live market tape snapshot when configured
        string? liveMarketHighlight = null;
        if (marketData is { IsConfigured: true })
        {
            try
            {
                var quotes = await marketData.GetWatchlistAsync(
                    [new MarketWatchlistTopicInput("S&P 500", "SPY"), new MarketWatchlistTopicInput("NVIDIA", "NVDA")],
                    2,
                    cancellationToken);
                if (quotes.Length > 0)
                {
                    liveMarketHighlight = string.Join("; ", quotes.Select(q =>
                    {
                        var sign = q.PercentChange >= 0 ? "+" : "";
                        return $"{q.Symbol} at {q.Currency} {q.Price:F2} ({sign}{q.PercentChange:F2}%)";
                    }));
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Ignore market tape hiccups so dialogue synthesis still succeeds
            }
        }

        var articles = mergedArticles.ToArray();
        var defaultPreset = articles.Length > 0 ? DefaultPresets[0] : DefaultPresets[1];
        var topicId = string.IsNullOrWhiteSpace(requestedId) ? defaultPreset.Id : requestedId;
        var preset = DefaultPresets.FirstOrDefault(p => p.Id == topicId) ?? defaultPreset;

        var (turns, chapters) = preset.Id switch
        {
            "live-wire" => BuildLiveWireTurns(articles, liveMarketHighlight),
            "chokepoints-nearshoring" => BuildChokepointsTurns(articles, liveMarketHighlight),
            "silicon-sovereignty" => BuildSiliconTurns(articles, liveMarketHighlight),
            _ => BuildMacroTurns(articles, liveMarketHighlight)
        };

        var totalSeconds = Math.Round(turns.Sum(t => t.DurationSeconds), 1);

        var showNotes = articles.Length > 0
            ? $"In this live Signal Daily Cast episode ({preset.Title}), David Vance and Sarah Chen synthesize {articles.Length} breaking stories"
              + (liveMarketHighlight is not null ? $" alongside live market tape ({liveMarketHighlight})." : ".")
              + " They challenge conventional assumptions and surface actionable 90-day strategic hedges."
            : $"In this episode of Signal Daily Cast, David and Sarah break down '{preset.Title}'. They explore the operational realities behind breaking headlines, challenge conventional corporate consensus, and identify where executive leadership needs to hedge their exposure over the next 90 days.";

        var response = new DailyCastResponse(
            EpisodeId: preset.Id,
            EpisodeTitle: $"Signal Daily Cast: {preset.Title}",
            ShowNotes: showNotes,
            TotalDurationSeconds: totalSeconds,
            Chapters: chapters,
            DialogTurns: turns,
            SynthesizedAt: DateTimeOffset.UtcNow,
            LiveArticleCount: articles.Length,
            NeuralAudioAvailable: speechRenderer?.Enabled == true);

        return Ok(response);
    }

    [HttpPost("audio")]
    [Authorize]
    [EnableRateLimiting("audio")]
    [RequestSizeLimit(32_768)]
    public async Task<IActionResult> SynthesizeAudio(
        [FromBody] CastAudioRequest? request,
        CancellationToken cancellationToken)
    {
        if (speechRenderer is null || !speechRenderer.Enabled)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                error = "Azure Neural speech is not configured on this server. Using browser speech synthesis fallback.",
                fallback = "browser"
            });
        }

        var turnsInput = request?.DialogTurns ?? [];
        if (turnsInput.Length == 0)
        {
            return BadRequest(new { error = "At least one dialogue turn is required for studio audio synthesis." });
        }

        try
        {
            var turns = turnsInput
                .Select(t => (
                    Speaker: string.Equals(t.Speaker, "david", StringComparison.OrdinalIgnoreCase) ? "david" : "sarah",
                    Text: t.Text ?? ""))
                .ToArray();

            var audio = await speechRenderer.GenerateDialogueAsync(turns, request?.GapMs ?? 350, cancellationToken);
            Response.Headers["X-Signal-Cast-Starts"] = JsonSerializer.Serialize(audio.Starts);
            Response.Headers["X-Signal-Cast-Engine"] = "azure-neural";
            return File(audio.Wave, "audio/wav");
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (HeadlineAudioUnavailableException ex)
        {
            logger?.LogWarning(ex, "Daily Cast Azure neural audio unavailable: {Code}", ex.Code);
            Response.Headers.RetryAfter = "3";
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                error = ex.Message,
                code = ex.Code,
                fallback = "browser"
            });
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Daily Cast audio synthesis failed.");
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                error = "Studio neural audio rendering is temporarily unavailable.",
                fallback = "browser"
            });
        }
    }

    private static (CastDialogTurn[], CastChapter[]) BuildLiveWireTurns(
        CastArticleInput[] articles,
        string? marketHighlight)
    {
        if (articles.Length == 0)
        {
            return BuildMacroTurns(articles, marketHighlight);
        }

        var lead = articles[0];
        var second = articles.Length > 1 ? articles[1] : null;
        var third = articles.Length > 2 ? articles[2] : null;
        var turns = new List<CastDialogTurn>();

        turns.Add(new(
            1, "david", "David Vance", "Chief Macro Strategist", "🎙️",
            $"Good morning and welcome to the Signal Live Wire Cast. I'm David Vance with Sarah Chen. Sarah, dominating the terminal at the top of the hour is a report from {SafeSource(lead.Source)}: '{lead.Title}'. What stands out operationally?"
            + (marketHighlight is not null ? $" Meanwhile, equity desks are tracking {marketHighlight}." : ""),
            11.5));

        var leadContext = !string.IsNullOrWhiteSpace(lead.Summary)
            ? Shorten(lead.Summary!, 170)
            : "it signals a shift in sector pricing power and regulatory posture that corporate planning teams shouldn't ignore.";
        turns.Add(new(
            2, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
            $"Looking closely at that dispatch from {SafeSource(lead.Source)}, David, the core takeaway is clear: {leadContext} Leaders should cross-check whether their Tier-1 vendor contracts or regional exposure sit directly in that blast radius.",
            12.0));

        if (second is not null)
        {
            turns.Add(new(
                3, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                $"That connects straight into the second thread we're watching via {SafeSource(second.Source)}: '{second.Title}'. When multiple wires move simultaneously on adjacent supply or policy rails, implied volatility tends to reprice fast.",
                11.0));
        }

        if (third is not null)
        {
            turns.Add(new(
                turns.Count + 1, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                $"And don't overlook {SafeSource(third.Source)} reporting '{third.Title}'. Put together, across the {articles.Length} live stories in today's feed, the common denominator is tightening compliance margins and faster capital reallocation.",
                11.0));
        }

        turns.Add(new(
            turns.Count + 1, "david", "David Vance", "Chief Macro Strategist", "🎙️",
            "Bottom line for the executive committee today: set an Executive Tripwire on these headlines, review cash conversion buffers, and run a 15-minute Pre-Mortem check if your Q3 roadmap depends on unhedged external inputs.",
            10.5));

        turns.Add(new(
            turns.Count + 1, "sarah", "Sarah Chen", "Geopolitical & Deep Tech Lead", "🎧",
            "We'll keep monitoring every wire in real time. Stay decisive, stay hedged, and catch us on tomorrow's Daily Cast.",
            7.5));

        var chapters = new List<CastChapter>
        {
            new(0.0, $"Lead Wire: {Shorten(lead.Title, 44)}")
        };
        if (second is not null)
            chapters.Add(new(23.5, $"Cross-Signal: {Shorten(second.Title, 42)}"));
        chapters.Add(new(Math.Max(34.0, turns.Count * 9.0), "Executive Hedge & Tripwire Action"));

        return (turns.ToArray(), chapters.ToArray());
    }

    private static (CastDialogTurn[], CastChapter[]) BuildMacroTurns(
        CastArticleInput[] articles,
        string? marketHighlight)
    {
        var liveTieIn = articles.Length > 0
            ? $" Specifically, seeing '{articles[0].Title}' from {SafeSource(articles[0].Source)} reinforces how fast repricing risks can surface."
            : "";
        var marketNote = marketHighlight is not null
            ? $" Right now on our live tape we're seeing {marketHighlight}."
            : "";

        var turns = new CastDialogTurn[]
        {
            new(1, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "Good morning and welcome to the Signal Daily Cast. I'm David Vance, here with Sarah Chen. Sarah, looking at the bond markets this morning, yields are pricing in a much slower easing cycle than tech equities seem to assume." + marketNote, 11.0),
            new(2, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "That's right, David. While market equity multiples are hovering near 24 times forward earnings, the physical cost of capital is stubbornly anchored. If you look at hyperscaler earnings calls, capital expenditures are up 45% year-over-year, largely allocated to sovereign AI infrastructure." + liveTieIn, 12.5),
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
            new(23.5, "Hyperscaler Capex vs Cash Conversion"),
            new(44.0, "Sovereign Compute & Regulatory Walls"),
            new(55.0, "Executive Takeaways & Energy Sourcing")
        };

        return (turns, chapters);
    }

    private static (CastDialogTurn[], CastChapter[]) BuildChokepointsTurns(
        CastArticleInput[] articles,
        string? marketHighlight)
    {
        var matching = articles.FirstOrDefault(a =>
            a.Title.Contains("ship", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("tariff", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("trade", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("red sea", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("port", StringComparison.OrdinalIgnoreCase)) ?? articles.FirstOrDefault();

        var wireNote = matching is not null
            ? $" Just look at {SafeSource(matching.Source)} reporting '{matching.Title}' — that proves freight velocity remains fragile."
            : "";

        var turns = new CastDialogTurn[]
        {
            new(1, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "Welcome to Signal Daily Cast. I'm Sarah Chen with David Vance. Today we're diving into maritime logistics. David, 65% of container traffic remains diverted around the Cape of Good Hope, and the freight surcharges are getting baked into retail shelves." + wireNote, 11.5),
            new(2, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "It's fascinating, Sarah. Everyone in the boardroom talked about 'nearshoring to Mexico' as an instant silver bullet. But if your raw cathode powder or precision tooling still has to cross the Pacific, you haven't eliminated the bottleneck; you've just moved it.", 12.5),
            new(3, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "Exactly. In Monterrey and Queretaro, industrial park vacancy is under 2%, and local water and electrical hookups have 18-month lead times. You can't just flip a switch and replace Shenzhen overnight.", 10.5),
            new(4, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "So what does an executive do? You dual-source, and you hold 45 days of safety stock rather than just-in-time inventory. Yes, working capital goes up, but a halted assembly line costs 10 times more." + (marketHighlight is not null ? $" Equity desks ({marketHighlight}) are rewarding margin resilience." : ""), 11.5),
            new(5, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "And audit your tier-two suppliers! Most companies know their direct vendor, but they have zero visibility into where their vendor buys raw minerals. That's where the real vulnerability hides.", 10.0)
        };

        var chapters = new CastChapter[]
        {
            new(0.0, "The 12-Day Cape Detour Penalty"),
            new(24.0, "The Nearshoring Reality Check"),
            new(45.0, "Working Capital vs Line Shutdowns")
        };

        return (turns, chapters);
    }

    private static (CastDialogTurn[], CastChapter[]) BuildSiliconTurns(
        CastArticleInput[] articles,
        string? marketHighlight)
    {
        var matching = articles.FirstOrDefault(a =>
            a.Title.Contains("chip", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("ai", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("nvidia", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("tsmc", StringComparison.OrdinalIgnoreCase)
            || a.Title.Contains("semiconductor", StringComparison.OrdinalIgnoreCase)) ?? articles.FirstOrDefault();

        var wireNote = matching is not null
            ? $" Paired with {SafeSource(matching.Source)}'s coverage of '{matching.Title}', capital allocation across the compute stack is accelerating."
            : "";

        var turns = new CastDialogTurn[]
        {
            new(1, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "Welcome back to Signal Daily Cast. David Vance here with Sarah Chen. Sarah, ASML and TSMC continue pushing sub-2nm High-NA lithography milestones. The capital expenditure is staggering: each machine costs upwards of $380 million." + wireNote, 12.5),
            new(2, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "It is a monumental technological feat, David. But it also concentrates 90% of global cutting-edge fabrication into a handful of square miles in Hsinchu and Tainan. If cross-strait airspace shuts down for even 48 hours, global tech halts.", 12.5),
            new(3, "david", "David Vance", "Chief Macro Strategist", "🎙️",
                "That's why Western governments are pouring tens of billions into domestic fabs in Arizona, Ohio, and Dresden. But training cleanroom technicians and establishing chemical supply chains is proving to be a multi-year slog." + (marketHighlight is not null ? $" Meanwhile, hardware sentiment reflects {marketHighlight}." : ""), 11.5),
            new(4, "sarah", "Sarah Chen", "Geopolitical & Tech Lead", "🎧",
                "The lesson for enterprise boards: if your products depend on sub-7nm wafers, secure guaranteed packaging allocations 18 months in advance. The capacity queue isn't getting any shorter.", 10.5)
        };

        var chapters = new CastChapter[]
        {
            new(0.0, "High-NA EUV Machine Economics"),
            new(25.0, "Geographic Concentration Risk"),
            new(36.5, "Securing 18-Month Packaging Allocations")
        };

        return (turns, chapters);
    }

    private static string SafeSource(string? source) => string.IsNullOrWhiteSpace(source) ? "Signal Wires" : source.Trim();

    private static string CleanHeadline(string title)
    {
        var collapsed = Regex.Replace(title.Trim(), @"\s+", " ");
        return collapsed.Length > 180 ? collapsed[..177] + "..." : collapsed;
    }

    private static string Shorten(string text, int maxChars)
    {
        var collapsed = Regex.Replace(text.Trim(), @"\s+", " ");
        return collapsed.Length <= maxChars ? collapsed : collapsed[..Math.Max(0, maxChars - 3)] + "...";
    }
}
