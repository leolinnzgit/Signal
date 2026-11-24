using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed partial class AudioTopicThreadService(
    ICortexNewsEmbeddings embeddings,
    ILogger<AudioTopicThreadService> logger)
{
    internal const float DefaultSemanticThreshold = 0.85f;
    internal const float DefaultAssistedSemanticThreshold = 0.83f;
    private const int MaxArticlesPerPass = 150;
    private const int MaxCacheEntries = 4000;
    private const int EvictCount = 500;
    private const int SummarySnippetLength = 240;

    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);
    private int _trimming;

    public async Task<Dictionary<string, string>> AssignThreadIdsAsync<T>(
        IReadOnlyList<T> articles,
        Func<T, string> getUrl,
        Func<T, string> getTitle,
        Func<T, string> getSummary,
        Func<T, DateTime> getPublishedAtUtc,
        TimeSpan timeBudget,
        CancellationToken cancellationToken,
        float semanticThreshold = DefaultSemanticThreshold,
        float assistedSemanticThreshold = DefaultAssistedSemanticThreshold)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (articles.Count == 0 || !embeddings.IsAvailable)
            return result;

        var items = new List<PreparedArticle>(Math.Min(articles.Count, MaxArticlesPerPass));
        foreach (var article in articles)
        {
            if (items.Count >= MaxArticlesPerPass) break;
            var url = getUrl(article);
            var title = getTitle(article);
            var publishedAt = getPublishedAtUtc(article);
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(title) || publishedAt == default)
                continue;

            var summary = getSummary(article) ?? "";
            var passage = BuildPassage(title, summary, out var cacheKey);
            var tokens = NarratedNews.ExtractCombinedTokens(title, summary);
            var eligible = IsSuitableForEnglishEmbedding(passage);
            float[]? vector = null;
            if (eligible && _cache.TryGetValue(cacheKey, out var cached))
            {
                cached.LastAccessTicks = Environment.TickCount64;
                vector = cached.Vector;
            }
            items.Add(new PreparedArticle(url, title, summary, publishedAt, passage, cacheKey, tokens, eligible)
            {
                Vector = vector,
            });
        }

        if (items.Count < 2)
            return result;

        using var budgetCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeBudget > TimeSpan.Zero)
            budgetCts.CancelAfter(timeBudget);

        foreach (var item in items)
        {
            if (!item.Eligible || item.Vector is not null) continue;
            if (budgetCts.IsCancellationRequested) break;

            try
            {
                var vector = await embeddings.EmbedAsync(item.Passage, budgetCts.Token);
                item.Vector = vector;
                CacheVector(item.CacheKey, vector);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Audio topic embedding fell back to lexical matching.");
                break;
            }
        }

        var anchors = new List<ThreadAnchor>();
        foreach (var item in items)
        {
            ThreadAnchor? matched = null;
            foreach (var anchor in anchors)
            {
                if ((anchor.PublishedAtUtc - item.PublishedAtUtc).Duration() > NarratedNews.RepeatWindow)
                    continue;

                if (anchor.Vector is not null
                    && item.Vector is not null
                    && IsSemanticMatch(anchor.Vector, anchor.Tokens, item.Vector, item.Tokens, semanticThreshold, assistedSemanticThreshold))
                {
                    matched = anchor;
                    break;
                }
            }

            if (matched is not null)
            {
                matched.Urls.Add(item.Url);
                continue;
            }

            var anchorSeed = ArticleIdentity.GetStoryUrlKey(item.Url);
            if (anchorSeed.Length == 0) anchorSeed = ArticleIdentity.GetHeadlineKey(item.Title);
            if (anchorSeed.Length == 0) anchorSeed = item.Url;

            anchors.Add(new ThreadAnchor(
                CreateThreadId(anchorSeed),
                item.PublishedAtUtc,
                item.Vector,
                item.Tokens,
                [item.Url]));
        }

        foreach (var anchor in anchors)
        {
            if (anchor.Urls.Count < 2) continue;
            foreach (var url in anchor.Urls)
                result[url] = anchor.ThreadId;
        }

        return result;
    }

    public async Task WarmCacheAsync<T>(
        IReadOnlyList<T> articles,
        Func<T, string> getTitle,
        Func<T, string> getSummary,
        TimeSpan timeBudget,
        CancellationToken cancellationToken)
    {
        if (articles.Count == 0 || !embeddings.IsAvailable) return;

        using var budgetCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeBudget > TimeSpan.Zero)
            budgetCts.CancelAfter(timeBudget);

        var count = 0;
        foreach (var article in articles)
        {
            if (++count > MaxArticlesPerPass || budgetCts.IsCancellationRequested) break;
            var title = getTitle(article);
            if (string.IsNullOrWhiteSpace(title)) continue;

            var passage = BuildPassage(title, getSummary(article) ?? "", out var cacheKey);
            if (!IsSuitableForEnglishEmbedding(passage) || _cache.ContainsKey(cacheKey)) continue;

            try
            {
                var vector = await embeddings.EmbedAsync(passage, budgetCts.Token);
                CacheVector(cacheKey, vector);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Skipped warming audio thread embedding cache.");
                break;
            }
        }
    }

    internal static bool IsSuitableForEnglishEmbedding(string text)
    {
        var asciiLetters = 0;
        var allLetters = 0;
        foreach (var ch in text)
        {
            if (!char.IsLetter(ch)) continue;
            allLetters++;
            if (ch is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z'))
                asciiLetters++;
        }

        return asciiLetters >= 3 && allLetters > 0 && (double)asciiLetters / allLetters >= 0.70;
    }

    internal static float CosineSimilarity(float[] left, float[] right)
    {
        var dot = 0f;
        var len = Math.Min(left.Length, right.Length);
        for (var i = 0; i < len; i++)
            dot += left[i] * right[i];
        return dot;
    }

    private static bool IsSemanticMatch(
        float[] anchorVector,
        HashSet<string> anchorTokens,
        float[] itemVector,
        HashSet<string> itemTokens,
        float semanticThreshold,
        float assistedSemanticThreshold)
    {
        var similarity = CosineSimilarity(anchorVector, itemVector);
        if (similarity >= semanticThreshold) return true;
        if (similarity < assistedSemanticThreshold) return false;
        return SharesAnyToken(anchorTokens, itemTokens);
    }

    private static bool SharesAnyToken(HashSet<string> left, HashSet<string> right)
    {
        if (left.Count == 0 || right.Count == 0) return false;
        var (smaller, larger) = left.Count <= right.Count ? (left, right) : (right, left);
        foreach (var token in smaller)
        {
            if (larger.Contains(token)) return true;
        }
        return false;
    }

    private static string BuildPassage(string title, string summary, out string cacheKey)
    {
        var cleanTitle = WhitespaceRegex().Replace(NarratedNews.StripPublisherSuffix(title), " ").Trim();
        var cleanSummary = WhitespaceRegex().Replace(summary.Trim(), " ").Trim();
        if (cleanSummary.Length > SummarySnippetLength)
            cleanSummary = cleanSummary[..SummarySnippetLength].TrimEnd();

        var includeSummary = cleanSummary.Length > 0
            && !cleanSummary.Equals(cleanTitle, StringComparison.OrdinalIgnoreCase)
            && !cleanTitle.Contains(cleanSummary, StringComparison.OrdinalIgnoreCase);

        var body = includeSummary ? $"{cleanTitle}\n{cleanSummary}" : cleanTitle;
        cacheKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
        return includeSummary ? $"passage: {cleanTitle}. {cleanSummary}" : $"passage: {cleanTitle}";
    }

    private static string CreateThreadId(string seed)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return $"t:{Convert.ToHexString(hash)[..12].ToLowerInvariant()}";
    }

    private void CacheVector(string key, float[] vector)
    {
        _cache[key] = new CacheEntry(key, vector, Environment.TickCount64);
        if (_cache.Count <= MaxCacheEntries || Interlocked.Exchange(ref _trimming, 1) != 0)
            return;

        try
        {
            var oldest = _cache.Values
                .OrderBy(entry => entry.LastAccessTicks)
                .Take(EvictCount)
                .Select(entry => entry.Key)
                .ToArray();
            foreach (var oldKey in oldest)
                _cache.TryRemove(oldKey, out _);
        }
        finally
        {
            Volatile.Write(ref _trimming, 0);
        }
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    private sealed class PreparedArticle(
        string url,
        string title,
        string summary,
        DateTime publishedAtUtc,
        string passage,
        string cacheKey,
        HashSet<string> tokens,
        bool eligible)
    {
        public string Url { get; } = url;
        public string Title { get; } = title;
        public string Summary { get; } = summary;
        public DateTime PublishedAtUtc { get; } = publishedAtUtc;
        public string Passage { get; } = passage;
        public string CacheKey { get; } = cacheKey;
        public HashSet<string> Tokens { get; } = tokens;
        public bool Eligible { get; } = eligible;
        public float[]? Vector { get; set; }
    }

    private sealed record ThreadAnchor(
        string ThreadId,
        DateTime PublishedAtUtc,
        float[]? Vector,
        HashSet<string> Tokens,
        List<string> Urls);

    private sealed class CacheEntry(string key, float[] vector, long lastAccessTicks)
    {
        public string Key { get; } = key;
        public float[] Vector { get; } = vector;
        public long LastAccessTicks { get; set; } = lastAccessTicks;
    }
}
