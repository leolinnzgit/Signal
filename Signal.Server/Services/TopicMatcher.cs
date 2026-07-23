using System.Text.RegularExpressions;
using Signal.Server.Models;

namespace Signal.Server.Services;

public static class TopicMatcher
{
    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it",
        "of", "on", "or", "that", "the", "this", "to", "was", "were", "what", "when", "where", "who", "why",
        "with",
    };

    public static bool Matches(NewsArticle article, string topic) =>
        Matches($"{article.Title} {article.Summary}", topic);

    public static bool Matches(string searchableText, string topic)
    {
        var normalizedText = Normalize(searchableText);
        var normalizedTopic = Normalize(topic);
        if (normalizedText.Length == 0 || normalizedTopic.Length == 0) return false;

        if ($" {normalizedText} ".Contains($" {normalizedTopic} ", StringComparison.Ordinal)) return true;

        var textTokens = normalizedText.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        var requiredTokens = normalizedTopic
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(token => !StopWords.Contains(token))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return requiredTokens.Length > 0 && requiredTokens.All(textTokens.Contains);
    }

    private static string Normalize(string value) =>
        Regex.Replace(value.ToLowerInvariant(), @"[^\p{L}\p{N}]+", " ").Trim();
}
