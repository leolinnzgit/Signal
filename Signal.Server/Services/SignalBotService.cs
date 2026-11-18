using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed record SignalBotArticleInput(
    string? Url,
    string? Title,
    string? Source,
    string? Summary,
    string? PublishedAt = null,
    string[]? Topics = null);

public sealed record SignalBotHistoryTurn(
    string? Role,
    string? Content);

public sealed record SignalBotAnalyzeRequest(
    string? Topic,
    string? Prompt,
    SignalBotArticleInput[]? Articles = null,
    SignalBotHistoryTurn[]? History = null,
    string? TickerOverride = null,
    string? Language = "en",
    bool IncludeLiveSearch = true,
    string? Model = null);

public sealed record SignalBotCitation(
    int Index,
    string Url,
    string Title,
    string Source,
    string PublishedAt,
    string Summary);

public sealed record SignalBotMarketSnapshot(
    string Symbol,
    string Name,
    string Exchange,
    string Currency,
    decimal Price,
    decimal Change,
    decimal PercentChange,
    string QuoteTime);

public sealed record SignalBotAnalyzeResponse(
    bool Available,
    string Topic,
    string Headline,
    string Analysis,
    string[] KeyDrivers,
    string[] Perspectives,
    string[] WatchNext,
    string Sentiment,
    string[] SuggestedFollowUps,
    SignalBotCitation[] Citations,
    SignalBotMarketSnapshot? MarketQuote,
    string Model,
    string Language,
    DateTimeOffset AnalyzedAt,
    string CoverageNote);

public sealed class SignalBotService(
    MicrosoftFoundryService foundry,
    SignalDbContext database,
    NewsService newsService,
    ArticleReaderService articleReader,
    MarketDataService marketData,
    ILogger<SignalBotService> logger)
{
    private const int MaxClientArticles = 80;
    private const int MaxDbArticles = 150;
    private const int MaxSelectedArticles = 10;
    private const int MaxHistoryTurns = 8;

    private static readonly HashSet<string> AllowedSentiments = new(StringComparer.OrdinalIgnoreCase)
    {
        "bullish", "bearish", "mixed", "neutral", "urgent",
    };

    private static readonly IReadOnlyDictionary<string, string> LanguageNames =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["en"] = "English",
            ["zh-Hans"] = "Simplified Chinese",
            ["zh-Hant"] = "Traditional Chinese",
            ["ja"] = "Japanese",
            ["ko"] = "Korean",
            ["fr"] = "French",
            ["de"] = "German",
            ["es"] = "Spanish",
            ["it"] = "Italian",
            ["pt"] = "Portuguese",
            ["ar"] = "Arabic",
            ["hi"] = "Hindi",
        };

    private static readonly Regex KeywordSplitRegex = new(
        @"[\p{L}\p{N}]+",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly HashSet<string> QueryStopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "about", "after", "analyze", "analysis", "and", "are", "before", "between", "brief", "briefing",
        "can", "could", "current", "deep", "dive", "explain", "for", "from", "give", "how", "impact",
        "into", "latest", "main", "more", "news", "now", "over", "perspective", "perspectives", "please",
        "recent", "right", "risk", "risks", "signal", "some", "story", "stories", "summarize", "summary",
        "tell", "that", "the", "their", "them", "these", "this", "those", "today", "topic", "trending",
        "update", "updates", "watch", "what", "when", "where", "which", "who", "why", "will", "with",
    };

    internal sealed class EvidenceCandidate
    {
        public string Url { get; set; } = "";
        public string Title { get; set; } = "";
        public string Source { get; set; } = "";
        public string PublishedAt { get; set; } = "";
        public DateTimeOffset SortTime { get; set; } = DateTimeOffset.MinValue;
        public string Summary { get; set; } = "";
        public string Excerpt { get; set; } = "";
        public string[] Topics { get; set; } = [];
        public bool FromLiveSearch { get; set; }
        public double Score { get; set; }
    }

    internal sealed record StructuredAnalysis(
        string Headline,
        string Analysis,
        string[] KeyDrivers,
        string[] Perspectives,
        string[] WatchNext,
        string Sentiment,
        string[] SuggestedFollowUps);

    public async Task<SignalBotAnalyzeResponse> AnalyzeTopicAsync(
        string userId,
        SignalBotAnalyzeRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(userId))
        {
            throw new ArgumentException("A signed-in account is required.", nameof(userId));
        }

        var rawTopic = NormalizeText(request.Topic, 100);
        var prompt = NormalizeText(request.Prompt, 1200);
        var isAllTopics = IsAllTopics(rawTopic);
        var effectiveTopic = isAllTopics ? "All followed topics" : rawTopic;

        if (rawTopic.Length == 0 && prompt.Length == 0)
        {
            throw new ArgumentException("Choose a news topic or enter a question for Signal Bot to analyze.");
        }

        if (!foundry.Enabled)
        {
            throw new FoundryServiceException(
                "Microsoft Foundry has not been configured for Signal Bot yet.",
                StatusCodes.Status503ServiceUnavailable);
        }

        var selectedDeployment = foundry.ResolveDeployment(request.Model);
        var language = NormalizeLanguage(request.Language);
        var effectivePrompt = prompt.Length > 0
            ? prompt
            : $"Provide a structured intelligence analysis of the latest developments on {effectiveTopic}, including main drivers, competing perspectives or risks, and what to monitor next.";

        var history = NormalizeHistory(request.History);
        var now = DateTimeOffset.UtcNow;

        var (selected, localMatchedCount, liveAddedCount) = await GatherEvidenceAsync(
            userId,
            rawTopic,
            isAllTopics,
            effectivePrompt,
            request.Articles,
            request.IncludeLiveSearch,
            now,
            cancellationToken);

        var enrichedCount = await EnrichTopArticlesAsync(selected, cancellationToken);
        var marketQuote = await TryLoadMarketQuoteAsync(rawTopic, isAllTopics, request.TickerOverride, cancellationToken);

        var messages = BuildPromptMessages(
            effectiveTopic,
            effectivePrompt,
            language,
            selected,
            marketQuote,
            history,
            now);

        var chatResult = await foundry.CompleteChatAsync(
            messages,
            new FoundryChatOptions(Temperature: 0.25, MaxTokens: 1300, JsonObjectResponse: true, Deployment: selectedDeployment),
            cancellationToken);

        var structured = ParseStructuredResponse(chatResult.Content, effectiveTopic);
        var citations = selected
            .Select((item, idx) => new SignalBotCitation(
                Index: idx + 1,
                Url: item.Url,
                Title: item.Title,
                Source: item.Source,
                PublishedAt: item.PublishedAt,
                Summary: item.Summary))
            .ToArray();

        var marketSnapshot = marketQuote is null
            ? null
            : new SignalBotMarketSnapshot(
                marketQuote.Symbol,
                marketQuote.Name,
                marketQuote.Exchange,
                marketQuote.Currency,
                marketQuote.Price,
                marketQuote.Change,
                marketQuote.PercentChange,
                marketQuote.QuoteTime);

        var coverageNote = BuildCoverageNote(selected.Count, localMatchedCount, liveAddedCount, enrichedCount, marketSnapshot);

        return new SignalBotAnalyzeResponse(
            Available: true,
            Topic: effectiveTopic,
            Headline: structured.Headline,
            Analysis: structured.Analysis,
            KeyDrivers: structured.KeyDrivers,
            Perspectives: structured.Perspectives,
            WatchNext: structured.WatchNext,
            Sentiment: structured.Sentiment,
            SuggestedFollowUps: structured.SuggestedFollowUps,
            Citations: citations,
            MarketQuote: marketSnapshot,
            Model: chatResult.Model,
            Language: language,
            AnalyzedAt: DateTimeOffset.UtcNow,
            CoverageNote: coverageNote);
    }

    private async Task<(List<EvidenceCandidate> Selected, int LocalMatchedCount, int LiveAddedCount)> GatherEvidenceAsync(
        string rawTopic,
        string rawUserIdTopic,
        bool isAllTopics,
        string prompt,
        SignalBotArticleInput[]? clientArticles,
        bool includeLiveSearch,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        // Note: first argument is userId; preserve parameter naming clarity via explicit helper calls below.
        return await GatherEvidenceCoreAsync(
            rawTopic,
            rawUserIdTopic,
            isAllTopics,
            prompt,
            clientArticles,
            includeLiveSearch,
            now,
            cancellationToken);
    }

    private async Task<(List<EvidenceCandidate> Selected, int LocalMatchedCount, int LiveAddedCount)> GatherEvidenceCoreAsync(
        string userId,
        string rawTopic,
        bool isAllTopics,
        string prompt,
        SignalBotArticleInput[]? clientArticles,
        bool includeLiveSearch,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var pool = new List<EvidenceCandidate>();

        if (clientArticles is { Length: > 0 })
        {
            foreach (var raw in clientArticles.Take(MaxClientArticles))
            {
                var candidate = NormalizeClientCandidate(raw);
                if (candidate is not null)
                {
                    pool.Add(candidate);
                }
            }
        }

        var storedRows = await database.StoredNewsArticles
            .AsNoTracking()
            .Where(item => item.UserId == userId)
            .OrderByDescending(item => item.PublishedAtUtc)
            .ThenByDescending(item => item.LastSeenAtUtc)
            .Take(MaxDbArticles)
            .Select(item => new
            {
                item.Url,
                item.Title,
                item.Source,
                item.PublishedAtUtc,
                item.Summary,
                item.FullText,
                item.TopicsJson,
            })
            .ToListAsync(cancellationToken);

        foreach (var row in storedRows)
        {
            var url = NormalizeHttpUrl(row.Url);
            var title = NormalizeText(row.Title, 240);
            if (url.Length == 0 || title.Length == 0)
            {
                continue;
            }

            var publishedUtc = DateTime.SpecifyKind(row.PublishedAtUtc, DateTimeKind.Utc);
            var sortTime = new DateTimeOffset(publishedUtc);
            pool.Add(new EvidenceCandidate
            {
                Url = url,
                Title = title,
                Source = NormalizeText(row.Source, 100),
                PublishedAt = sortTime.ToString("O", CultureInfo.InvariantCulture),
                SortTime = sortTime,
                Summary = NormalizeText(row.Summary, 800),
                Excerpt = NormalizeText(row.FullText, 1200),
                Topics = ParseTopicsJson(row.TopicsJson),
                FromLiveSearch = false,
            });
        }

        var deduped = DeduplicateCandidates(pool);
        var promptKeywords = ExtractKeywords(prompt);

        var localMatches = ScoreAndFilterCandidates(deduped, rawTopic, isAllTopics, promptKeywords, now);
        var localMatchedCount = localMatches.Count;
        var liveAddedCount = 0;

        if (includeLiveSearch && !isAllTopics && rawTopic.Length > 0 && localMatches.Count < 4)
        {
            try
            {
                using var liveTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                liveTimeout.CancelAfter(TimeSpan.FromSeconds(4));
                var liveResult = await newsService.GetGoogleNewsAsync(rawTopic, 10, liveTimeout.Token);
                var existingKeys = new HashSet<string>(deduped.Select(GetDedupeKey), StringComparer.OrdinalIgnoreCase);

                foreach (var liveArticle in liveResult.Articles)
                {
                    var url = NormalizeHttpUrl(liveArticle.Url);
                    var title = NormalizeText(liveArticle.Title, 240);
                    if (url.Length == 0 || title.Length == 0)
                    {
                        continue;
                    }

                    var candidate = new EvidenceCandidate
                    {
                        Url = url,
                        Title = title,
                        Source = NormalizeText(liveArticle.Source, 100),
                        PublishedAt = liveArticle.PublishedAt.ToString("O", CultureInfo.InvariantCulture),
                        SortTime = liveArticle.PublishedAt,
                        Summary = NormalizeText(liveArticle.Summary, 800),
                        Topics = [rawTopic],
                        FromLiveSearch = true,
                    };

                    if (existingKeys.Add(GetDedupeKey(candidate)))
                    {
                        deduped.Add(candidate);
                        liveAddedCount++;
                    }
                }

                if (liveAddedCount > 0)
                {
                    localMatches = ScoreAndFilterCandidates(deduped, rawTopic, isAllTopics, promptKeywords, now);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Optional Google News supplement skipped for Signal Bot topic {Topic}.", rawTopic);
            }
        }

        var selected = localMatches.Take(MaxSelectedArticles).ToList();
        return (selected, localMatchedCount, liveAddedCount);
    }

    internal static List<EvidenceCandidate> ScoreAndFilterCandidates(
        IEnumerable<EvidenceCandidate> candidates,
        string rawTopic,
        bool isAllTopics,
        IReadOnlyList<string> promptKeywords,
        DateTimeOffset now)
    {
        var results = new List<EvidenceCandidate>();
        foreach (var candidate in candidates)
        {
            var searchable = $"{candidate.Title} {candidate.Summary} {candidate.Excerpt} {string.Join(" ", candidate.Topics)}";
            var topicMatch = isAllTopics
                || candidate.Topics.Any(t => string.Equals(t, rawTopic, StringComparison.OrdinalIgnoreCase))
                || TopicMatcher.Matches(searchable, rawTopic);

            var promptHits = CountKeywordMatches(searchable, promptKeywords);

            if (!isAllTopics && !topicMatch)
            {
                continue;
            }

            var score = 0d;
            if (!isAllTopics && topicMatch)
            {
                score += candidate.FromLiveSearch ? 32 : 42;
                if (TopicMatcher.Matches(candidate.Title, rawTopic))
                {
                    score += 14;
                }
            }

            score += Math.Min(24, promptHits * 6);

            if (candidate.SortTime != DateTimeOffset.MinValue)
            {
                var ageHours = Math.Max(0, (now - candidate.SortTime).TotalHours);
                score += ageHours switch
                {
                    <= 12 => 18,
                    <= 24 => 14,
                    <= 72 => 9,
                    <= 168 => 4,
                    _ => 0,
                };
            }

            if (candidate.Summary.Length >= 80) score += 3;
            if (candidate.Excerpt.Length >= 200) score += 4;

            candidate.Score = score;
            results.Add(candidate);
        }

        return results
            .OrderByDescending(item => item.Score)
            .ThenByDescending(item => item.SortTime)
            .ToList();
    }

    private async Task<int> EnrichTopArticlesAsync(
        IReadOnlyList<EvidenceCandidate> selected,
        CancellationToken cancellationToken)
    {
        var enriched = 0;
        var candidates = selected
            .Where(item => item.Excerpt.Length < 200 && item.Url.Length > 0)
            .Take(2)
            .ToArray();

        if (candidates.Length == 0)
        {
            return 0;
        }

        foreach (var candidate in candidates)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromMilliseconds(2500));
                var result = await articleReader.ReadAsync(candidate.Url, timeout.Token);
                if (result.Available && result.Article is { Paragraphs.Count: > 0 } extracted)
                {
                    var joined = string.Join(" ", extracted.Paragraphs.Take(5));
                    var snippet = NormalizeText(joined, 950);
                    if (snippet.Length > candidate.Summary.Length)
                    {
                        candidate.Excerpt = snippet;
                        enriched++;
                    }
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipped full-article enrichment for {Url}.", candidate.Url);
            }
        }

        return enriched;
    }

    private async Task<MarketQuote?> TryLoadMarketQuoteAsync(
        string rawTopic,
        bool isAllTopics,
        string? tickerOverride,
        CancellationToken cancellationToken)
    {
        if (!marketData.IsConfigured || isAllTopics || rawTopic.Length == 0)
        {
            return null;
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(2500));
            return await marketData.GetForTopicAsync(rawTopic, tickerOverride, timeout.Token, includeSparkline: false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Skipped optional market quote lookup for Signal Bot topic {Topic}.", rawTopic);
            return null;
        }
    }

    internal static IReadOnlyList<FoundryMessage> BuildPromptMessages(
        string effectiveTopic,
        string effectivePrompt,
        string language,
        IReadOnlyList<EvidenceCandidate> selected,
        MarketQuote? marketQuote,
        IReadOnlyList<SignalBotHistoryTurn> history,
        DateTimeOffset now)
    {
        var languageName = LanguageNames.GetValueOrDefault(language, "English");
        var systemPrompt = new StringBuilder();
        systemPrompt.AppendLine("You are Signal Bot, an analytical news intelligence assistant embedded inside the Signal news monitor.");
        systemPrompt.AppendLine($"Current UTC timestamp: {now:yyyy-MM-dd HH:mm} UTC.");
        systemPrompt.AppendLine($"Target topic focus: {effectiveTopic}");
        systemPrompt.AppendLine($"Response language: {languageName} ({language}). Write all user-facing JSON text values in {languageName}.");
        systemPrompt.AppendLine();
        systemPrompt.AppendLine("Rules:");
        systemPrompt.AppendLine("1. Ground factual statements in the numbered Evidence Articles [S1]..[Sn] and optional Market Snapshot below.");
        systemPrompt.AppendLine("2. Cite sources inline as [S1], [S2], etc. whenever making factual claims from articles.");
        systemPrompt.AppendLine("3. Do not invent URLs, quotes, dates, metrics, or events absent from the provided context.");
        systemPrompt.AppendLine("4. If coverage is sparse, conflicting, or older than expected, clearly note the limitation in the analysis.");
        systemPrompt.AppendLine("5. Respond ONLY with a valid JSON object matching this exact schema:");
        systemPrompt.AppendLine("{");
        systemPrompt.AppendLine("  \"headline\": \"concise 1-sentence analytical headline (<= 110 chars)\",");
        systemPrompt.AppendLine("  \"analysis\": \"2-4 crisp paragraphs with inline [S1] citations answering the user's request\",");
        systemPrompt.AppendLine("  \"keyDrivers\": [\"2 to 4 short bullet insights\"],");
        systemPrompt.AppendLine("  \"perspectives\": [\"0 to 3 competing angles, stakeholder impacts, or caveats\"],");
        systemPrompt.AppendLine("  \"watchNext\": [\"1 to 3 concrete catalysts or developments to watch next\"],");
        systemPrompt.AppendLine("  \"sentiment\": \"bullish | bearish | mixed | neutral | urgent\",");
        systemPrompt.AppendLine("  \"suggestedFollowUps\": [\"2 to 3 concise follow-up questions the user might ask next\"]");
        systemPrompt.AppendLine("}");

        var evidence = new StringBuilder();
        if (marketQuote is not null)
        {
            var sign = marketQuote.Change >= 0 ? "+" : "";
            var extendedSuffix = "";
            if (marketQuote.ExtendedPrice is > 0)
            {
                var sessionLabel = string.Equals(marketQuote.ExtendedSession, "pre-market", StringComparison.OrdinalIgnoreCase)
                    ? "Pre-market"
                    : "After-hours";
                var extChange = marketQuote.ExtendedChange ?? 0m;
                var extPercent = marketQuote.ExtendedPercentChange ?? 0m;
                var extSign = extChange >= 0 ? "+" : "";
                var extTimeSuffix = string.IsNullOrWhiteSpace(marketQuote.ExtendedQuoteTime)
                    ? ""
                    : $" as of {marketQuote.ExtendedQuoteTime}";
                extendedSuffix = $" | {sessionLabel}: {marketQuote.Currency} {marketQuote.ExtendedPrice.Value:F2} ({extSign}{extChange:F2}, {extSign}{extPercent:F2}%){extTimeSuffix}";
            }
            evidence.AppendLine("Market Snapshot:");
            evidence.AppendLine(
                $"- {marketQuote.Name} ({marketQuote.Symbol}" +
                $"{(string.IsNullOrWhiteSpace(marketQuote.Exchange) ? "" : $":{marketQuote.Exchange}")}): " +
                $"{marketQuote.Currency} {marketQuote.Price:F2} ({sign}{marketQuote.Change:F2}, {sign}{marketQuote.PercentChange:F2}%) as of {marketQuote.QuoteTime}{extendedSuffix}");
            evidence.AppendLine();
        }

        if (selected.Count == 0)
        {
            evidence.AppendLine($"Evidence Articles: None found in the user's current feed or history matching \"{effectiveTopic}\".");
            evidence.AppendLine("Explain clearly that there is currently no direct local or live story match for this topic in Signal, and avoid fabricating recent headlines.");
        }
        else
        {
            evidence.AppendLine($"Evidence Articles ({selected.Count}):");
            for (var i = 0; i < selected.Count; i++)
            {
                var item = selected[i];
                var published = string.IsNullOrWhiteSpace(item.PublishedAt) ? "Unknown time" : item.PublishedAt;
                var source = string.IsNullOrWhiteSpace(item.Source) ? "Unknown source" : item.Source;
                evidence.AppendLine($"[S{i + 1}] {item.Title} | Source: {source} | Published: {published}");
                if (item.Topics.Length > 0)
                {
                    evidence.AppendLine($"Topics: {string.Join(", ", item.Topics.Take(5))}");
                }
                if (!string.IsNullOrWhiteSpace(item.Summary))
                {
                    evidence.AppendLine($"Summary: {Truncate(item.Summary, 450)}");
                }
                if (!string.IsNullOrWhiteSpace(item.Excerpt))
                {
                    evidence.AppendLine($"Article Excerpt: {Truncate(item.Excerpt, 700)}");
                }
                evidence.AppendLine();
            }
        }

        var messages = new List<FoundryMessage>
        {
            new("system", systemPrompt.ToString()),
            new("user", evidence.ToString().TrimEnd()),
        };

        foreach (var turn in history)
        {
            var role = turn.Role?.Trim().ToLowerInvariant() == "assistant" ? "assistant" : "user";
            var content = NormalizeText(turn.Content, 1500);
            if (content.Length > 0)
            {
                messages.Add(new FoundryMessage(role, content));
            }
        }

        messages.Add(new FoundryMessage("user", $"Topic focus: {effectiveTopic}\nUser request: {effectivePrompt}"));
        return messages;
    }

    internal static StructuredAnalysis ParseStructuredResponse(string rawContent, string fallbackTopic)
    {
        var cleaned = StripJsonFence(rawContent);
        try
        {
            using var doc = JsonDocument.Parse(cleaned);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return BuildFallbackAnalysis(rawContent, fallbackTopic);
            }

            var headline = ReadString(root, "headline", 160);
            var analysis = ReadString(root, "analysis", 5000);
            var keyDrivers = ReadStringArray(root, "keyDrivers", 5, 280);
            var perspectives = ReadStringArray(root, "perspectives", 4, 280);
            var watchNext = ReadStringArray(root, "watchNext", 4, 260);
            var sentimentRaw = ReadString(root, "sentiment", 24).ToLowerInvariant();
            var sentiment = AllowedSentiments.Contains(sentimentRaw) ? sentimentRaw : "neutral";
            var followUps = ReadStringArray(root, "suggestedFollowUps", 4, 160);

            if (analysis.Length == 0)
            {
                return BuildFallbackAnalysis(rawContent, fallbackTopic);
            }

            if (headline.Length == 0)
            {
                headline = $"{fallbackTopic} Analysis";
            }

            return new StructuredAnalysis(
                headline,
                analysis,
                keyDrivers,
                perspectives,
                watchNext,
                sentiment,
                followUps);
        }
        catch (JsonException)
        {
            return BuildFallbackAnalysis(rawContent, fallbackTopic);
        }
    }

    private static StructuredAnalysis BuildFallbackAnalysis(string rawContent, string fallbackTopic) =>
        new(
            Headline: $"{fallbackTopic} Analysis",
            Analysis: rawContent.Trim(),
            KeyDrivers: [],
            Perspectives: [],
            WatchNext: [],
            Sentiment: "neutral",
            SuggestedFollowUps: []);

    private static string BuildCoverageNote(
        int selectedCount,
        int localMatchedCount,
        int liveAddedCount,
        int enrichedCount,
        SignalBotMarketSnapshot? marketSnapshot)
    {
        if (selectedCount == 0)
        {
            return "No matching articles were available locally or via live search.";
        }

        var parts = new List<string>
        {
            liveAddedCount > 0
                ? $"Grounded in {selectedCount} stories ({Math.Min(selectedCount, localMatchedCount)} local + {liveAddedCount} live)"
                : $"Grounded in {selectedCount} Signal {(selectedCount == 1 ? "story" : "stories")}",
        };

        if (enrichedCount > 0)
        {
            parts.Add($"read {enrichedCount} full {(enrichedCount == 1 ? "article" : "articles")}");
        }

        if (marketSnapshot is not null)
        {
            parts.Add($"live {marketSnapshot.Symbol} quote");
        }

        return string.Join(" • ", parts);
    }

    private static EvidenceCandidate? NormalizeClientCandidate(SignalBotArticleInput? input)
    {
        if (input is null) return null;
        var title = NormalizeText(input.Title, 240);
        if (title.Length == 0) return null;

        var url = NormalizeHttpUrl(input.Url);
        if (url.Length == 0) return null;

        DateTimeOffset.TryParse(
            input.PublishedAt,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var sortTime);

        var topics = (input.Topics ?? [])
            .Select(t => NormalizeText(t, 80))
            .Where(t => t.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(8)
            .ToArray();

        return new EvidenceCandidate
        {
            Url = url,
            Title = title,
            Source = NormalizeText(input.Source, 100),
            PublishedAt = sortTime != default ? sortTime.ToString("O", CultureInfo.InvariantCulture) : NormalizeText(input.PublishedAt, 64),
            SortTime = sortTime == default ? DateTimeOffset.MinValue : sortTime,
            Summary = NormalizeText(input.Summary, 800),
            Topics = topics,
            FromLiveSearch = false,
        };
    }

    private static List<EvidenceCandidate> DeduplicateCandidates(IEnumerable<EvidenceCandidate> items)
    {
        var byKey = new Dictionary<string, EvidenceCandidate>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items)
        {
            var key = GetDedupeKey(item);
            if (!byKey.TryGetValue(key, out var existing))
            {
                byKey[key] = item;
                continue;
            }

            if (item.Summary.Length > existing.Summary.Length)
            {
                existing.Summary = item.Summary;
            }
            if (item.Excerpt.Length > existing.Excerpt.Length)
            {
                existing.Excerpt = item.Excerpt;
            }
            if (item.Topics.Length > 0)
            {
                existing.Topics = existing.Topics
                    .Concat(item.Topics)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Take(10)
                    .ToArray();
            }
            if (item.SortTime > existing.SortTime)
            {
                existing.SortTime = item.SortTime;
                existing.PublishedAt = item.PublishedAt;
            }
        }

        return byKey.Values.ToList();
    }

    private static string GetDedupeKey(EvidenceCandidate item) =>
        item.Url.Length > 0
            ? item.Url.TrimEnd('/')
            : $"{item.Title.ToLowerInvariant()}|{item.Source.ToLowerInvariant()}";

    private static string[] ParseTopicsJson(string? topicsJson)
    {
        if (string.IsNullOrWhiteSpace(topicsJson)) return [];
        try
        {
            var items = JsonSerializer.Deserialize<string[]>(topicsJson);
            return items?
                .Select(t => NormalizeText(t, 80))
                .Where(t => t.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray() ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static SignalBotHistoryTurn[] NormalizeHistory(SignalBotHistoryTurn[]? rawHistory)
    {
        if (rawHistory is null || rawHistory.Length == 0) return [];

        return rawHistory
            .Where(turn => turn is not null)
            .Select(turn => new SignalBotHistoryTurn(
                string.Equals(turn.Role?.Trim(), "assistant", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
                NormalizeText(turn.Content, 1500)))
            .Where(turn => !string.IsNullOrWhiteSpace(turn.Content))
            .TakeLast(MaxHistoryTurns)
            .ToArray();
    }

    private static bool IsAllTopics(string topic) =>
        topic.Length == 0
        || string.Equals(topic, "All", StringComparison.OrdinalIgnoreCase)
        || string.Equals(topic, "All Topics", StringComparison.OrdinalIgnoreCase)
        || string.Equals(topic, "All followed topics", StringComparison.OrdinalIgnoreCase);

    internal static string NormalizeLanguage(string? requested)
    {
        var candidate = (requested ?? "").Trim();
        if (candidate.Length == 0) return "en";

        foreach (var supported in AzureTranslatorService.Languages)
        {
            if (string.Equals(supported, candidate, StringComparison.OrdinalIgnoreCase))
            {
                return supported;
            }
        }

        var normalized = candidate.ToLowerInvariant();
        if (normalized is "zh" or "zh-cn" or "zh-sg") return "zh-Hans";
        if (normalized is "zh-tw" or "zh-hk") return "zh-Hant";
        foreach (var supported in AzureTranslatorService.Languages)
        {
            if (normalized.StartsWith(supported.ToLowerInvariant() + "-", StringComparison.Ordinal))
            {
                return supported;
            }
        }

        return "en";
    }

    private static string[] ExtractKeywords(string prompt)
    {
        if (string.IsNullOrWhiteSpace(prompt)) return [];

        return KeywordSplitRegex.Matches(prompt.ToLowerInvariant())
            .Select(m => m.Value)
            .Where(token => token.Length >= 3 && !QueryStopWords.Contains(token))
            .Distinct(StringComparer.Ordinal)
            .Take(12)
            .ToArray();
    }

    private static int CountKeywordMatches(string searchable, IReadOnlyList<string> keywords)
    {
        if (keywords.Count == 0 || string.IsNullOrWhiteSpace(searchable)) return 0;
        var lower = searchable.ToLowerInvariant();
        var count = 0;
        foreach (var keyword in keywords)
        {
            if (lower.Contains(keyword, StringComparison.Ordinal))
            {
                count++;
            }
        }
        return count;
    }

    private static string StripJsonFence(string raw)
    {
        var trimmed = (raw ?? "").Trim();
        if (!trimmed.StartsWith("```", StringComparison.Ordinal)) return trimmed;

        var firstNewline = trimmed.IndexOf('\n');
        var lastFence = trimmed.LastIndexOf("```", StringComparison.Ordinal);
        if (firstNewline >= 0 && lastFence > firstNewline)
        {
            return trimmed[(firstNewline + 1)..lastFence].Trim();
        }
        return trimmed;
    }

    private static string ReadString(JsonElement root, string property, int maxLength)
    {
        if (!root.TryGetProperty(property, out var element) || element.ValueKind != JsonValueKind.String)
        {
            return "";
        }
        return NormalizeMultilineText(element.GetString(), maxLength);
    }

    private static string[] ReadStringArray(JsonElement root, string property, int maxItems, int maxLength)
    {
        if (!root.TryGetProperty(property, out var element) || element.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var items = new List<string>(maxItems);
        foreach (var entry in element.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.String) continue;
            var text = NormalizeText(entry.GetString(), maxLength);
            if (text.Length > 0)
            {
                items.Add(text);
                if (items.Count >= maxItems) break;
            }
        }
        return items.ToArray();
    }

    private static string NormalizeHttpUrl(string? raw)
    {
        var trimmed = (raw ?? "").Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return "";
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return "";
        if (uri.UserInfo.Length != 0) return "";
        return uri.AbsoluteUri;
    }

    private static string NormalizeText(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var collapsed = Regex.Replace(value.Trim(), @"\s+", " ");
        return Truncate(collapsed, maxLength);
    }

    private static string NormalizeMultilineText(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var lines = value
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n')
            .Select(line => Regex.Replace(line.Trim(), @"[ \t]+", " "));
        var joined = Regex.Replace(string.Join("\n", lines).Trim(), @"\n{3,}", "\n\n");
        return Truncate(joined, maxLength);
    }

    private static string Truncate(string value, int maxLength) =>
        value.Length <= maxLength ? value : value[..maxLength].TrimEnd();
}
