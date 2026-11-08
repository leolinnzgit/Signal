using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class TripwireEvaluatorService(
    SignalDbContext database,
    PushNotificationService pushNotifications,
    ILogger<TripwireEvaluatorService> logger)
{
    public static readonly TimeSpan DefaultPushCooldown = TimeSpan.FromHours(4);

    public sealed record TripwireCandidateArticle(
        string Title,
        string Url,
        string Source,
        string Summary = "",
        IReadOnlyList<string>? Topics = null);

    public sealed record TripwireMatchResult(
        string TripwireId,
        string TripwireName,
        string Severity,
        string TargetSuiteId,
        string TargetEntityId,
        string DeepLinkUrl,
        string[] MatchedKeywords,
        string MatchedTitle,
        string MatchedUrl,
        string MatchedSource);

    public static string BuildDeepLinkUrl(string targetSuiteId, string? targetEntityId)
    {
        var suite = Uri.EscapeDataString(string.IsNullOrWhiteSpace(targetSuiteId) ? "tripwires" : targetSuiteId.Trim());
        if (string.IsNullOrWhiteSpace(targetEntityId))
            return $"/?suite={suite}";
        return $"/?suite={suite}&focus={Uri.EscapeDataString(targetEntityId.Trim())}";
    }

    public static string[] ParseKeywords(string? keywordsJson)
    {
        if (string.IsNullOrWhiteSpace(keywordsJson)) return [];
        try
        {
            return (JsonSerializer.Deserialize<string[]>(keywordsJson) ?? [])
                .Select(k => k?.Trim() ?? "")
                .Where(k => k.Length >= 2)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static TripwireMatchResult? MatchArticleSet(
        string tripwireId,
        string name,
        string[] keywords,
        string severity,
        string targetSuiteId,
        string? targetEntityId,
        IReadOnlyList<TripwireCandidateArticle> articles)
    {
        if (keywords.Length == 0 || articles.Count == 0) return null;

        foreach (var article in articles)
        {
            var haystack = string.Join(
                " ",
                article.Title ?? "",
                article.Summary ?? "",
                string.Join(" ", article.Topics ?? []));
            if (string.IsNullOrWhiteSpace(haystack)) continue;

            var matched = new List<string>();
            foreach (var keyword in keywords)
            {
                var pattern = $@"\b{Regex.Escape(keyword)}\b";
                if (Regex.IsMatch(haystack, pattern, RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(250)))
                {
                    matched.Add(keyword);
                }
            }

            if (matched.Count > 0)
            {
                return new TripwireMatchResult(
                    TripwireId: tripwireId,
                    TripwireName: name,
                    Severity: severity,
                    TargetSuiteId: targetSuiteId,
                    TargetEntityId: targetEntityId ?? "",
                    DeepLinkUrl: BuildDeepLinkUrl(targetSuiteId, targetEntityId),
                    MatchedKeywords: matched.ToArray(),
                    MatchedTitle: article.Title ?? "",
                    MatchedUrl: article.Url ?? "",
                    MatchedSource: article.Source ?? "");
            }
        }

        return null;
    }

    public async Task<IReadOnlyList<TripwireMatchResult>> EvaluateAndNotifyAsync(
        string userId,
        IReadOnlyCollection<StoredNewsArticle> newArticles,
        CancellationToken cancellationToken)
    {
        if (newArticles.Count == 0 || string.IsNullOrWhiteSpace(userId)) return [];

        var tripwires = await database.ExecutiveTripwires
            .Where(t => t.UserId == userId && t.Enabled)
            .ToListAsync(cancellationToken);

        if (tripwires.Count == 0) return [];

        var candidates = newArticles
            .Select(a => new TripwireCandidateArticle(
                a.Title,
                a.Url,
                a.Source,
                a.Summary,
                ParseTopicsSafe(a.TopicsJson)))
            .ToArray();

        var now = DateTime.UtcNow;
        var results = new List<TripwireMatchResult>();
        var pushAlerts = new List<PushNotificationService.TripwirePushAlert>();

        foreach (var tripwire in tripwires)
        {
            var keywords = ParseKeywords(tripwire.KeywordsJson);
            var match = MatchArticleSet(
                tripwire.Id,
                tripwire.Name,
                keywords,
                tripwire.Severity,
                tripwire.TargetSuiteId,
                tripwire.TargetEntityId,
                candidates);

            if (match is null) continue;

            var withinCooldown = tripwire.LastTriggeredAtUtc.HasValue
                && (now - tripwire.LastTriggeredAtUtc.Value) < DefaultPushCooldown;

            tripwire.TriggerCount += 1;
            tripwire.LastMatchedTitle = match.MatchedTitle.Length > 500
                ? match.MatchedTitle[..500]
                : match.MatchedTitle;
            tripwire.LastMatchedUrl = match.MatchedUrl.Length > 2048
                ? match.MatchedUrl[..2048]
                : match.MatchedUrl;

            results.Add(match);

            if (!withinCooldown)
            {
                tripwire.LastTriggeredAtUtc = now;
                if (tripwire.PushOnMatch)
                {
                    pushAlerts.Add(new PushNotificationService.TripwirePushAlert(
                        TripwireId: tripwire.Id,
                        Name: tripwire.Name,
                        Severity: tripwire.Severity,
                        MatchedTitle: match.MatchedTitle,
                        DeepLinkUrl: match.DeepLinkUrl,
                        BadgeCount: results.Count));
                }
            }
        }

        if (results.Count > 0)
        {
            await database.SaveChangesAsync(cancellationToken);
        }

        if (pushAlerts.Count > 0)
        {
            try
            {
                await pushNotifications.SendTripwireAlertsAsync(userId, pushAlerts, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Failed to deliver tripwire push alerts for user {UserId}.", userId);
            }
        }

        return results;
    }

    private static string[] ParseTopicsSafe(string? topicsJson)
    {
        if (string.IsNullOrWhiteSpace(topicsJson)) return [];
        try
        {
            return JsonSerializer.Deserialize<string[]>(topicsJson) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
