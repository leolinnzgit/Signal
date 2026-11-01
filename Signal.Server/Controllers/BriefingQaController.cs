using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/briefing-qa")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class BriefingQaController(
    ArticleReaderService reader,
    AzureLanguageSummaryService summaries,
    AzureTranslatorService translator,
    ILogger<BriefingQaController> logger) : ControllerBase
{
    public sealed record BriefingQaArticleInput(
        string? Url,
        string? Title,
        string? Source,
        string? Summary,
        string[]? Topics = null);

    public sealed record BriefingQaRequest(
        string? Question,
        string? WeatherContext,
        string? MarketContext,
        string? PulseContext,
        BriefingQaArticleInput[]? Articles,
        string? Language = "en");

    public sealed record BriefingQaCitation(
        string Url,
        string Title,
        string Source);

    public sealed record BriefingQaResponse(
        bool Available,
        string Answer,
        string Mode,
        BriefingQaCitation[] Citations,
        string Language);

    private sealed record NormalizedBriefingArticle(
        string Url,
        string Title,
        string Source,
        string Summary,
        string[] Topics);

    private static readonly Regex WeatherIntentRegex = new(
        @"\b(?:weather|rain|raining|temperature|forecast|wind|windy|uv|alert|umbrella|sunny|cloud|cloudy|storm|cold|warm|hot|degrees)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex MarketIntentRegex = new(
        @"\b(?:market|markets|stock|stocks|price|prices|ticker|tickers|index|indices|share|shares|gain|gains|drop|drops|mover|movers|trading|nasdaq|dow|nzx|nyse|sp500|s&p)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex PulseIntentRegex = new(
        @"\b(?:pulse|surging|trend|trending|momentum|topic|topics|mood|tone|focus|coverage)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly HashSet<string> StopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "about", "after", "again", "any", "are", "been", "before", "being", "briefing",
        "can", "could", "daily", "did", "does", "doing", "Executive", "for", "from",
        "give", "going", "happening", "has", "have", "having", "here", "how", "into",
        "just", "know", "latest", "main", "more", "most", "much", "news", "now",
        "other", "our", "out", "over", "please", "report", "reporting", "right",
        "say", "saying", "says", "should", "some", "stories", "story", "summarize",
        "summary", "tell", "than", "that", "the", "their", "them", "then", "there",
        "these", "they", "this", "today", "todays", "top", "update", "updates",
        "very", "want", "was", "were", "what", "whats", "when", "where", "which",
        "who", "why", "will", "with", "would", "your",
    };

    [HttpPost("ask")]
    [RequestSizeLimit(65_536)]
    public async Task<IActionResult> Ask(
        [FromBody] BriefingQaRequest? request,
        CancellationToken token)
    {
        var question = NormalizeText(request?.Question, 300);
        if (question.Length < 2)
        {
            return BadRequest(new { error = "Ask a question about today's briefing (at least 2 characters)." });
        }

        var targetLanguage = NormalizeBriefingLanguage(request?.Language);
        var weatherContext = NormalizeText(request?.WeatherContext, 420);
        var marketContext = NormalizeText(request?.MarketContext, 520);
        var pulseContext = NormalizeText(request?.PulseContext, 420);
        var articles = NormalizeArticles(request?.Articles);

        var wantsWeather = WeatherIntentRegex.IsMatch(question);
        var wantsMarket = MarketIntentRegex.IsMatch(question);
        var wantsPulse = PulseIntentRegex.IsMatch(question);

        var keywords = ExtractKeywords(question);
        var ranked = RankArticles(question, keywords, articles);
        var matchedArticles = ranked
            .Where(entry => entry.Score > 0)
            .Take(4)
            .Select(entry => entry.Article)
            .ToArray();

        if (matchedArticles.Length == 0 && articles.Length > 0)
        {
            var hasSpecificSignalAnswer =
                (wantsWeather && weatherContext.Length > 0)
                || (wantsMarket && marketContext.Length > 0)
                || (wantsPulse && pulseContext.Length > 0);

            if (!hasSpecificSignalAnswer)
            {
                matchedArticles = articles.Take(3).ToArray();
            }
        }

        try
        {
            var enrichedArticleBlocks = await BuildEnrichedArticleDossiersAsync(matchedArticles, token);
            var evidenceBlocks = new List<string>(7);

            var includeAllSignals = matchedArticles.Length > 0
                && ranked.All(entry => entry.Score == 0)
                && !wantsWeather && !wantsMarket && !wantsPulse;

            if ((wantsWeather || includeAllSignals) && weatherContext.Length > 0)
            {
                evidenceBlocks.Add($"Local weather update: {EnsurePeriod(weatherContext)}");
            }

            if ((wantsMarket || includeAllSignals) && marketContext.Length > 0)
            {
                evidenceBlocks.Add($"Market watchlist update: {EnsurePeriod(marketContext)}");
            }

            if ((wantsPulse || includeAllSignals) && pulseContext.Length > 0)
            {
                evidenceBlocks.Add($"Feed momentum update: {EnsurePeriod(pulseContext)}");
            }

            evidenceBlocks.AddRange(enrichedArticleBlocks);

            var citations = matchedArticles
                .Select(item => new BriefingQaCitation(item.Url, item.Title, item.Source))
                .ToArray();

            if (evidenceBlocks.Count == 0)
            {
                var emptyAnswer = "There are not enough stories or live signals in today's briefing yet to answer that question.";
                emptyAnswer = await MaybeTranslateAnswerAsync(emptyAnswer, targetLanguage, token);
                return Ok(new BriefingQaResponse(false, emptyAnswer, "empty", [], targetLanguage));
            }

            string answer = "";
            string mode = "extractive";

            if (summaries.Enabled)
            {
                try
                {
                    var summaryResult = await summaries.SummarizeAsync(evidenceBlocks, token, sentenceCount: 3);
                    if (summaryResult.Available && summaryResult.Paragraphs.Length > 0)
                    {
                        var combined = string.Join(" ", summaryResult.Paragraphs).Trim();
                        if (combined.Length > 0)
                        {
                            answer = combined;
                            mode = "azure-ai";
                        }
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    logger.LogInformation("Briefing Q&A AI synthesis fell back to extractive mode ({FailureType}).", exception.GetType().Name);
                }
            }

            if (answer.Length == 0)
            {
                answer = BuildExtractiveAnswer(
                    wantsWeather ? weatherContext : "",
                    wantsMarket ? marketContext : "",
                    wantsPulse ? pulseContext : "",
                    matchedArticles,
                    weatherContext,
                    marketContext,
                    pulseContext);
                mode = "extractive";
            }

            answer = await MaybeTranslateAnswerAsync(answer, targetLanguage, token);
            return Ok(new BriefingQaResponse(true, answer, mode, citations, targetLanguage));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger.LogWarning("Briefing Q&A failed ({FailureType}).", exception.GetType().Name);
            return StatusCode(StatusCodes.Status502BadGateway, new { error = "Briefing Q&A is temporarily unavailable." });
        }
    }

    private async Task<string> MaybeTranslateAnswerAsync(
        string answer,
        string targetLanguage,
        CancellationToken token)
    {
        if (targetLanguage == "en" || !translator.Enabled || string.IsNullOrWhiteSpace(answer))
            return answer;

        try
        {
            var translated = await translator.TranslateTextsAsync([answer], targetLanguage, token);
            if (translated.Length > 0 && !string.IsNullOrWhiteSpace(translated[0]))
            {
                return translated[0].Trim();
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogInformation("Briefing Q&A answer translation skipped ({FailureType}).", exception.GetType().Name);
        }

        return answer;
    }

    internal static string NormalizeBriefingLanguage(string? language)
    {
        if (string.IsNullOrWhiteSpace(language)) return "en";
        var trimmed = language.Trim();
        var exact = AzureTranslatorService.Languages.FirstOrDefault(
            code => code.Equals(trimmed, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact;

        if (trimmed.Equals("zh-CN", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("zh-SG", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("zh", StringComparison.OrdinalIgnoreCase))
        {
            return "zh-Hans";
        }

        if (trimmed.Equals("zh-TW", StringComparison.OrdinalIgnoreCase)
            || trimmed.Equals("zh-HK", StringComparison.OrdinalIgnoreCase))
        {
            return "zh-Hant";
        }

        var prefix = trimmed.Split('-')[0];
        var prefixMatch = AzureTranslatorService.Languages.FirstOrDefault(
            code => code.Equals(prefix, StringComparison.OrdinalIgnoreCase));
        return prefixMatch ?? "en";
    }

    private static string BuildExtractiveAnswer(
        string matchedWeather,
        string matchedMarket,
        string matchedPulse,
        NormalizedBriefingArticle[] matchedArticles,
        string fallbackWeather,
        string fallbackMarket,
        string fallbackPulse)
    {
        var sentences = new List<string>(4);

        if (matchedWeather.Length > 0)
            sentences.Add(EnsurePeriod(matchedWeather));
        if (matchedMarket.Length > 0)
            sentences.Add(EnsurePeriod(matchedMarket));
        if (matchedPulse.Length > 0)
            sentences.Add(EnsurePeriod(matchedPulse));

        foreach (var article in matchedArticles.Take(3))
        {
            if (sentences.Count >= 3) break;
            var leadSentence = ExtractFirstSentence(article.Summary);
            if (leadSentence.Length > 0 && !leadSentence.Equals(article.Title, StringComparison.OrdinalIgnoreCase))
            {
                sentences.Add($"According to {article.Source}, {EnsurePeriod(article.Title)} {EnsurePeriod(leadSentence)}");
            }
            else
            {
                sentences.Add($"{article.Source} reports: {EnsurePeriod(article.Title)}");
            }
        }

        if (sentences.Count == 0)
        {
            if (fallbackWeather.Length > 0) sentences.Add(EnsurePeriod(fallbackWeather));
            if (fallbackMarket.Length > 0 && sentences.Count < 3) sentences.Add(EnsurePeriod(fallbackMarket));
            if (fallbackPulse.Length > 0 && sentences.Count < 3) sentences.Add(EnsurePeriod(fallbackPulse));
        }

        return string.Join(" ", sentences);
    }

    private static string ExtractFirstSentence(string summary)
    {
        if (string.IsNullOrWhiteSpace(summary)) return "";
        var trimmed = summary.Trim();
        for (var i = 20; i < Math.Min(trimmed.Length, 220); i++)
        {
            if (trimmed[i] is '.' or '!' or '?' && (i + 1 == trimmed.Length || char.IsWhiteSpace(trimmed[i + 1])))
            {
                return trimmed[..(i + 1)].Trim();
            }
        }
        return trimmed.Length <= 200 ? trimmed : trimmed[..200].TrimEnd() + "...";
    }

    private static string EnsurePeriod(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Length == 0) return "";
        return trimmed[^1] is '.' or '!' or '?' ? trimmed : trimmed + ".";
    }

    private async Task<string[]> BuildEnrichedArticleDossiersAsync(
        NormalizedBriefingArticle[] articles,
        CancellationToken token)
    {
        if (articles.Length == 0) return [];

        var selected = articles.Take(4).ToArray();
        var excerpts = new string[selected.Length];
        var enrichTasks = new List<Task>();
        var enrichedCount = 0;

        for (var i = 0; i < selected.Length; i++)
        {
            var index = i;
            var item = selected[index];
            excerpts[index] = item.Summary;

            if (enrichedCount < 2
                && item.Summary.Length < 160
                && item.Url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                enrichedCount++;
                enrichTasks.Add(Task.Run(async () =>
                {
                    try
                    {
                        using var shortTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                        shortTimeout.CancelAfter(TimeSpan.FromSeconds(2.5));
                        var extracted = await reader.ReadAsync(item.Url, shortTimeout.Token);
                        if (extracted.Available && extracted.Article?.Paragraphs is { Count: > 0 } paragraphs)
                        {
                            var combined = string.Join(" ", paragraphs.Take(3));
                            var normalized = NormalizeText(combined, 750);
                            if (normalized.Length > excerpts[index].Length)
                            {
                                excerpts[index] = normalized;
                            }
                        }
                    }
                    catch
                    {
                        // Keep feed summary/headline fallback
                    }
                }, token));
            }
        }

        if (enrichTasks.Count > 0)
        {
            await Task.WhenAll(enrichTasks);
        }

        var blocks = new List<string>(selected.Length);
        for (var i = 0; i < selected.Length; i++)
        {
            var item = selected[i];
            var excerpt = excerpts[i];
            blocks.Add(excerpt.Length > 0
                ? $"[{item.Source}] {EnsurePeriod(item.Title)} {EnsurePeriod(excerpt)}"
                : $"[{item.Source}] {EnsurePeriod(item.Title)}");
        }

        return blocks.ToArray();
    }

    private static (NormalizedBriefingArticle Article, int Score)[] RankArticles(
        string question,
        string[] keywords,
        NormalizedBriefingArticle[] articles)
    {
        var results = new List<(NormalizedBriefingArticle Article, int Score, int Index)>(articles.Length);

        for (var i = 0; i < articles.Length; i++)
        {
            var article = articles[i];
            var score = 0;

            foreach (var topic in article.Topics)
            {
                if (TopicMatcher.Matches(question, topic))
                {
                    score += 6;
                }
                else if (keywords.Any(kw => topic.Contains(kw, StringComparison.OrdinalIgnoreCase)))
                {
                    score += 3;
                }
            }

            foreach (var keyword in keywords)
            {
                if (article.Title.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                    score += 4;
                if (article.Summary.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                    score += 2;
                if (article.Source.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                    score += 3;
            }

            results.Add((article, score, i));
        }

        return results
            .OrderByDescending(entry => entry.Score)
            .ThenBy(entry => entry.Index)
            .Select(entry => (entry.Article, entry.Score))
            .ToArray();
    }

    private static string[] ExtractKeywords(string question)
    {
        var tokens = new string(question
                .Select(ch => char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : ' ')
                .ToArray())
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);

        return tokens
            .Where(token => token.Length >= 3 && !StopWords.Contains(token))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(10)
            .ToArray();
    }

    private static NormalizedBriefingArticle[] NormalizeArticles(BriefingQaArticleInput[]? inputs)
    {
        if (inputs is null || inputs.Length == 0) return [];

        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var results = new List<NormalizedBriefingArticle>(Math.Min(inputs.Length, 20));

        foreach (var raw in inputs)
        {
            if (raw is null) continue;
            var rawUrl = (raw.Url ?? "").Trim();
            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
                || uri.IsLoopback
                || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                || !string.IsNullOrEmpty(uri.UserInfo))
            {
                continue;
            }

            if (!seenUrls.Add(uri.AbsoluteUri)) continue;

            var title = NormalizeText(raw.Title, 240);
            if (title.Length == 0) continue;

            var source = NormalizeText(raw.Source, 120);
            if (source.Length == 0) source = uri.Host;

            var summary = NormalizeText(raw.Summary, 750);
            var topics = (raw.Topics ?? [])
                .Select(topic => NormalizeText(topic, 60))
                .Where(topic => topic.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(8)
                .ToArray();

            results.Add(new NormalizedBriefingArticle(uri.AbsoluteUri, title, source, summary, topics));
            if (results.Count >= 20) break;
        }

        return results.ToArray();
    }

    private static string NormalizeText(string? value, int maxLength)
    {
        var collapsed = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return collapsed.Length <= maxLength ? collapsed : collapsed[..maxLength].TrimEnd();
    }
}
