using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed record ExecutiveBriefingPreferencesDto(
    string[] PriorityTopics,
    string Language,
    bool ScheduleEnabled,
    string ScheduleTime,
    string TimeZone,
    bool NotifyPush,
    bool DeliverEmail,
    bool PrewarmOfflinePack,
    bool AutoContinueStories,
    string LastServerDeliveredDate,
    string? PublicOrigin = null)
{
    public static ExecutiveBriefingPreferencesDto Default { get; } = new(
        [],
        "en",
        false,
        "07:00",
        "UTC",
        true,
        false,
        true,
        false,
        "",
        null);
}

public sealed record ExecutiveBriefingPreferencesPatch(
    string[]? PriorityTopics = null,
    string? Language = null,
    bool? ScheduleEnabled = null,
    string? ScheduleTime = null,
    string? TimeZone = null,
    bool? NotifyPush = null,
    bool? DeliverEmail = null,
    bool? PrewarmOfflinePack = null,
    bool? AutoContinueStories = null);

public sealed record ExecutiveBriefingDeliveryResult(
    bool SentPush,
    int PushDevicesDelivered,
    bool SentEmail,
    string? HostedSharePath,
    string LocalDateKey,
    string? Warning = null);

public sealed class ExecutiveBriefingDeliveryService(
    SignalDbContext database,
    PushNotificationService pushNotifications,
    IAccountEmailSender emailSender,
    MarketDataService marketData,
    AzureTranslatorService translator,
    IConfiguration configuration,
    ILogger<ExecutiveBriefingDeliveryService> logger,
    AudioTopicThreadService? audioThreads = null)
{
    private static readonly Regex TimeRegex = new(
        @"^([01]?\d|2[0-3]):([0-5]\d)$",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex DateKeyRegex = new(
        @"^\d{4}-\d{2}-\d{2}$",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    public static int? ParseScheduleTimeMinutes(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var match = TimeRegex.Match(value.Trim());
        if (!match.Success) return null;
        var hours = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        var mins = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        return hours * 60 + mins;
    }

    public static string NormalizeScheduleTime(string? value)
    {
        var mins = ParseScheduleTimeMinutes(value);
        if (mins is null) return "07:00";
        return $"{mins.Value / 60:D2}:{mins.Value % 60:D2}";
    }

    public static (TimeZoneInfo Zone, string NormalizedId) ResolveTimeZone(string? candidate, string? fallback = null)
    {
        foreach (var raw in new[] { candidate, fallback })
        {
            if (string.IsNullOrWhiteSpace(raw) || raw.Length > 80) continue;
            var trimmed = raw.Trim();
            if (TimeZoneInfo.TryFindSystemTimeZoneById(trimmed, out var tz))
            {
                return (tz, trimmed);
            }
        }
        return (TimeZoneInfo.Utc, "UTC");
    }

    public static string FormatLocalDateKey(DateTimeOffset utcNow, TimeZoneInfo zone)
    {
        var local = TimeZoneInfo.ConvertTime(utcNow, zone);
        return $"{local.Year:D4}-{local.Month:D2}-{local.Day:D2}";
    }

    public static ExecutiveBriefingPreferencesDto Deserialize(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json == "{}")
            return ExecutiveBriefingPreferencesDto.Default;

        try
        {
            var parsed = JsonSerializer.Deserialize<ExecutiveBriefingPreferencesDto>(json);
            if (parsed is null) return ExecutiveBriefingPreferencesDto.Default;

            var priority = NormalizePriorityTopics(parsed.PriorityTopics);
            var language = BriefingQaController.NormalizeBriefingLanguage(parsed.Language);
            var time = NormalizeScheduleTime(parsed.ScheduleTime);
            var (_, tzId) = ResolveTimeZone(parsed.TimeZone);
            var lastDate = parsed.LastServerDeliveredDate is not null && DateKeyRegex.IsMatch(parsed.LastServerDeliveredDate)
                ? parsed.LastServerDeliveredDate
                : "";
            var origin = SanitizeOrigin(parsed.PublicOrigin);

            return new ExecutiveBriefingPreferencesDto(
                priority,
                language,
                parsed.ScheduleEnabled,
                time,
                tzId,
                parsed.NotifyPush,
                parsed.DeliverEmail,
                parsed.PrewarmOfflinePack,
                parsed.AutoContinueStories,
                lastDate,
                origin);
        }
        catch (JsonException)
        {
            return ExecutiveBriefingPreferencesDto.Default;
        }
    }

    public static ExecutiveBriefingPreferencesDto MergePatch(
        ExecutiveBriefingPreferencesDto existing,
        ExecutiveBriefingPreferencesPatch? patch,
        string? weatherTimeZone,
        string? requestOrigin,
        DateTimeOffset? utcNow = null)
    {
        if (patch is null)
        {
            var preservedOrigin = SanitizeOrigin(requestOrigin) ?? existing.PublicOrigin;
            return existing with { PublicOrigin = preservedOrigin };
        }

        var now = utcNow ?? DateTimeOffset.UtcNow;
        var priority = patch.PriorityTopics is not null
            ? NormalizePriorityTopics(patch.PriorityTopics)
            : existing.PriorityTopics;
        var language = patch.Language is not null
            ? BriefingQaController.NormalizeBriefingLanguage(patch.Language)
            : existing.Language;
        var enabled = patch.ScheduleEnabled ?? existing.ScheduleEnabled;
        var scheduleTime = patch.ScheduleTime is not null
            ? NormalizeScheduleTime(patch.ScheduleTime)
            : existing.ScheduleTime;
        var (zone, tzId) = ResolveTimeZone(patch.TimeZone ?? existing.TimeZone, weatherTimeZone);
        var notifyPush = patch.NotifyPush ?? existing.NotifyPush;
        var deliverEmail = patch.DeliverEmail ?? existing.DeliverEmail;
        var prewarm = patch.PrewarmOfflinePack ?? existing.PrewarmOfflinePack;
        var autoContinue = patch.AutoContinueStories ?? existing.AutoContinueStories;
        var origin = SanitizeOrigin(requestOrigin) ?? existing.PublicOrigin;

        var lastDelivered = existing.LastServerDeliveredDate;
        var timeOrEnableChanged =
            (patch.ScheduleTime is not null && !string.Equals(scheduleTime, existing.ScheduleTime, StringComparison.Ordinal))
            || (patch.ScheduleEnabled == true && !existing.ScheduleEnabled);

        if (enabled && timeOrEnableChanged)
        {
            var scheduledMins = ParseScheduleTimeMinutes(scheduleTime) ?? 420;
            var localNow = TimeZoneInfo.ConvertTime(now, zone);
            var nowMins = localNow.Hour * 60 + localNow.Minute;
            var todayKey = $"{localNow.Year:D4}-{localNow.Month:D2}-{localNow.Day:D2}";
            if (scheduledMins < nowMins)
            {
                // Time already passed earlier today -> schedule cleanly for tomorrow
                lastDelivered = todayKey;
            }
            else if (lastDelivered == todayKey)
            {
                // Updated to a later time still upcoming today -> allow firing today
                lastDelivered = "";
            }
        }

        return new ExecutiveBriefingPreferencesDto(
            priority,
            language,
            enabled,
            scheduleTime,
            tzId,
            notifyPush,
            deliverEmail,
            prewarm,
            autoContinue,
            lastDelivered,
            origin);
    }

    public static bool IsDueAt(
        ExecutiveBriefingPreferencesDto prefs,
        DateTimeOffset utcNow,
        string? fallbackTimeZone = null,
        int catchUpMinutes = 180)
    {
        if (!prefs.ScheduleEnabled || (!prefs.NotifyPush && !prefs.DeliverEmail))
            return false;

        var (zone, _) = ResolveTimeZone(prefs.TimeZone, fallbackTimeZone);
        var localNow = TimeZoneInfo.ConvertTime(utcNow, zone);
        var todayKey = $"{localNow.Year:D4}-{localNow.Month:D2}-{localNow.Day:D2}";
        if (prefs.LastServerDeliveredDate == todayKey)
            return false;

        var scheduledMins = ParseScheduleTimeMinutes(prefs.ScheduleTime);
        if (scheduledMins is null) return false;
        var nowMins = localNow.Hour * 60 + localNow.Minute;
        return nowMins >= scheduledMins.Value && nowMins <= scheduledMins.Value + Math.Max(1, catchUpMinutes);
    }

    public async Task<int> ProcessDueScheduledBriefingsAsync(
        CancellationToken cancellationToken,
        DateTimeOffset? utcNowOverride = null)
    {
        var now = utcNowOverride ?? DateTimeOffset.UtcNow;
        var candidates = await database.UserNewsPreferences
            .AsNoTracking()
            .Where(p => p.BriefingPreferencesJson != "{}" && p.BriefingPreferencesJson != "")
            .Select(p => new { p.UserId, p.BriefingPreferencesJson, p.WeatherLocationJson })
            .Take(200)
            .ToArrayAsync(cancellationToken);

        var deliveredUsers = 0;
        foreach (var candidate in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var briefingPrefs = Deserialize(candidate.BriefingPreferencesJson);
            var weatherTz = TryExtractWeatherTimeZone(candidate.WeatherLocationJson);
            if (!IsDueAt(briefingPrefs, now, weatherTz))
                continue;

            try
            {
                var (zone, _) = ResolveTimeZone(briefingPrefs.TimeZone, weatherTz);
                var todayKey = FormatLocalDateKey(now, zone);

                // Mark delivered date first to prevent duplicate sends across ticks
                var tracked = await database.UserNewsPreferences
                    .SingleOrDefaultAsync(p => p.UserId == candidate.UserId, cancellationToken);
                if (tracked is null) continue;
                var currentPrefs = Deserialize(tracked.BriefingPreferencesJson);
                if (currentPrefs.LastServerDeliveredDate == todayKey) continue;

                var marked = currentPrefs with { LastServerDeliveredDate = todayKey };
                tracked.BriefingPreferencesJson = JsonSerializer.Serialize(marked);
                await database.SaveChangesAsync(cancellationToken);

                await DeliverAsync(
                    candidate.UserId,
                    marked.NotifyPush,
                    marked.DeliverEmail,
                    marked.PublicOrigin,
                    cancellationToken,
                    now);
                deliveredUsers++;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Scheduled executive briefing delivery failed for user {UserId}.", candidate.UserId);
            }
        }

        return deliveredUsers;
    }

    public async Task<ExecutiveBriefingDeliveryResult> DeliverAsync(
        string userId,
        bool sendPush,
        bool sendEmail,
        string? requestOrigin,
        CancellationToken cancellationToken,
        DateTimeOffset? utcNowOverride = null)
    {
        var now = utcNowOverride ?? DateTimeOffset.UtcNow;
        var user = await database.Users
            .AsNoTracking()
            .SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        var prefsRow = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(p => p.UserId == userId, cancellationToken);

        var briefingPrefs = Deserialize(prefsRow?.BriefingPreferencesJson);
        var weatherTz = TryExtractWeatherTimeZone(prefsRow?.WeatherLocationJson);
        var (zone, _) = ResolveTimeZone(briefingPrefs.TimeZone, weatherTz);
        var localNow = TimeZoneInfo.ConvertTime(now, zone);
        var todayKey = $"{localNow.Year:D4}-{localNow.Month:D2}-{localNow.Day:D2}";

        var edition = localNow.Hour < 12 ? "Morning" : localNow.Hour < 17 ? "Afternoon" : "Evening";
        var greeting = $"Good {edition.ToLowerInvariant()}";
        var formattedDate = localNow.ToString("dddd, MMMM d, yyyy", CultureInfo.InvariantCulture);

        var followedTopics = DeserializeStringArray(prefsRow?.TopicsJson);
        var tickerOverrides = DeserializeDictionary(prefsRow?.TickerOverridesJson);
        var priorityTopics = briefingPrefs.PriorityTopics;

        // 1. Rank lead stories from StoredNewsArticles (unread + priority first)
        var recentArticles = await database.StoredNewsArticles
            .AsNoTracking()
            .Where(a => a.UserId == userId)
            .OrderByDescending(a => a.PublishedAtUtc)
            .ThenByDescending(a => a.Id)
            .Take(40)
            .ToArrayAsync(cancellationToken);

        var unreadCount = recentArticles.Count(a => !a.IsRead);
        var rankedStories = recentArticles
            .Select((article, index) =>
            {
                var articleTopics = DeserializeStringArray(article.TopicsJson);
                var matchedPriority = MatchPriorityTopic(article.Title, article.Summary, articleTopics, priorityTopics);
                return (Article: article, Index: index, PriorityTopic: matchedPriority.Topic, PriorityRank: matchedPriority.Rank);
            })
            .OrderBy(item => (item.Article.IsRead ? 2 : 0) + (item.PriorityRank.HasValue ? 0 : 1))
            .ThenBy(item => item.PriorityRank ?? int.MaxValue)
            .ThenBy(item => item.Index)
            .ToArray();

        // 2. Optionally resolve watched market movers (bounded timeout)
        MarketQuote[] watchlistQuotes = [];
        if (marketData.IsConfigured && followedTopics.Length > 0)
        {
            try
            {
                using var marketTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                marketTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                var inputs = followedTopics
                    .Select(t => new MarketWatchlistTopicInput(t, tickerOverrides.GetValueOrDefault(t)))
                    .ToArray();
                watchlistQuotes = await marketData.GetWatchlistAsync(inputs, 4, marketTimeout.Token);
            }
            catch
            {
                // Proceed without market quotes if provider times out
            }
        }

        var threadIds = audioThreads is null
            ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            : await audioThreads.AssignThreadIdsAsync(
                rankedStories,
                story => story.Article.Url,
                story => story.Article.Title,
                story => story.Article.Summary,
                story => story.Article.PublishedAtUtc,
                TimeSpan.FromSeconds(3),
                cancellationToken);

        var leadStoryItems = NarratedNews.DistinctStories(rankedStories,
                story => story.Article.Title, story => story.Article.Url, story => story.Article.PublishedAtUtc,
                story => story.Article.Summary, story => threadIds.GetValueOrDefault(story.Article.Url))
            .Take(4)
            .Select(r => new ExecutiveBriefingEmailStory(
                r.Article.Title,
                r.Article.Url,
                r.Article.Source,
                TruncateSentence(r.Article.Summary, 220),
                r.PriorityTopic))
            .ToList();

        // 3. Optional multilingual translation of greeting + lead headlines
        if (briefingPrefs.Language != "en" && translator.Enabled && (leadStoryItems.Count > 0 || greeting.Length > 0))
        {
            try
            {
                var texts = new List<string> { greeting, formattedDate };
                foreach (var s in leadStoryItems)
                {
                    texts.Add(s.Title);
                    texts.Add(string.IsNullOrWhiteSpace(s.Summary) ? s.Title : s.Summary);
                }
                var translated = await translator.TranslateTextsAsync(texts, briefingPrefs.Language, cancellationToken);
                if (translated.Length == texts.Count)
                {
                    greeting = translated[0];
                    formattedDate = translated[1];
                    for (var i = 0; i < leadStoryItems.Count; i++)
                    {
                        var titleTr = translated[2 + i * 2];
                        var sumTr = translated[3 + i * 2];
                        leadStoryItems[i] = leadStoryItems[i] with
                        {
                            Title = string.IsNullOrWhiteSpace(titleTr) ? leadStoryItems[i].Title : titleTr,
                            Summary = string.IsNullOrWhiteSpace(leadStoryItems[i].Summary) ? "" : sumTr,
                        };
                    }
                }
            }
            catch
            {
                // Keep English text on transient translation failure
            }
        }

        // 4. Create hosted /shared/<48-hex> snapshot so email recipients can play audio with 1 tap
        var origin = SanitizeOrigin(requestOrigin)
            ?? SanitizeOrigin(briefingPrefs.PublicOrigin)
            ?? SanitizeOrigin(configuration["PublicBaseUrl"]);
        var hostedSharePath = await TryCreateHostedBriefingSnapshotAsync(
            userId,
            edition,
            todayKey,
            greeting,
            formattedDate,
            briefingPrefs.Language,
            watchlistQuotes,
            leadStoryItems,
            cancellationToken);

        var openBriefingUrl = origin is not null ? $"{origin}/?briefing=1" : "/?briefing=1";
        var hostedAudioUrl = origin is not null && hostedSharePath is not null
            ? $"{origin}{hostedSharePath}"
            : null;

        int pushCount = 0;
        bool pushSent = false;
        bool emailSent = false;
        string? warning = null;

        if (sendPush)
        {
            var pushTitle = $"🗞️ {greeting} — Signal {edition} Briefing";
            var leadHeadline = leadStoryItems.FirstOrDefault()?.Title;
            var marketPrefix = watchlistQuotes.Length > 0
                ? $"{watchlistQuotes[0].Symbol} {(watchlistQuotes[0].PercentChange >= 0 ? "+" : "")}{watchlistQuotes[0].PercentChange:F1}% · "
                : "";
            var pushBody = leadHeadline is not null
                ? $"{marketPrefix}Lead: {leadHeadline}"
                : $"{marketPrefix}Your executive digest for {formattedDate} is ready.";

            pushCount = await pushNotifications.SendExecutiveBriefingAsync(
                userId,
                pushTitle,
                pushBody,
                unreadCount,
                cancellationToken);
            pushSent = pushCount > 0;
        }

        if (sendEmail && user is not null && !string.IsNullOrWhiteSpace(user.Email))
        {
            try
            {
                var marketItems = watchlistQuotes
                    .Select(q => new ExecutiveBriefingEmailMarket(
                        q.Symbol,
                        q.Name,
                        $"{(string.IsNullOrWhiteSpace(q.Currency) ? "" : q.Currency + " ")}{q.Price:F2}",
                        q.PercentChange))
                    .ToArray();

                var digest = new ExecutiveBriefingEmailDigest(
                    greeting,
                    edition,
                    formattedDate,
                    openBriefingUrl,
                    hostedAudioUrl,
                    priorityTopics,
                    marketItems,
                    leadStoryItems);

                await emailSender.SendExecutiveBriefingEmailAsync(user.Email, digest, cancellationToken);
                emailSent = true;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                warning = "Email delivery is not configured or temporarily unavailable.";
                logger.LogWarning(exception, "Executive briefing email delivery failed for user {UserId}.", userId);
            }
        }

        return new ExecutiveBriefingDeliveryResult(
            pushSent,
            pushCount,
            emailSent,
            hostedSharePath,
            todayKey,
            warning);
    }

    private async Task<string?> TryCreateHostedBriefingSnapshotAsync(
        string userId,
        string edition,
        string todayKey,
        string greeting,
        string formattedDate,
        string language,
        MarketQuote[] markets,
        IReadOnlyList<ExecutiveBriefingEmailStory> stories,
        CancellationToken cancellationToken)
    {
        try
        {
            var paragraphs = new List<string> { $"{greeting} — {formattedDate}." };
            if (markets.Length > 0)
            {
                var movers = string.Join("; ", markets.Select(m =>
                    $"{m.Name} ({m.Symbol}) {(m.PercentChange >= 0 ? "+" : "")}{m.PercentChange:F2}% at {m.Price:F2} {m.Currency}".Trim()));
                paragraphs.Add($"Market Watchlist: {movers}.");
            }
            foreach (var s in stories)
            {
                var detail = string.IsNullOrWhiteSpace(s.Summary) ? "" : $" — {s.Summary}";
                paragraphs.Add($"[{s.Source}] {s.Title}{detail}");
            }

            var canonicalUrl = $"https://signal.news/briefing/scheduled-{todayKey}-{edition.ToLowerInvariant()}-{language}";
            var shareKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(new { Url = canonicalUrl, Language = language }))));

            var existing = await database.SharedNewsArticles
                .AsNoTracking()
                .FirstOrDefaultAsync(a => a.UserId == userId && a.ShareKey == shareKey, cancellationToken);
            if (existing is not null)
                return $"/shared/{existing.Id}";

            var title = $"Signal {edition} Executive Briefing — {formattedDate}";
            var paragraphsJson = JsonSerializer.Serialize(paragraphs);
            var contentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                $"{canonicalUrl}\n{language}\n{title}\n{paragraphsJson}")));

            var byHash = await database.SharedNewsArticles
                .AsNoTracking()
                .FirstOrDefaultAsync(a => a.UserId == userId && a.ContentHash == contentHash, cancellationToken);
            if (byHash is not null)
                return $"/shared/{byHash.Id}";

            var share = new SharedNewsArticle
            {
                Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant(),
                UserId = userId,
                ContentHash = contentHash,
                ShareKey = shareKey,
                OriginalUrl = canonicalUrl,
                DiscussionUrl = stories.FirstOrDefault()?.Url is { Length: > 0 } firstUrl && firstUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                    ? firstUrl
                    : canonicalUrl,
                Title = title,
                Source = "Signal Executive Briefing",
                Byline = "Signal Scheduled Wake-up Briefing",
                Language = language == "en" ? "" : language,
                ParagraphsJson = paragraphsJson,
                SummaryOnly = false,
                CreatedAtUtc = DateTime.UtcNow,
            };

            database.SharedNewsArticles.Add(share);
            await database.SaveChangesAsync(cancellationToken);
            return $"/shared/{share.Id}";
        }
        catch (Exception exception)
        {
            logger.LogInformation("Could not save scheduled briefing hosted audio snapshot ({FailureType}).", exception.GetType().Name);
            return null;
        }
    }

    private static (string? Topic, int? Rank) MatchPriorityTopic(
        string title,
        string summary,
        string[] articleTopics,
        string[] priorityTopics)
    {
        if (priorityTopics.Length == 0) return (null, null);
        var searchable = $"{title} {summary}";
        for (var i = 0; i < priorityTopics.Length; i++)
        {
            var priority = priorityTopics[i];
            if (articleTopics.Any(t => t.Equals(priority, StringComparison.OrdinalIgnoreCase) || TopicMatcher.Matches(t, priority))
                || TopicMatcher.Matches(searchable, priority))
            {
                return (priority, i);
            }
        }
        return (null, null);
    }

    private static string[] NormalizePriorityTopics(IEnumerable<string>? values)
    {
        if (values is null) return [];
        return values
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Select(v => string.Join(' ', v.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)))
            .Where(v => v.Length is > 0 and <= 80)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(8)
            .ToArray();
    }

    private static string? SanitizeOrigin(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length > 256) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return null;
        if (!string.IsNullOrEmpty(uri.UserInfo)) return null;
        return $"{uri.Scheme}://{uri.Authority}";
    }

    private static string? TryExtractWeatherTimeZone(string? weatherJson)
    {
        if (string.IsNullOrWhiteSpace(weatherJson) || weatherJson == "{}") return null;
        try
        {
            using var doc = JsonDocument.Parse(weatherJson);
            if (doc.RootElement.TryGetProperty("Timezone", out var tz) && tz.ValueKind == JsonValueKind.String)
                return tz.GetString();
            if (doc.RootElement.TryGetProperty("timezone", out var tzLower) && tzLower.ValueKind == JsonValueKind.String)
                return tzLower.GetString();
        }
        catch
        {
        }
        return null;
    }

    private static string[] DeserializeStringArray(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch { return []; }
    }

    private static Dictionary<string, string> DeserializeDictionary(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new(StringComparer.OrdinalIgnoreCase);
        try
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            return raw is null ? new(StringComparer.OrdinalIgnoreCase) : new(raw, StringComparer.OrdinalIgnoreCase);
        }
        catch
        {
            return new(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static string TruncateSentence(string? value, int maxLen)
    {
        var collapsed = string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return collapsed.Length <= maxLen ? collapsed : collapsed[..maxLen].TrimEnd() + "…";
    }
}
