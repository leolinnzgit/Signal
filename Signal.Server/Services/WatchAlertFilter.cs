using System.Text.Json;
using Signal.Server.Models;

namespace Signal.Server.Services;

public static class WatchAlertFilter
{
    public static string[] Terms(string json) => JsonSerializer.Deserialize<string[]>(json) ?? [];

    public static bool Matches(StoredNewsArticle article, string[] topics, string[] keywords)
    {
        if (topics.Length == 0 && keywords.Length == 0) return true;
        var articleTopics = Terms(article.TopicsJson);
        return topics.Any(t => articleTopics.Contains(t, StringComparer.OrdinalIgnoreCase))
            || keywords.Any(k => new[] { article.Title, article.Source, article.Summary }.Concat(articleTopics)
                .Any(text => text.Contains(k, StringComparison.OrdinalIgnoreCase)));
    }

    internal static PushNotificationService.PushMessage Briefing(IEnumerable<StoredNewsArticle> articles, WatchAlertPreferences? rules)
    {
        var topics = Terms(rules?.TopicsJson ?? "[]");
        var keywords = Terms(rules?.KeywordsJson ?? "[]");
        var matching = articles.DistinctBy(a => a.Id).Where(a => Matches(a, topics, keywords)).ToArray();
        return new(matching.Length == 1 ? matching[0].Title : $"{matching.Length} new stories in Signal",
            matching.Length == 1 ? matching[0].Source : string.Join(" · ", matching.Take(3).Select(a => a.Title)),
            "/#top", 0, WatchAllowed: matching.Length > 0);
    }
}
