using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

// Filter broader ongoing news threads for audio playback and scheduled briefings
// using headline + summary tokens, CJK bigrams, and optional semantic thread IDs.
internal static partial class NarratedNews
{
    internal static readonly TimeSpan RepeatWindow = TimeSpan.FromHours(60);
    private const int SummarySnippetLength = 280;

    private static readonly HashSet<string> StopAndBoilerplateWords = new(StringComparer.Ordinal)
    {
        "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are",
        "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
        "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
        "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
        "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most",
        "my", "myself", "new", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other",
        "our", "ours", "ourselves", "out", "over", "own", "said", "same", "say", "says", "she", "should",
        "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then",
        "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very",
        "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will",
        "with", "would", "you", "your", "yours", "yourself", "yourselves", "amid", "amidst", "first",
        "united", "state", "states", "government", "minister", "official", "officials", "people",
        "million", "billion", "percent", "world", "global", "local", "today", "week", "month", "year",
        "years", "day", "days", "time", "news", "report", "reports", "latest", "update", "updates",
        "live", "video", "watch", "breaking", "exclusive", "opinion", "analysis", "explained",
    };

    private static readonly HashSet<string> CjkFillerBigrams = new(StringComparer.Ordinal)
    {
        "表示", "指出", "報導", "报道", "最新", "新聞", "新闻", "消息", "今日", "今天", "目前", "持續", "持续", "相關", "相关",
    };

    public static IEnumerable<T> DistinctStories<T>(
        IReadOnlyList<T> articles,
        Func<T, string> title,
        Func<T, string> url,
        Func<T, DateTime> publishedAt,
        Func<T, string>? summary = null,
        Func<T, string?>? audioThreadId = null)
    {
        var spoken = new List<ThreadSignature>();
        foreach (var copies in ArticleIdentity.GroupDuplicates(articles, title, url))
        {
            var lead = copies[0];
            var leadSummary = summary is null
                ? ""
                : copies.Select(summary).FirstOrDefault(text => !string.IsNullOrWhiteSpace(text)) ?? "";
            var leadThreadId = audioThreadId is null
                ? null
                : copies.Select(audioThreadId).FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
            var signature = Describe(title(lead), leadSummary, publishedAt(lead), leadThreadId);
            if (spoken.Any(existing => IsThreadMatch(existing, signature))) continue;
            spoken.Add(signature);
            yield return lead;
        }
    }

    internal static bool IsLexicalThreadMatch(
        string titleA,
        string summaryA,
        DateTime publishedAtA,
        string titleB,
        string summaryB,
        DateTime publishedAtB)
    {
        var sigA = Describe(titleA, summaryA, publishedAtA, null);
        var sigB = Describe(titleB, summaryB, publishedAtB, null);
        return IsThreadMatch(sigA, sigB);
    }

    internal static HashSet<string> ExtractCombinedTokens(string title, string summary) =>
        ExtractTokens(BuildCombinedText(title, summary));

    internal static string StripPublisherSuffix(string title)
    {
        var cleaned = WhitespaceRegex().Replace(title.Trim(), " ");
        foreach (var separator in new[] { " - ", " | " })
        {
            var index = cleaned.LastIndexOf(separator, StringComparison.Ordinal);
            if (index >= 12 && cleaned.Length - index <= 35)
                return cleaned[..index].Trim();
        }
        return cleaned;
    }

    private static ThreadSignature Describe(string title, string summary, DateTime publishedAt, string? threadId)
    {
        var cleanTitle = StripPublisherSuffix(title);
        var combined = BuildCombinedText(cleanTitle, summary);
        var titleTokens = ExtractTokens(cleanTitle);
        var fullTokens = ExtractTokens(combined);
        var cjkTitleBigrams = ExtractCjkBigrams(cleanTitle);
        var cjkFullBigrams = ExtractCjkBigrams(combined);
        var normalizedThreadId = string.IsNullOrWhiteSpace(threadId) ? null : threadId.Trim();
        return new ThreadSignature(publishedAt, titleTokens, fullTokens, cjkTitleBigrams, cjkFullBigrams, normalizedThreadId);
    }

    private static string BuildCombinedText(string cleanTitle, string summary)
    {
        if (string.IsNullOrWhiteSpace(summary)) return cleanTitle;
        var collapsed = WhitespaceRegex().Replace(summary.Trim(), " ");
        if (collapsed.Length > SummarySnippetLength)
            collapsed = collapsed[..SummarySnippetLength];
        return $"{cleanTitle} {collapsed}";
    }

    private static bool IsThreadMatch(ThreadSignature a, ThreadSignature b)
    {
        if (a.PublishedAt == default || b.PublishedAt == default || (a.PublishedAt - b.PublishedAt).Duration() > RepeatWindow)
            return false;

        if (a.ThreadId is not null && b.ThreadId is not null && string.Equals(a.ThreadId, b.ThreadId, StringComparison.Ordinal))
            return true;

        var (titleShared, titleOverlap, titleJaccard) = MeasureOverlap(a.TitleTokens, b.TitleTokens);
        if (titleShared >= 3 && (titleOverlap >= 0.40 || titleJaccard >= 0.25))
            return true;

        var (fullShared, fullOverlap, fullJaccard) = MeasureOverlap(a.FullTokens, b.FullTokens);
        if ((fullShared >= 5 && (fullOverlap >= 0.35 || fullJaccard >= 0.22) && titleShared >= 1)
            || (fullShared >= 6 && fullOverlap >= 0.42))
        {
            return true;
        }

        var (cjkTitleShared, cjkTitleOverlap, _) = MeasureOverlap(a.CjkTitleBigrams, b.CjkTitleBigrams);
        if ((cjkTitleShared >= 3 && cjkTitleOverlap >= 0.33)
            || (cjkTitleShared >= 2 && cjkTitleOverlap >= 0.50))
        {
            return true;
        }

        var (cjkFullShared, cjkFullOverlap, _) = MeasureOverlap(a.CjkFullBigrams, b.CjkFullBigrams);
        return cjkFullShared >= 5 && cjkFullOverlap >= 0.38 && cjkTitleShared >= 1;
    }

    private static (int Shared, double Overlap, double Jaccard) MeasureOverlap(
        HashSet<string> left,
        HashSet<string> right)
    {
        if (left.Count == 0 || right.Count == 0) return (0, 0, 0);
        var (smaller, larger) = left.Count <= right.Count ? (left, right) : (right, left);
        var shared = 0;
        foreach (var token in smaller)
        {
            if (larger.Contains(token)) shared++;
        }
        if (shared == 0) return (0, 0, 0);
        var overlap = (double)shared / smaller.Count;
        var union = left.Count + right.Count - shared;
        var jaccard = union > 0 ? (double)shared / union : 0;
        return (shared, overlap, jaccard);
    }

    private static HashSet<string> ExtractTokens(string text)
    {
        var tokens = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(text)) return tokens;

        var normalized = text.Normalize(NormalizationForm.FormKC)
            .ToLowerInvariant()
            .Replace('\u2212', '-')
            .Replace('\u2013', '-')
            .Replace("'s", "", StringComparison.Ordinal)
            .Replace("’s", "", StringComparison.Ordinal)
            .Replace("'", "", StringComparison.Ordinal)
            .Replace("’", "", StringComparison.Ordinal);

        normalized = RbnzRegex().Replace(normalized, "reserve bank rbnz");
        normalized = FedRegex().Replace(normalized, "federal reserve fed");
        normalized = OcrRegex().Replace(normalized, "official cash rate ocr");
        normalized = NonDecimalDotRegex().Replace(normalized, " ");
        normalized = AllowedCharsRegex().Replace(normalized, " ");

        foreach (var rawPart in normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = rawPart.Trim('-', '.');
            if (trimmed.Length < 2 || StopAndBoilerplateWords.Contains(trimmed)) continue;

            var canonical = trimmed;
            if (canonical.Length > 3
                && canonical.EndsWith('s')
                && !canonical.EndsWith("ss", StringComparison.Ordinal)
                && !canonical.EndsWith("bps", StringComparison.Ordinal)
                && canonical.Any(char.IsLetter))
            {
                canonical = canonical[..^1];
            }

            if (canonical.Length < 2 || StopAndBoilerplateWords.Contains(canonical)) continue;
            tokens.Add(canonical);
        }

        return tokens;
    }

    private static HashSet<string> ExtractCjkBigrams(string text)
    {
        var bigrams = new HashSet<string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(text)) return bigrams;

        foreach (Match match in CjkRunRegex().Matches(text))
        {
            var run = match.Value;
            for (var i = 0; i <= run.Length - 2; i++)
            {
                var bigram = run.Substring(i, 2);
                if (!CjkFillerBigrams.Contains(bigram))
                    bigrams.Add(bigram);
            }
        }

        return bigrams;
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex(@"\brbnz\b")]
    private static partial Regex RbnzRegex();

    [GeneratedRegex(@"\bfed\b")]
    private static partial Regex FedRegex();

    [GeneratedRegex(@"\bocr\b")]
    private static partial Regex OcrRegex();

    [GeneratedRegex(@"(?<!\d)\.|\.(?!\d)")]
    private static partial Regex NonDecimalDotRegex();

    [GeneratedRegex(@"[^a-z0-9.%$€£¥-]+")]
    private static partial Regex AllowedCharsRegex();

    [GeneratedRegex(@"[\u4E00-\u9FFF]{2,}")]
    private static partial Regex CjkRunRegex();

    private sealed record ThreadSignature(
        DateTime PublishedAt,
        HashSet<string> TitleTokens,
        HashSet<string> FullTokens,
        HashSet<string> CjkTitleBigrams,
        HashSet<string> CjkFullBigrams,
        string? ThreadId);
}
