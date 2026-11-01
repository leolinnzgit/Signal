using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/briefing/deep-dive")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class BriefingDeepDiveController(
    AzureTranslatorService translator,
    ILogger<BriefingDeepDiveController> logger) : ControllerBase
{
    public sealed record DeepDiveArticleInput(
        string? Url,
        string? Title,
        string? Source,
        string? Summary,
        string[]? Topics = null);

    public sealed record DeepDiveRequest(
        string? Topic,
        DeepDiveArticleInput[]? Articles,
        string? MarketContext,
        string? Language = "en");

    public sealed record DeepDiveTurn(
        int Index,
        string Speaker,
        string SpeakerName,
        string VoiceName,
        string Role,
        string Text,
        string? CitedSource,
        string? CitedUrl);

    public sealed record DeepDiveChapter(
        string Title,
        int StartTurnIndex);

    public sealed record DeepDiveResponse(
        bool Available,
        string Title,
        string Subtitle,
        DeepDiveTurn[] Turns,
        DeepDiveChapter[] Chapters,
        int EstimatedDurationSeconds,
        string Language);

    private sealed record NormalizedArticle(
        string Url,
        string Title,
        string Source,
        string Summary);

    [HttpPost]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> Generate(
        [FromBody] DeepDiveRequest? request,
        CancellationToken token)
    {
        var topic = NormalizeText(request?.Topic, 120);
        var articles = NormalizeArticles(request?.Articles);
        var marketContext = NormalizeText(request?.MarketContext, 300);
        var targetLanguage = NormalizeLanguage(request?.Language);

        if (articles.Length == 0 && string.IsNullOrWhiteSpace(topic))
        {
            return BadRequest(new DeepDiveResponse(
                false,
                "Unable to produce episode",
                "At least one news story or a designated topic is required to produce an Executive Deep Dive.",
                [],
                [],
                0,
                targetLanguage));
        }

        var episodeTitle = !string.IsNullOrWhiteSpace(topic)
            ? $"Executive Deep Dive: {topic}"
            : $"Executive Deep Dive: {articles[0].Title}";

        var distinctSources = articles
            .Select(a => a.Source)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var sourceLabel = distinctSources.Length switch
        {
            0 => "Global Market Intelligence",
            1 => distinctSources[0],
            2 => $"{distinctSources[0]} & {distinctSources[1]}",
            _ => $"{distinctSources[0]}, {distinctSources[1]} & others"
        };

        var subtitle = $"Investigative dialogue dissecting contrasting publisher reporting from {sourceLabel}.";

        var (anchorVoice, analystVoice) = SelectVoices(targetLanguage);

        var turns = BuildDialogueTurns(
            topic,
            articles,
            marketContext,
            anchorVoice,
            analystVoice);

        var chapters = new[]
        {
            new DeepDiveChapter("Overview & Ground-Level Reporting", 0),
            new DeepDiveChapter("Contrasting Perspectives & Stakes", 2),
            new DeepDiveChapter("Market & Economic Repercussions", 4),
            new DeepDiveChapter("Executive Outlook & Takeaway", 6)
        };

        // If a non-English language is requested and translation is configured, translate dialogue turns
        if (targetLanguage != "en" && translator.Enabled)
        {
            try
            {
                var textsToTranslate = turns.Select(t => t.Text).ToArray();
                var translatedTexts = await translator.TranslateTextsAsync(textsToTranslate, targetLanguage, token);
                if (translatedTexts.Length == turns.Length)
                {
                    var localizedTurns = new DeepDiveTurn[turns.Length];
                    for (var i = 0; i < turns.Length; i++)
                    {
                        localizedTurns[i] = turns[i] with { Text = translatedTexts[i] };
                    }
                    turns = localizedTurns;
                }

                var titleTrans = await translator.TranslateTextsAsync([episodeTitle, subtitle], targetLanguage, token);
                if (titleTrans.Length == 2)
                {
                    episodeTitle = titleTrans[0];
                    subtitle = titleTrans[1];
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning("Deep dive translation to {Language} failed ({ExceptionType}). Falling back to English.",
                    targetLanguage, ex.GetType().Name);
            }
        }

        var totalWords = turns.Sum(t => t.Text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length);
        var durationSeconds = Math.Max(45, (int)Math.Round(totalWords / 2.5)); // ~150 words per minute

        return Ok(new DeepDiveResponse(
            true,
            episodeTitle,
            subtitle,
            turns,
            chapters,
            durationSeconds,
            targetLanguage));
    }

    private static DeepDiveTurn[] BuildDialogueTurns(
        string topic,
        NormalizedArticle[] articles,
        string marketContext,
        string anchorVoice,
        string analystVoice)
    {
        var primaryArticle = articles.Length > 0
            ? articles[0]
            : new NormalizedArticle("https://signal.internal/briefing", topic, "Signal Desk", "Comprehensive coverage of recent events.");

        var secondaryArticle = articles.Length > 1
            ? articles[1]
            : primaryArticle;

        var focusTopic = !string.IsNullOrWhiteSpace(topic) ? topic : primaryArticle.Title;

        var primarySnippet = ExtractFirstSentence(primaryArticle.Summary);
        if (string.IsNullOrWhiteSpace(primarySnippet)) primarySnippet = primaryArticle.Title;

        var secondarySnippet = ExtractFirstSentence(secondaryArticle.Summary);
        if (string.IsNullOrWhiteSpace(secondarySnippet)) secondarySnippet = secondaryArticle.Title;

        var marketSnippet = !string.IsNullOrWhiteSpace(marketContext)
            ? $"against the backdrop of {marketContext}"
            : "as global equity and bond benchmarks evaluate the macro trajectory";

        return
        [
            // Turn 0 - Anchor
            new DeepDiveTurn(
                0,
                "Anchor",
                "Alex, Anchor",
                anchorVoice,
                "Executive Host",
                $"Welcome to this Signal Executive Deep Dive on {focusTopic}. Multiple publishers have weighed in on unfolding developments, and executive teams must separate fundamental shifts from momentary market noise. Elena, take us into the primary reporting.",
                null,
                null),

            // Turn 1 - Analyst
            new DeepDiveTurn(
                1,
                "Analyst",
                "Elena, Chief Analyst",
                analystVoice,
                "Senior Analyst",
                $"Thanks Alex. Ground-level coverage from {primaryArticle.Source} establishes that {EnsurePeriod(primarySnippet)} The immediate takeaway is that institutional stakeholders are treating this as a material inflection point rather than routine commentary.",
                primaryArticle.Source,
                primaryArticle.Url),

            // Turn 2 - Anchor
            new DeepDiveTurn(
                2,
                "Anchor",
                "Alex, Anchor",
                anchorVoice,
                "Executive Host",
                $"However, {secondaryArticle.Source} takes a noticeably different angle, emphasizing that {EnsurePeriod(secondarySnippet)} Elena, why the divergence in focus between these publishers?",
                secondaryArticle.Source,
                secondaryArticle.Url),

            // Turn 3 - Analyst
            new DeepDiveTurn(
                3,
                "Analyst",
                "Elena, Chief Analyst",
                analystVoice,
                "Senior Analyst",
                $"That divergence reveals where the true structural friction lies. While {primaryArticle.Source} highlights immediate top-line consequences, {secondaryArticle.Source} underscores regulatory oversight, supply chain fragility, and governance pushback. For executive planning, that means short-term optimism could overlook medium-term compliance headwinds.",
                secondaryArticle.Source,
                secondaryArticle.Url),

            // Turn 4 - Anchor
            new DeepDiveTurn(
                4,
                "Anchor",
                "Alex, Anchor",
                anchorVoice,
                "Executive Host",
                $"And this is unfolding {marketSnippet}. How are institutional capital allocators positioning around this across sectors?",
                null,
                null),

            // Turn 5 - Analyst
            new DeepDiveTurn(
                5,
                "Analyst",
                "Elena, Chief Analyst",
                analystVoice,
                "Senior Analyst",
                "We are seeing asymmetric repricing. Core defensive plays and resilient balance sheets are retaining premiums, whereas leveraged or policy-sensitive players are seeing wider risk spreads. Corporate leadership should stress-test liquidity scenarios through the current quarter.",
                null,
                null),

            // Turn 6 - Anchor
            new DeepDiveTurn(
                6,
                "Anchor",
                "Alex, Anchor",
                anchorVoice,
                "Executive Host",
                "Elena, what is the single critical signal or milestone executives should track closely over the next 48 to 72 hours?",
                null,
                null),

            // Turn 7 - Analyst
            new DeepDiveTurn(
                7,
                "Analyst",
                "Elena, Chief Analyst",
                analystVoice,
                "Senior Analyst",
                "Watch for formal filings from lead governing bodies and secondary disclosures from international partners. If unified statements emerge, expect lasting strategic alignment. We will track every development here on Signal.",
                null,
                null),

            // Turn 8 - Anchor
            new DeepDiveTurn(
                8,
                "Anchor",
                "Alex, Anchor",
                anchorVoice,
                "Executive Host",
                "That wraps up today's Signal Executive Deep Dive. Thank you for listening, and we'll see you in the next executive briefing.",
                null,
                null)
        ];
    }

    private static (string Anchor, string Analyst) SelectVoices(string language)
    {
        return language switch
        {
            "zh-Hans" or "zh-Hant" => ("zh-CN-YunxiNeural", "zh-CN-XiaoxiaoNeural"),
            "ja" => ("ja-JP-KeitaNeural", "ja-JP-NanamiNeural"),
            "fr" => ("fr-FR-HenriNeural", "fr-FR-DeniseNeural"),
            "de" => ("de-DE-ConradNeural", "de-DE-KatjaNeural"),
            "es" => ("es-ES-AlvaroNeural", "es-ES-ElviraNeural"),
            _ => ("en-US-AndrewMultilingualNeural", "en-US-AvaMultilingualNeural")
        };
    }

    private static string NormalizeText(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var clean = Regex.Replace(value.Trim(), @"\s+", " ");
        return clean.Length > maxLength ? clean[..maxLength].Trim() : clean;
    }

    private static string NormalizeLanguage(string? value)
    {
        var lang = (value ?? "").Trim().ToLowerInvariant();
        return lang switch
        {
            "zh" or "zh-cn" or "zh-hans" => "zh-Hans",
            "zh-tw" or "zh-hk" or "zh-hant" => "zh-Hant",
            "ja" => "ja",
            "fr" => "fr",
            "de" => "de",
            "es" => "es",
            _ => "en"
        };
    }

    private static string ExtractFirstSentence(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        var clean = Regex.Replace(text.Trim(), @"\s+", " ");
        var match = Regex.Match(clean, @"^([^.!?]+[.!?])");
        return match.Success ? match.Value.Trim() : clean;
    }

    private static string EnsurePeriod(string text)
    {
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed)) return "";
        return trimmed.EndsWith('.') || trimmed.EndsWith('!') || trimmed.EndsWith('?')
            ? trimmed
            : $"{trimmed}.";
    }

    private static NormalizedArticle[] NormalizeArticles(DeepDiveArticleInput[]? inputs)
    {
        if (inputs is null || inputs.Length == 0) return [];
        var result = new List<NormalizedArticle>();
        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var input in inputs)
        {
            if (input is null) continue;
            var url = NormalizeText(input.Url, 2048);
            var title = NormalizeText(input.Title, 300);
            var source = NormalizeText(input.Source, 100);
            var summary = NormalizeText(input.Summary, 1000);

            if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http"))
                continue;
            if (string.IsNullOrWhiteSpace(title)) continue;
            if (!seenUrls.Add(url)) continue;

            if (string.IsNullOrWhiteSpace(source)) source = "News Desk";
            result.Add(new NormalizedArticle(url, title, source, summary));
            if (result.Count >= 10) break;
        }

        return result.ToArray();
    }
}
