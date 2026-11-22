using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

// Apply the same conservative date, word-overlap, figure and decision checks
// as the interactive headline player before taking the scheduled lead slots.
internal static partial class NarratedNews
{
    private static readonly TimeSpan RepeatWindow = TimeSpan.FromHours(36);

    private static readonly Regex[] ChangeTerms =
    [
        ChangePattern(@"\b(?:ris(?:e[sn]?|ing)|rose|rais(?:e[sd]?|ing)|hik(?:e[sd]?|ing)|lift(?:s|ed|ing)?|increas(?:e[sd]?|ing)|gain(?:s|ed)?|up)\b"),
        ChangePattern(@"\b(?:falls?|fell|fallen|cut(?:s|ting)?|lower(?:s|ed|ing)?|decreas(?:e[sd]?|ing)|drop(?:s|ped|ping)?|down)\b"),
        ChangePattern(@"\b(?:holds?|held|unchanged|steady|paus(?:e[sd]?|ing))\b"),
        ChangePattern(@"\b(?:approv(?:e[sd]?|ing)|accept(?:s|ed|ing)?|pass(?:es|ed|ing)?)\b"),
        ChangePattern(@"\b(?:reject(?:s|ed|ing)?|den(?:y|ies|ied|ying)|fail(?:s|ed|ing)?)\b"),
        ChangePattern(@"\b(?:no|not|never|without)\b|n['’]t\b"),
    ];

    public static IEnumerable<T> DistinctStories<T>(IReadOnlyList<T> articles,
        Func<T, string> title, Func<T, string> url, Func<T, DateTime> publishedAt)
    {
        var spoken = new List<Headline>();
        foreach (var copies in ArticleIdentity.GroupDuplicates(articles, title, url))
        {
            var lead = copies[0];
            var headline = Describe(title(lead), publishedAt(lead));
            if (spoken.Any(existing => IsRepeat(existing, headline))) continue;
            spoken.Add(headline);
            yield return lead;
        }
    }

    private static Headline Describe(string title, DateTime publishedAt)
    {
        var normalized = title.Normalize(NormalizationForm.FormKC).Replace('−', '-').Replace('–', '-');
        var words = OpenCoverageService.TokenizeForMatch(normalized);
        words.RemoveWhere(word => word.Any(char.IsDigit));
        var figures = FigureRegex().Matches(normalized)
            .Select(match => FigureSeparatorRegex().Replace(match.Value, ""))
            .ToHashSet(StringComparer.Ordinal);
        var changes = ChangeTerms.Select(pattern => pattern.IsMatch(title)).ToArray();
        return new Headline(publishedAt, words, figures, changes);
    }

    private static bool IsRepeat(Headline a, Headline b)
    {
        if (a.PublishedAt == default || b.PublishedAt == default || (a.PublishedAt - b.PublishedAt).Duration() > RepeatWindow
            || !a.Figures.SetEquals(b.Figures) || !a.Changes.SequenceEqual(b.Changes)) return false;
        var shared = a.Words.Count(b.Words.Contains);
        return shared >= 4 && (double)shared / (a.Words.Count + b.Words.Count - shared) >= 0.55;
    }

    private static Regex ChangePattern(string pattern) =>
        new(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    [GeneratedRegex(@"[+\-]?(?:[$€£¥]\s*)?\d+(?:[.,]\d+)*%?")]
    private static partial Regex FigureRegex();

    [GeneratedRegex(@"[,\s]")]
    private static partial Regex FigureSeparatorRegex();

    private sealed record Headline(DateTime PublishedAt, HashSet<string> Words, HashSet<string> Figures, bool[] Changes);
}
