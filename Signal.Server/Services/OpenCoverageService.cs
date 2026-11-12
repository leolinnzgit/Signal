using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed record OpenCoverageRequest(
    string? Url,
    string? Title,
    string? Source = null);

public sealed record OpenCoverageArticle(
    string Title,
    string Url,
    string Source,
    string PublishedAt,
    string Snippet,
    ReaderArticle ReaderArticle);

public sealed record OpenCoverageResponse(
    bool Available,
    string QueryUsed,
    string Message,
    OpenCoverageArticle[] Articles);

public sealed class OpenCoverageService(
    NewsService newsService,
    ArticleReaderService articleReader,
    IMemoryCache cache,
    ILogger<OpenCoverageService> logger,
    SignalDbContext? database = null)
{
    private const int MaxCandidatesToProbe = 10;
    private const int MaxVerifiedResults = 4;
    private const int MaxProbeConcurrency = 4;

    private static readonly Regex TokenSplitRegex = new(
        @"[\p{L}\p{N}]+(?:[.’'][\p{L}\p{N}]+)?",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex WhiteSpaceRegex = new(
        @"\s+",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly HashSet<string> StopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "a", "about", "after", "again", "against", "all", "also", "amid", "amidst", "an", "and", "any",
        "are", "as", "at", "be", "because", "been", "before", "being", "between", "both", "but", "by",
        "can", "confirmed", "confirms", "confirm", "could", "did", "do", "does", "doing", "down",
        "during", "each", "exclusive", "far", "few", "first", "for", "from", "further", "had", "has",
        "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into",
        "is", "it", "its", "just", "know", "latest", "live", "may", "me", "more", "most", "my", "new",
        "news", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "opinion", "or", "other",
        "our", "out", "over", "own", "plan", "plans", "planned", "report", "reported", "reports",
        "reveal", "reveals", "revealed", "said", "same", "say", "says", "set", "she", "should", "so",
        "some", "story", "such", "than", "that", "the", "their", "them", "then", "there", "these",
        "they", "this", "those", "through", "to", "too", "under", "until", "up", "update", "updates",
        "very", "via", "video", "was", "watch", "we", "were", "what", "when", "where", "which",
        "while", "who", "whom", "why", "will", "with", "would", "you", "your",
    };

    private sealed record SearchCandidate(
        string Title,
        string Url,
        string Source,
        DateTimeOffset PublishedAt,
        string Summary,
        double Score = 0);

    public async Task<OpenCoverageResponse> FindOpenCoverageAsync(
        string userId,
        OpenCoverageRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var title = NormalizeTitle(request.Title);
        var source = NormalizeText(request.Source, 120);
        var rawUrl = (request.Url ?? "").Trim();
        if (rawUrl.Length > 0)
        {
            await ArticleReaderService.ValidatePublicArticleUriAsync(rawUrl, cancellationToken);
        }

        if (title.Length < 3)
        {
            throw new ArgumentException("A story headline of at least 3 characters is required.");
        }

        var cacheKey = $"open-coverage:{ArticleIdentity.GetStoryUrlKey(rawUrl)}:{ArticleIdentity.GetHeadlineKey(title)}";
        if (cache.TryGetValue(cacheKey, out OpenCoverageResponse? cached) && cached is not null)
        {
            return cached;
        }

        var resolvedOriginalUrl = await ResolveOriginalUrlBestEffortAsync(rawUrl, cancellationToken);
        var expandedTitle = GetExpandedHeadline(rawUrl, resolvedOriginalUrl);
        var slugTokens = ExtractSlugTokens(resolvedOriginalUrl ?? rawUrl);
        var queries = BuildSearchQueries(title, expandedTitle, slugTokens);

        if (queries.Count == 0)
        {
            return new OpenCoverageResponse(
                false,
                "",
                "Not enough searchable keywords were found in this headline.",
                []);
        }

        var primaryQuery = queries[0];
        var pool = new List<SearchCandidate>();

        if (database is not null && !string.IsNullOrWhiteSpace(userId))
        {
            await AddLocalStoredCandidatesAsync(userId, pool, cancellationToken);
        }

        await RunLiveSearchQueriesAsync(queries, pool, cancellationToken);

        var targetTokens = BuildTargetTokenSet(title, expandedTitle, slugTokens);
        var properTokens = ExtractProperTokens(title, expandedTitle, slugTokens);

        // If the original headline was truncated (e.g., missing the airline/entity) and no expanded
        // headline was cached yet, check whether search results returned a fuller matching headline
        // from the same story and run one targeted refinement search using the newly discovered entities.
        if (string.IsNullOrWhiteSpace(expandedTitle))
        {
            var discoveredEntities = DiscoverRefinementTokens(title, source, pool, targetTokens);
            if (discoveredEntities.Count > 0)
            {
                foreach (var entity in discoveredEntities)
                {
                    targetTokens.Add(NormalizeMatchToken(entity));
                    properTokens.Add(NormalizeMatchToken(entity));
                }

                var refinedQuery = string.Join(" ", discoveredEntities.Concat(ExtractKeywords(title)).Distinct(StringComparer.OrdinalIgnoreCase).Take(6));
                if (!queries.Contains(refinedQuery, StringComparer.OrdinalIgnoreCase))
                {
                    primaryQuery = refinedQuery;
                    await RunLiveSearchQueriesAsync([refinedQuery], pool, cancellationToken);
                }
            }
        }

        var excludedUrlKeys = BuildExcludedUrlKeys(rawUrl, resolvedOriginalUrl);
        var excludedHeadlineKey = ArticleIdentity.GetHeadlineKey(title);
        var excludedExpandedHeadlineKey = ArticleIdentity.GetHeadlineKey(expandedTitle);

        var ranked = RankCandidates(
            pool,
            excludedUrlKeys,
            excludedHeadlineKey,
            excludedExpandedHeadlineKey,
            source,
            resolvedOriginalUrl ?? rawUrl,
            targetTokens,
            properTokens,
            DateTimeOffset.UtcNow);

        var verified = await VerifyReadableCandidatesAsync(
            ranked.Take(MaxCandidatesToProbe).ToArray(),
            excludedUrlKeys,
            targetTokens,
            cancellationToken);

        var response = verified.Length > 0
            ? new OpenCoverageResponse(
                true,
                primaryQuery,
                $"Found {verified.Length} readable open {(verified.Length == 1 ? "report" : "reports")} covering this story.",
                verified)
            : new OpenCoverageResponse(
                false,
                primaryQuery,
                "No readable open coverage was found for this headline yet. You can still read on the publisher's website or ask Signal Bot.",
                []);

        cache.Set(cacheKey, response, response.Available ? TimeSpan.FromMinutes(15) : TimeSpan.FromMinutes(3));
        return response;
    }

    private async Task<string?> ResolveOriginalUrlBestEffortAsync(string rawUrl, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(rawUrl)) return null;
        var cached = articleReader.GetCachedResolvedUrl(rawUrl);
        if (!string.IsNullOrWhiteSpace(cached)) return cached;
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri) || !GoogleNewsArticleUrl.IsRedirectPage(uri))
            return rawUrl;

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(2500));
            return await articleReader.ResolveUrlAsync(rawUrl, timeout.Token);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch
        {
            return rawUrl;
        }
    }

    private string? GetExpandedHeadline(string rawUrl, string? resolvedOriginalUrl)
    {
        if (!string.IsNullOrWhiteSpace(resolvedOriginalUrl))
        {
            var resolvedHeadline = articleReader.GetCachedPublicHeadline(resolvedOriginalUrl);
            if (!string.IsNullOrWhiteSpace(resolvedHeadline)) return resolvedHeadline;
        }
        return !string.IsNullOrWhiteSpace(rawUrl)
            ? articleReader.GetCachedPublicHeadline(rawUrl)
            : null;
    }

    private async Task AddLocalStoredCandidatesAsync(
        string userId,
        List<SearchCandidate> pool,
        CancellationToken cancellationToken)
    {
        try
        {
            var rows = await database!.StoredNewsArticles
                .AsNoTracking()
                .Where(item => item.UserId == userId)
                .OrderByDescending(item => item.PublishedAtUtc)
                .ThenByDescending(item => item.LastSeenAtUtc)
                .Take(200)
                .Select(item => new
                {
                    item.Title,
                    item.Url,
                    item.Source,
                    item.PublishedAtUtc,
                    item.Summary,
                })
                .ToListAsync(cancellationToken);

            foreach (var row in rows)
            {
                if (string.IsNullOrWhiteSpace(row.Url) || string.IsNullOrWhiteSpace(row.Title)) continue;
                var publishedUtc = DateTime.SpecifyKind(row.PublishedAtUtc, DateTimeKind.Utc);
                pool.Add(new SearchCandidate(
                    NormalizeTitle(row.Title),
                    row.Url.Trim(),
                    NormalizeText(row.Source, 120),
                    new DateTimeOffset(publishedUtc),
                    NormalizeText(row.Summary, 240)));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "Skipped local article lookup during open coverage search.");
        }
    }

    private async Task RunLiveSearchQueriesAsync(
        IReadOnlyList<string> queries,
        List<SearchCandidate> pool,
        CancellationToken cancellationToken)
    {
        var tasks = new List<Task<IReadOnlyList<NewsArticle>>>();
        foreach (var query in queries)
        {
            tasks.Add(RunSafeSearchAsync(token => newsService.SearchBingNewsKeywordsAsync(query, 10, token), cancellationToken));
            tasks.Add(RunSafeSearchAsync(token => newsService.SearchGoogleNewsKeywordsAsync(query, 10, token), cancellationToken));
        }

        var results = await Task.WhenAll(tasks);
        foreach (var batch in results)
        {
            foreach (var article in batch)
            {
                if (string.IsNullOrWhiteSpace(article.Url) || string.IsNullOrWhiteSpace(article.Title)) continue;
                pool.Add(new SearchCandidate(
                    NormalizeTitle(article.Title),
                    article.Url.Trim(),
                    NormalizeText(article.Source, 120),
                    article.PublishedAt,
                    NormalizeText(article.Summary, 240)));
            }
        }
    }

    private async Task<IReadOnlyList<NewsArticle>> RunSafeSearchAsync(
        Func<CancellationToken, Task<IReadOnlyList<NewsArticle>>> action,
        CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            return await action(timeout.Token);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Open coverage search provider call failed.");
            return [];
        }
    }

    private async Task<OpenCoverageArticle[]> VerifyReadableCandidatesAsync(
        SearchCandidate[] candidates,
        HashSet<string> excludedUrlKeys,
        HashSet<string> targetTokens,
        CancellationToken cancellationToken)
    {
        if (candidates.Length == 0) return [];

        using var overallTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        overallTimeout.CancelAfter(TimeSpan.FromSeconds(12));

        using var throttle = new SemaphoreSlim(MaxProbeConcurrency);
        var probed = new OpenCoverageArticle?[candidates.Length];

        var tasks = candidates.Select(async (candidate, index) =>
        {
            await throttle.WaitAsync(overallTimeout.Token);
            try
            {
                using var perCandidateTimeout = CancellationTokenSource.CreateLinkedTokenSource(overallTimeout.Token);
                perCandidateTimeout.CancelAfter(TimeSpan.FromSeconds(6));
                var result = await articleReader.ReadAsync(candidate.Url, perCandidateTimeout.Token);
                if (!result.Available || result.Article is not { Paragraphs.Count: > 0 } extracted)
                    return;

                var finalUrlKey = ArticleIdentity.GetStoryUrlKey(extracted.FinalUrl);
                if (finalUrlKey.Length > 0 && excludedUrlKeys.Contains(finalUrlKey))
                    return;

                var bodySample = $"{candidate.Title} {string.Join(" ", extracted.Paragraphs.Take(2))}";
                var sampleTokens = TokenizeForMatch(bodySample);
                if (targetTokens.Count > 0 && !targetTokens.Any(sampleTokens.Contains))
                    return;

                var resolvedSource = !string.IsNullOrWhiteSpace(candidate.Source)
                    ? candidate.Source
                    : !string.IsNullOrWhiteSpace(extracted.SiteName)
                        ? extracted.SiteName
                        : HostDisplayName(extracted.FinalUrl);

                var resolvedPublished = !string.IsNullOrWhiteSpace(extracted.PublishedAt)
                    ? extracted.PublishedAt
                    : candidate.PublishedAt.ToString("O", CultureInfo.InvariantCulture);

                probed[index] = new OpenCoverageArticle(
                    candidate.Title,
                    extracted.FinalUrl,
                    resolvedSource,
                    resolvedPublished,
                    BuildSnippet(extracted.Paragraphs, candidate.Summary),
                    extracted);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipped open coverage candidate {Url}.", candidate.Url);
            }
            finally
            {
                throttle.Release();
            }
        });

        try
        {
            await Task.WhenAll(tasks);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // Keep whichever candidates finished before the overall probe budget elapsed.
        }

        var accepted = new List<OpenCoverageArticle>(MaxVerifiedResults);
        var seenFinalKeys = new HashSet<string>(excludedUrlKeys, StringComparer.OrdinalIgnoreCase);
        var seenHeadlines = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var item in probed)
        {
            if (item is null) continue;
            var finalKey = ArticleIdentity.GetStoryUrlKey(item.Url);
            var headlineKey = ArticleIdentity.GetHeadlineKey(item.Title);
            if ((finalKey.Length > 0 && !seenFinalKeys.Add(finalKey))
                || (headlineKey.Length > 0 && !seenHeadlines.Add(headlineKey)))
            {
                continue;
            }
            accepted.Add(item);
            if (accepted.Count >= MaxVerifiedResults) break;
        }

        return [.. accepted];
    }

    internal static IReadOnlyList<string> BuildSearchQueries(
        string title,
        string? expandedTitle,
        IReadOnlyList<string> slugTokens)
    {
        var baseKeywords = ExtractKeywords(title);
        var expandedKeywords = !string.IsNullOrWhiteSpace(expandedTitle)
            ? ExtractKeywords(expandedTitle)
            : [];

        var merged = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void AddUnique(IEnumerable<string> tokens)
        {
            foreach (var token in tokens)
            {
                var normalized = NormalizeMatchToken(token);
                if (normalized.Length < 2 || !seen.Add(normalized)) continue;
                merged.Add(token);
            }
        }

        // Put core original headline keywords first, then newly discovered proper nouns/slug terms.
        AddUnique(baseKeywords);
        AddUnique(expandedKeywords.Where(IsHighSignalToken));
        AddUnique(slugTokens.Where(token => token.Length >= 4));
        AddUnique(expandedKeywords);

        var queries = new List<string>(2);
        if (merged.Count > 0)
        {
            queries.Add(string.Join(" ", merged.Take(6)));
        }

        if (baseKeywords.Count > 0)
        {
            var baseQuery = string.Join(" ", baseKeywords.Take(5));
            if (!queries.Contains(baseQuery, StringComparer.OrdinalIgnoreCase))
            {
                queries.Add(baseQuery);
            }
        }

        return queries;
    }

    internal static List<string> ExtractKeywords(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        var clean = StripPublisherSuffix(text);
        var rawTokens = new List<string>();

        foreach (Match match in TokenSplitRegex.Matches(clean))
        {
            var token = match.Value.Trim('’', '\'', '.');
            if (token.Length < 2) continue;
            if (StopWords.Contains(token)) continue;
            rawTokens.Add(token);
        }

        if (rawTokens.Count > 0) return rawTokens;

        // Fallback if every word was classified as a stopword
        return TokenSplitRegex.Matches(clean)
            .Select(m => m.Value.Trim('’', '\'', '.'))
            .Where(t => t.Length >= 2)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<string> ExtractSlugTokens(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return [];
        if (GoogleNewsArticleUrl.IsRedirectPage(uri))
            return [];

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var bestSlug = segments
            .Where(s => s.Contains('-') && s.Length >= 15)
            .OrderByDescending(s => s.Length)
            .FirstOrDefault();
        if (string.IsNullOrWhiteSpace(bestSlug)) return [];

        return bestSlug.Split('-', StringSplitOptions.RemoveEmptyEntries)
            .Where(part => part.Length >= 3 && !StopWords.Contains(part) && !part.All(char.IsDigit))
            .ToList();
    }

    private static List<string> DiscoverRefinementTokens(
        string originalTitle,
        string originalSource,
        IReadOnlyList<SearchCandidate> pool,
        HashSet<string> existingTargetTokens)
    {
        var originalHeadlineKey = ArticleIdentity.GetHeadlineKey(originalTitle);
        var discovered = new List<string>();
        var seen = new HashSet<string>(existingTargetTokens, StringComparer.OrdinalIgnoreCase);

        foreach (var candidate in pool)
        {
            var candidateTokens = TokenizeForMatch(candidate.Title);
            if (candidateTokens.Count == 0) continue;
            var overlap = existingTargetTokens.Count(candidateTokens.Contains);
            var sameSource = !string.IsNullOrWhiteSpace(originalSource)
                && candidate.Source.Contains(originalSource, StringComparison.OrdinalIgnoreCase);

            if (!sameSource && overlap < Math.Min(2, existingTargetTokens.Count)) continue;
            if (ArticleIdentity.GetHeadlineKey(candidate.Title) == originalHeadlineKey) continue;

            foreach (var token in ExtractKeywords(candidate.Title))
            {
                if (!IsHighSignalToken(token)) continue;
                var norm = NormalizeMatchToken(token);
                if (norm.Length < 3 || !seen.Add(norm)) continue;
                discovered.Add(token);
                if (discovered.Count >= 3) return discovered;
            }
        }

        return discovered;
    }

    private static List<SearchCandidate> RankCandidates(
        IReadOnlyList<SearchCandidate> pool,
        HashSet<string> excludedUrlKeys,
        string excludedHeadlineKey,
        string excludedExpandedHeadlineKey,
        string excludedSource,
        string resolvedOriginalUrl,
        HashSet<string> targetTokens,
        HashSet<string> properTokens,
        DateTimeOffset now)
    {
        var excludedHost = Uri.TryCreate(resolvedOriginalUrl, UriKind.Absolute, out var origUri)
            ? origUri.DnsSafeHost.Replace("www.", "", StringComparison.OrdinalIgnoreCase)
            : "";

        var deduped = new Dictionary<string, SearchCandidate>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in pool)
        {
            var urlKey = ArticleIdentity.GetStoryUrlKey(candidate.Url);
            if (urlKey.Length == 0 || excludedUrlKeys.Contains(urlKey)) continue;

            if (Uri.TryCreate(candidate.Url, UriKind.Absolute, out var candUri)
                && excludedHost.Length > 0
                && candUri.DnsSafeHost.Replace("www.", "", StringComparison.OrdinalIgnoreCase)
                    .Equals(excludedHost, StringComparison.OrdinalIgnoreCase)
                && (candUri.AbsolutePath.Contains("/premium/", StringComparison.OrdinalIgnoreCase)
                    || candUri.AbsolutePath.Contains("/subscriber/", StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            var headlineKey = ArticleIdentity.GetHeadlineKey(candidate.Title);
            if (headlineKey.Length == 0) continue;

            var sameSource = !string.IsNullOrWhiteSpace(excludedSource)
                && candidate.Source.Contains(excludedSource, StringComparison.OrdinalIgnoreCase);
            if (sameSource && (headlineKey == excludedHeadlineKey || headlineKey == excludedExpandedHeadlineKey))
                continue;

            var candidateTokens = TokenizeForMatch($"{candidate.Title} {candidate.Summary}");
            var titleTokens = TokenizeForMatch(candidate.Title);
            if (titleTokens.Count == 0) continue;

            var titleShared = targetTokens.Count(titleTokens.Contains);
            var totalShared = targetTokens.Count(candidateTokens.Contains);
            var properShared = properTokens.Count(candidateTokens.Contains);
            var minRequired = targetTokens.Count <= 2 ? 1 : 2;
            if (totalShared < minRequired || (titleShared == 0 && properShared == 0)) continue;

            var union = targetTokens.Count + titleTokens.Count - titleShared;
            var jaccard = union > 0 ? (double)titleShared / union : 0;
            if (targetTokens.Count >= 3 && titleShared < 2 && jaccard < 0.14 && properShared < 2)
                continue;

            var ageDays = Math.Max(0, (now - candidate.PublishedAt).TotalDays);
            var recencyScore = ageDays switch
            {
                <= 3 => 24d,
                <= 14 => 18d,
                <= 45 => 12d,
                <= 180 => 5d,
                <= 365 => 0d,
                _ => -14d,
            };

            var directLinkBonus = candidate.Url.Contains("news.google.com/", StringComparison.OrdinalIgnoreCase) ? 0d : 4d;
            var score = (titleShared * 10d) + (totalShared * 4d) + (properShared * 6d) + (jaccard * 15d) + recencyScore + directLinkBonus;

            var dedupeKey = urlKey;
            if (!deduped.TryGetValue(dedupeKey, out var existing) || score > existing.Score)
            {
                deduped[dedupeKey] = candidate with { Score = score };
            }
        }

        return deduped.Values
            .OrderByDescending(c => c.Score)
            .ThenByDescending(c => c.PublishedAt)
            .ToList();
    }

    private static HashSet<string> BuildExcludedUrlKeys(string rawUrl, string? resolvedOriginalUrl)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var rawKey = ArticleIdentity.GetStoryUrlKey(rawUrl);
        if (rawKey.Length > 0) keys.Add(rawKey);
        var resolvedKey = ArticleIdentity.GetStoryUrlKey(resolvedOriginalUrl);
        if (resolvedKey.Length > 0) keys.Add(resolvedKey);
        return keys;
    }

    private static HashSet<string> BuildTargetTokenSet(
        string title,
        string? expandedTitle,
        IReadOnlyList<string> slugTokens)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var token in ExtractKeywords(title).Concat(ExtractKeywords(expandedTitle)).Concat(slugTokens))
        {
            var normalized = NormalizeMatchToken(token);
            if (normalized.Length >= 2) set.Add(normalized);
        }
        return set;
    }

    private static HashSet<string> ExtractProperTokens(
        string title,
        string? expandedTitle,
        IReadOnlyList<string> slugTokens)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var token in ExtractKeywords(title).Concat(ExtractKeywords(expandedTitle)))
        {
            if (IsHighSignalToken(token))
            {
                var normalized = NormalizeMatchToken(token);
                if (normalized.Length >= 2) set.Add(normalized);
            }
        }
        foreach (var token in slugTokens)
        {
            var normalized = NormalizeMatchToken(token);
            if (normalized.Length >= 4) set.Add(normalized);
        }
        return set;
    }

    private static HashSet<string> TokenizeForMatch(string? text)
    {
        var tokens = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var keyword in ExtractKeywords(text))
        {
            var normalized = NormalizeMatchToken(keyword);
            if (normalized.Length >= 2) tokens.Add(normalized);
        }
        return tokens;
    }

    private static string NormalizeMatchToken(string token)
    {
        var lower = token.Trim().ToLowerInvariant();
        if (lower.EndsWith("'s", StringComparison.Ordinal) || lower.EndsWith("’s", StringComparison.Ordinal))
            lower = lower[..^2];
        if (lower.Length > 4 && lower.EndsWith('s') && !lower.EndsWith("ss", StringComparison.Ordinal))
            lower = lower[..^1];
        return lower;
    }

    private static bool IsHighSignalToken(string token) =>
        token.Length >= 2 && (char.IsUpper(token[0]) || token.Any(char.IsDigit));

    private static string StripPublisherSuffix(string text)
    {
        var cleaned = WhiteSpaceRegex.Replace(text.Trim(), " ");
        foreach (var sep in new[] { " - ", " | " })
        {
            var idx = cleaned.LastIndexOf(sep, StringComparison.Ordinal);
            if (idx >= 12 && cleaned.Length - idx <= 35)
                return cleaned[..idx].Trim();
        }
        return cleaned;
    }

    private static string BuildSnippet(IReadOnlyList<string> paragraphs, string fallbackSummary)
    {
        var candidate = paragraphs.FirstOrDefault(p => p.Length >= 60)
            ?? paragraphs.FirstOrDefault()
            ?? fallbackSummary;
        candidate = WhiteSpaceRegex.Replace(candidate, " ").Trim();
        if (candidate.Length <= 220) return candidate;
        var cut = candidate.LastIndexOf(' ', 217);
        return (cut > 100 ? candidate[..cut] : candidate[..217]).TrimEnd() + "…";
    }

    private static string HostDisplayName(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
            ? uri.DnsSafeHost.Replace("www.", "", StringComparison.OrdinalIgnoreCase)
            : "Open source";

    private static string NormalizeTitle(string? value) =>
        NormalizeText(StripPublisherSuffix(value ?? ""), 300);

    private static string NormalizeText(string? value, int maxLength)
    {
        var normalized = WhiteSpaceRegex.Replace(value ?? "", " ").Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength].TrimEnd();
    }
}
