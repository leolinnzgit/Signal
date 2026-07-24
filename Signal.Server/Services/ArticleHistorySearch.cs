using Signal.Server.Models;
using System.Text.Json;

namespace Signal.Server.Services;

public static class ArticleHistorySearch
{
    private const int MaximumSearchLength = 100;

    public static string Normalize(string? value)
    {
        var normalized = string.Join(
            ' ',
            (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, MaximumSearchLength)];
    }

    public static IQueryable<StoredNewsArticle> Apply(
        IQueryable<StoredNewsArticle> query,
        string? search)
    {
        var terms = Normalize(search)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(8);

        foreach (var term in terms)
        {
            var lowered = term.ToLower();
            query = query.Where(item =>
                item.Title.ToLower().Contains(lowered)
                || item.Summary.ToLower().Contains(lowered)
                || item.Source.ToLower().Contains(lowered)
                || item.TopicsJson.ToLower().Contains(lowered)
                || item.ProvidersJson.ToLower().Contains(lowered));
        }

        return query;
    }

    public static IQueryable<StoredNewsArticle> ApplyFilters(
        IQueryable<StoredNewsArticle> query,
        string? topic,
        string? provider)
    {
        if (!string.IsNullOrWhiteSpace(topic))
        {
            var serializedTopic = JsonSerializer.Serialize(topic);
            query = query.Where(item => item.TopicsJson.Contains(serializedTopic));
        }
        if (!string.IsNullOrWhiteSpace(provider))
        {
            var serializedProvider = JsonSerializer.Serialize(provider);
            query = query.Where(item => item.ProvidersJson.Contains(serializedProvider));
        }
        return query;
    }
}
