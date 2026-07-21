namespace Signal.Server.Models;

public sealed record NewsArticle(
    string Title,
    string Url,
    string Source,
    DateTimeOffset PublishedAt,
    string Summary,
    IReadOnlyList<string>? MatchedTopics = null);

public sealed record NewsResult(
    string Topic,
    string Provider,
    DateTimeOffset FetchedAt,
    IReadOnlyList<NewsArticle> Articles);
