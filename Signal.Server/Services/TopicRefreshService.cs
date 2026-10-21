using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class TopicRefreshService(
    SignalDbContext database,
    NewsService newsService,
    IAccountEmailSender emailSender,
    PushNotificationService pushNotificationService,
    ILogger<TopicRefreshService> logger,
    IArticleAudioPrewarmer? audioPrewarmer = null)
{
    private const int ProviderConcurrency = 8;
    private const int TopicsPerProviderBatch = 8;
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> UserLocks = new(StringComparer.Ordinal);

    public static string NormalizeTopicKey(string topic) =>
        string.Join(' ', topic.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToUpperInvariant();

    public async Task<TopicBriefingResponse> LoadBriefingAsync(
        string userId,
        CancellationToken cancellationToken,
        string? selectedTopic = null)
    {
        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
        if (preferences is null)
            return new TopicBriefingResponse([], [], null, 0, 0);

        var followedTopics = DeserializeList(preferences.TopicsJson);
        var selectedKey = string.IsNullOrWhiteSpace(selectedTopic) ? null : NormalizeTopicKey(selectedTopic);
        var topics = selectedKey is null
            ? followedTopics
            : followedTopics.Where(topic => NormalizeTopicKey(topic) == selectedKey).ToArray();
        var states = await LoadStatesAsync(userId, cancellationToken);
        var articles = await LoadCurrentArticlesAsync(userId, preferences, topics, cancellationToken);
        var historyTotal = await database.StoredNewsArticles.CountAsync(item => item.UserId == userId, cancellationToken);
        var bookmarkTotal = await database.StoredNewsArticles.CountAsync(
            item => item.UserId == userId && item.IsBookmarked,
            cancellationToken);
        return new TopicBriefingResponse(
            articles,
            states,
            states.Where(state => state.LastSuccessfulAt is not null
                    && (selectedKey is null || NormalizeTopicKey(state.Topic) == selectedKey))
                .MaxBy(state => state.LastSuccessfulAt)?.LastSuccessfulAt,
            historyTotal,
            bookmarkTotal);
    }

    public async Task<TopicBriefingResponse> RefreshAsync(
        string userId,
        IReadOnlyCollection<string>? requestedTopics,
        bool sendEmail,
        CancellationToken cancellationToken,
        bool requireDue = false)
    {
        var userLock = UserLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await userLock.WaitAsync(cancellationToken);
        try
        {
            var preferences = await database.UserNewsPreferences
                .AsNoTracking()
                .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);
            if (preferences is null)
                return new TopicBriefingResponse([], [], null, 0, 0);

            var followedTopics = DeserializeList(preferences.TopicsJson);
            var requestedKeys = requestedTopics is null
                ? null
                : requestedTopics.Select(NormalizeTopicKey).ToHashSet(StringComparer.Ordinal);
            var topics = followedTopics
                .Where(topic => requestedKeys is null || requestedKeys.Contains(NormalizeTopicKey(topic)))
                .ToArray();
            if (requireDue)
            {
                var now = DateTime.UtcNow;
                var dueKeys = await database.TopicRefreshStates
                    .AsNoTracking()
                    .Where(item => item.UserId == userId
                        && item.NextRefreshAtUtc != null
                        && item.NextRefreshAtUtc <= now)
                    .Select(item => item.TopicKey)
                    .ToArrayAsync(cancellationToken);
                var due = dueKeys.ToHashSet(StringComparer.Ordinal);
                topics = topics.Where(topic => due.Contains(NormalizeTopicKey(topic))).ToArray();
            }
            if (topics.Length == 0)
                return await LoadBriefingAsync(userId, cancellationToken);

            var outcomes = await FetchAsync(preferences, topics, cancellationToken);
            var refreshedAt = DateTime.UtcNow;
            var selectedArticles = SelectArticles(outcomes, topics, preferences.StoryLimit);
            var (newlyAvailableTopicKeys, newArticles) = await StoreArticlesAsync(
                userId,
                selectedArticles,
                refreshedAt,
                cancellationToken);
            await UpdateStatesAsync(
                userId,
                topics,
                preferences.RefreshMinutes,
                outcomes,
                newlyAvailableTopicKeys,
                refreshedAt,
                cancellationToken);
            if (newlyAvailableTopicKeys.Count > 0)
            {
                try
                {
                    await pushNotificationService.SendNewStoriesAsync(
                        userId,
                        newlyAvailableTopicKeys,
                        newArticles,
                        preferences.PushNewsTitlesEnabled,
                        cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    logger.LogError(
                        exception,
                        "Could not send new-story push notifications for user {UserId}.",
                        userId);
                }
            }
            await PurgeExpiredAsync(userId, preferences.ArticleRetentionDays, refreshedAt, cancellationToken);

            if (sendEmail && preferences.EmailSummaryEnabled && selectedArticles.Length > 0)
                await SendSummaryAsync(userId, topics, selectedArticles, refreshedAt, cancellationToken);

            return await LoadBriefingAsync(userId, cancellationToken);
        }
        finally
        {
            userLock.Release();
        }
    }

    public async Task<TopicBriefingResponse?> RefreshDueAsync(
        string userId,
        CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var dueTopics = await database.TopicRefreshStates
            .AsNoTracking()
            .Where(item => item.UserId == userId
                && item.NextRefreshAtUtc != null
                && item.NextRefreshAtUtc <= now)
            .Select(item => item.Topic)
            .ToArrayAsync(cancellationToken);
        return dueTopics.Length == 0
            ? null
            : await RefreshAsync(userId, dueTopics, true, cancellationToken, requireDue: true);
    }

    private async Task<FetchOutcome[]> FetchAsync(
        UserNewsPreferences preferences,
        string[] topics,
        CancellationToken cancellationToken)
    {
        var work = new List<FetchWork>();
        if (preferences.GoogleEnabled)
        {
            work.AddRange(topics.Select(topic => new FetchWork(
                [topic],
                "Google News",
                token => newsService.GetGoogleNewsAsync(topic, preferences.StoryLimit, token))));
        }
        if (preferences.GdeltEnabled)
        {
            work.AddRange(topics.Chunk(TopicsPerProviderBatch).Select(batch =>
            {
                var batchTopics = batch.ToArray();
                return new FetchWork(
                    batchTopics,
                    "GDELT",
                    token => newsService.GetGdeltNewsAsync(batchTopics, preferences.StoryLimit, token));
            }));
        }
        foreach (var feed in DeserializeList(preferences.RssFeedsJson))
        {
            work.Add(new FetchWork(
                topics,
                FeedLabel(feed),
                token => newsService.GetPublisherFeedAsync(feed, topics, preferences.StoryLimit, token)));
        }

        if (work.Count == 0)
            return topics.Select(topic => FetchOutcome.Failed([topic], "News sources", "No news sources are enabled.")).ToArray();

        using var gate = new SemaphoreSlim(ProviderConcurrency, ProviderConcurrency);
        return await Task.WhenAll(work.Select(async item =>
        {
            await gate.WaitAsync(cancellationToken);
            try
            {
                return FetchOutcome.Succeeded(item.Topics, item.SourceLabel, await item.Fetch(cancellationToken));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogWarning(
                    exception,
                    "Scheduled news refresh failed for {Source} and {Topics}.",
                    item.SourceLabel,
                    string.Join(", ", item.Topics));
                return FetchOutcome.Failed(item.Topics, item.SourceLabel, exception.Message);
            }
            finally
            {
                gate.Release();
            }
        }));
    }

    private static TopicBriefingArticle[] SelectArticles(
        IReadOnlyCollection<FetchOutcome> outcomes,
        IReadOnlyCollection<string> topics,
        int storyLimit)
    {
        var byUrl = new Dictionary<string, MutableArticle>(StringComparer.OrdinalIgnoreCase);
        foreach (var outcome in outcomes.Where(item => item.Result is not null))
        {
            foreach (var article in outcome.Result!.Articles)
            {
                var normalizedUrl = ArticleIdentity.NormalizeUrl(article.Url) ?? article.Url;
                var matchedTopics = article.MatchedTopics is { Count: > 0 }
                    ? article.MatchedTopics
                    : outcome.Topics;
                if (!byUrl.TryGetValue(normalizedUrl, out var existing))
                {
                    existing = new MutableArticle(
                        article.Title,
                        normalizedUrl,
                        article.Source,
                        article.PublishedAt,
                        article.Summary,
                        article.ImageUrl);
                    byUrl[normalizedUrl] = existing;
                }
                else
                {
                    if (existing.Summary.Length == 0 && article.Summary.Length > 0)
                        existing.Summary = article.Summary;
                    if (existing.ImageUrl.Length == 0 && article.ImageUrl.Length > 0)
                        existing.ImageUrl = article.ImageUrl;
                }
                existing.Topics.UnionWith(matchedTopics);
                existing.Providers.Add(outcome.Result.Provider);
            }
        }

        var deduplicated = ArticleIdentity.GroupDuplicates(
                byUrl.Values.OrderByDescending(article => article.PublishedAt).ToArray(),
                article => article.Title,
                article => article.Url)
            .Select(MergeDuplicateGroup)
            .OrderByDescending(article => article.PublishedAt)
            .ToArray();

        var included = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var topic in topics)
        {
            foreach (var article in SelectBalanced(
                deduplicated.Where(article => article.Topics.Contains(topic)).ToArray(),
                Math.Clamp(storyLimit, 10, 500)))
            {
                included.Add(article.Url);
            }
        }

        return deduplicated
            .Where(article => included.Contains(article.Url))
            .Select(article => article.ToResponse())
            .ToArray();
    }

    private static MutableArticle MergeDuplicateGroup(MutableArticle[] group)
    {
        var primary = group.FirstOrDefault(article => !ArticleIdentity.IsGoogleNewsWrapperUrl(article.Url))
            ?? group[0];
        foreach (var candidate in group)
        {
            if (ReferenceEquals(candidate, primary)) continue;
            primary.Topics.UnionWith(candidate.Topics);
            primary.Providers.UnionWith(candidate.Providers);
            if (primary.Summary.Length == 0 && candidate.Summary.Length > 0)
                primary.Summary = candidate.Summary;
            if (primary.ImageUrl.Length == 0 && candidate.ImageUrl.Length > 0)
                primary.ImageUrl = candidate.ImageUrl;
        }
        return primary;
    }

    private static IEnumerable<MutableArticle> SelectBalanced(
        IReadOnlyList<MutableArticle> candidates,
        int limit)
    {
        var providers = candidates
            .SelectMany(article => article.Providers)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(ProviderPriority)
            .ToArray();
        var selected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var addedInRound = true;
        while (selected.Count < limit && addedInRound)
        {
            addedInRound = false;
            foreach (var provider in providers)
            {
                var next = candidates.FirstOrDefault(article =>
                    article.Providers.Contains(provider) && !selected.Contains(article.Url));
                if (next is null) continue;
                selected.Add(next.Url);
                addedInRound = true;
                if (selected.Count == limit) break;
            }
        }
        foreach (var article in candidates)
        {
            if (selected.Count == limit) break;
            selected.Add(article.Url);
        }
        return candidates.Where(article => selected.Contains(article.Url));
    }

    private static int ProviderPriority(string provider) =>
        provider.StartsWith("RSS / ", StringComparison.OrdinalIgnoreCase) ? 0
            : provider.Equals("GDELT", StringComparison.OrdinalIgnoreCase) ? 1
            : 2;

    public async Task<bool> MarkTopicViewedAsync(
        string userId,
        string topic,
        CancellationToken cancellationToken)
    {
        var userLock = UserLocks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await userLock.WaitAsync(cancellationToken);
        try
        {
            var key = NormalizeTopicKey(topic);
            var state = await database.TopicRefreshStates
                .SingleOrDefaultAsync(
                    item => item.UserId == userId && item.TopicKey == key,
                    cancellationToken);
            if (state is null) return false;

            state.ViewedContentVersion = state.LatestContentVersion;
            state.HasUnread = false;
            state.LastViewedAtUtc = DateTime.UtcNow;
            await database.SaveChangesAsync(cancellationToken);
            return true;
        }
        finally
        {
            userLock.Release();
        }
    }

    internal async Task<(HashSet<string> TopicKeys, List<StoredNewsArticle> NewArticles)> StoreArticlesAsync(
        string userId,
        IReadOnlyCollection<TopicBriefingArticle> articles,
        DateTime refreshedAt,
        CancellationToken cancellationToken)
    {
        var lookupUrls = articles
            .SelectMany(item => ArticleIdentity.GetUrlLookupCandidates(item.Url))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var existing = new List<StoredNewsArticle>();
        foreach (var urlBatch in lookupUrls.Chunk(400))
        {
            existing.AddRange(await database.StoredNewsArticles
                .Where(item => item.UserId == userId && urlBatch.Contains(item.Url))
                .ToListAsync(cancellationToken));
        }

        var recentExisting = await database.StoredNewsArticles
            .Where(item => item.UserId == userId)
            .OrderByDescending(item => item.LastSeenAtUtc)
            .Take(2000)
            .ToListAsync(cancellationToken);

        var allKnown = existing
            .Concat(recentExisting)
            .GroupBy(item => item.Id)
            .Select(group => group.First())
            .ToList();

        var byUrl = new Dictionary<string, StoredNewsArticle>(StringComparer.OrdinalIgnoreCase);
        var byStoryKey = new Dictionary<string, List<StoredNewsArticle>>(StringComparer.Ordinal);
        var byHeadlineKey = new Dictionary<string, List<StoredNewsArticle>>(StringComparer.Ordinal);

        void IndexStoredArticle(StoredNewsArticle item)
        {
            foreach (var candidateUrl in ArticleIdentity.GetUrlLookupCandidates(item.Url))
                byUrl.TryAdd(candidateUrl, item);

            var storyKey = ArticleIdentity.GetStoryUrlKey(item.Url);
            if (storyKey.Length > 0)
            {
                if (!byStoryKey.TryGetValue(storyKey, out var list))
                {
                    list = [];
                    byStoryKey[storyKey] = list;
                }
                if (!list.Contains(item)) list.Add(item);
            }

            var headlineKey = ArticleIdentity.GetHeadlineKey(item.Title);
            if (headlineKey.Length > 0)
            {
                if (!byHeadlineKey.TryGetValue(headlineKey, out var list))
                {
                    list = [];
                    byHeadlineKey[headlineKey] = list;
                }
                if (!list.Contains(item)) list.Add(item);
            }
        }

        foreach (var item in allKnown) IndexStoredArticle(item);

        var newlyAvailableTopicKeys = new HashSet<string>(StringComparer.Ordinal);
        var newArticles = new List<StoredNewsArticle>();

        foreach (var article in articles)
        {
            var normalizedUrl = ArticleIdentity.NormalizeUrl(article.Url)
                ?? article.Url[..Math.Min(article.Url.Length, 2048)];
            var urlCandidates = ArticleIdentity.GetUrlLookupCandidates(article.Url);
            StoredNewsArticle? stored = null;
            foreach (var candidateUrl in urlCandidates)
            {
                if (byUrl.TryGetValue(candidateUrl, out stored)) break;
            }

            var storyKey = ArticleIdentity.GetStoryUrlKey(normalizedUrl);
            var headlineKey = ArticleIdentity.GetHeadlineKey(article.Title);
            var aliases = new List<StoredNewsArticle>();
            if (storyKey.Length > 0 && byStoryKey.TryGetValue(storyKey, out var storyMatches))
                aliases.AddRange(storyMatches);
            if (headlineKey.Length > 0 && byHeadlineKey.TryGetValue(headlineKey, out var headlineMatches))
            {
                foreach (var match in headlineMatches)
                {
                    if (!aliases.Contains(match)) aliases.Add(match);
                }
            }

            var isNewRow = false;
            string[] existingTopics;
            if (stored is null)
            {
                stored = new StoredNewsArticle
                {
                    UserId = userId,
                    Url = normalizedUrl,
                    FirstSeenAtUtc = refreshedAt,
                    PublishedAtUtc = article.PublishedAt.UtcDateTime,
                };
                database.StoredNewsArticles.Add(stored);
                isNewRow = true;
                existingTopics = [];
            }
            else
            {
                existingTopics = DeserializeList(stored.TopicsJson);
                if (!string.Equals(stored.Url, normalizedUrl, StringComparison.Ordinal)
                    && (!byUrl.TryGetValue(normalizedUrl, out var collision) || ReferenceEquals(collision, stored)))
                {
                    stored.Url = normalizedUrl;
                }

                var incomingPublishedAt = article.PublishedAt.UtcDateTime;
                var isFallbackNowOnOldRow = stored.FirstSeenAtUtc < refreshedAt.AddMinutes(-2)
                    && incomingPublishedAt >= refreshedAt.AddMinutes(-2);
                if (!isFallbackNowOnOldRow)
                {
                    stored.PublishedAtUtc = incomingPublishedAt;
                }
                else if (stored.PublishedAtUtc > stored.FirstSeenAtUtc.AddMinutes(2))
                {
                    stored.PublishedAtUtc = stored.FirstSeenAtUtc;
                }
            }

            var readAlias = aliases.FirstOrDefault(alias => alias.IsRead);
            if (readAlias is not null && !stored.IsRead)
            {
                stored.IsRead = true;
                stored.ReadAtUtc ??= readAlias.ReadAtUtc ?? refreshedAt;
            }

            var existingTopicKeys = existingTopics
                .Concat(aliases.SelectMany(alias => DeserializeList(alias.TopicsJson)))
                .Select(NormalizeTopicKey)
                .ToHashSet(StringComparer.Ordinal);
            if (!stored.IsRead)
            {
                foreach (var topic in article.Topics)
                {
                    var topicKey = NormalizeTopicKey(topic);
                    if (!existingTopicKeys.Contains(topicKey)) newlyAvailableTopicKeys.Add(topicKey);
                }
            }

            if (isNewRow && !stored.IsRead && aliases.Count == 0 && !newArticles.Contains(stored))
                newArticles.Add(stored);

            stored.Title = NormalizeText(article.Title, 500);
            stored.Source = NormalizeText(article.Source, 256);
            stored.Summary = NormalizeText(article.Summary, 4000);
            if (article.ImageUrl.Length > 0)
                stored.ImageUrl = article.ImageUrl[..Math.Min(article.ImageUrl.Length, 2048)];
            stored.TopicsJson = JsonSerializer.Serialize(MergeLists(stored.TopicsJson, article.Topics));
            stored.ProvidersJson = JsonSerializer.Serialize(MergeLists(stored.ProvidersJson, article.Providers));
            stored.LastSeenAtUtc = refreshedAt;

            IndexStoredArticle(stored);
        }
        await database.SaveChangesAsync(cancellationToken);
        foreach (var article in newArticles) audioPrewarmer?.Enqueue(article.Url, article.Title, article.Summary);
        return (newlyAvailableTopicKeys, newArticles);
    }

    private async Task UpdateStatesAsync(
        string userId,
        IReadOnlyCollection<string> topics,
        int refreshMinutes,
        IReadOnlyCollection<FetchOutcome> outcomes,
        IReadOnlySet<string> newlyAvailableTopicKeys,
        DateTime refreshedAt,
        CancellationToken cancellationToken)
    {
        var keys = topics.Select(NormalizeTopicKey).ToArray();
        var states = await database.TopicRefreshStates
            .Where(item => item.UserId == userId && keys.Contains(item.TopicKey))
            .ToListAsync(cancellationToken);
        var byKey = states.ToDictionary(item => item.TopicKey, StringComparer.Ordinal);

        foreach (var topic in topics)
        {
            var key = NormalizeTopicKey(topic);
            if (!byKey.TryGetValue(key, out var state))
            {
                state = new TopicRefreshState { UserId = userId, TopicKey = key, Topic = topic };
                database.TopicRefreshStates.Add(state);
                byKey[key] = state;
            }
            var topicOutcomes = outcomes.Where(outcome =>
                outcome.Topics.Any(candidate => string.Equals(candidate, topic, StringComparison.OrdinalIgnoreCase))).ToArray();
            var successful = topicOutcomes.Any(outcome => outcome.Result is not null);
            var failures = topicOutcomes
                .Where(outcome => outcome.Result is null)
                .Select(outcome => outcome.SourceLabel)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            state.Topic = topic;
            state.LastAttemptedAtUtc = refreshedAt;
            if (successful) state.LastSuccessfulAtUtc = refreshedAt;
            if (newlyAvailableTopicKeys.Contains(key))
            {
                state.LatestContentVersion = checked(state.LatestContentVersion + 1);
            }
            state.HasUnread = state.LatestContentVersion > state.ViewedContentVersion;
            state.NextRefreshAtUtc = refreshMinutes == 0 ? null : refreshedAt.AddMinutes(refreshMinutes);
            state.LastError = failures.Length == 0
                ? ""
                : successful
                    ? $"Some sources failed: {string.Join(", ", failures)}."
                    : $"Could not refresh {string.Join(", ", failures)}.";
        }
        await database.SaveChangesAsync(cancellationToken);
    }

    private async Task<TopicBriefingArticle[]> LoadCurrentArticlesAsync(
        string userId,
        UserNewsPreferences preferences,
        IReadOnlyCollection<string> topics,
        CancellationToken cancellationToken)
    {
        if (topics.Count == 0) return [];
        var take = Math.Min(10_000, Math.Max(500, preferences.StoryLimit * topics.Count * 3));
        var stored = await database.StoredNewsArticles
            .AsNoTracking()
            .Where(item => item.UserId == userId)
            .OrderByDescending(item => item.PublishedAtUtc)
            .Take(take)
            .ToArrayAsync(cancellationToken);
        var currentTopics = topics.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var rawCandidates = stored
            .Select(item => new
            {
                Item = item,
                Topics = DeserializeList(item.TopicsJson).Where(currentTopics.Contains).ToArray(),
                Providers = DeserializeList(item.ProvidersJson),
            })
            .Where(item => item.Topics.Length > 0 && item.Providers.Any(provider => ProviderEnabled(provider, preferences)))
            .ToArray();

        var candidates = ArticleIdentity.GroupDuplicates(
                rawCandidates,
                candidate => candidate.Item.Title,
                candidate => candidate.Item.Url)
            .Select(group =>
            {
                var primary = group.FirstOrDefault(candidate => !ArticleIdentity.IsGoogleNewsWrapperUrl(candidate.Item.Url))
                    ?? group[0];
                var mergedTopics = group
                    .SelectMany(candidate => candidate.Topics)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                var mergedProviders = group
                    .SelectMany(candidate => candidate.Providers)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                var summary = primary.Item.Summary.Length > 0
                    ? primary.Item.Summary
                    : group.Select(candidate => candidate.Item.Summary).FirstOrDefault(text => text.Length > 0) ?? "";
                var imageUrl = primary.Item.ImageUrl.Length > 0
                    ? primary.Item.ImageUrl
                    : group.Select(candidate => candidate.Item.ImageUrl).FirstOrDefault(text => text.Length > 0) ?? "";
                return new
                {
                    Id = primary.Item.Id,
                    Title = primary.Item.Title,
                    Url = ArticleIdentity.NormalizeUrl(primary.Item.Url) ?? primary.Item.Url,
                    Source = primary.Item.Source,
                    PublishedAtUtc = primary.Item.PublishedAtUtc,
                    Summary = summary,
                    ImageUrl = imageUrl,
                    Topics = mergedTopics,
                    Providers = mergedProviders,
                    IsBookmarked = group.Any(candidate => candidate.Item.IsBookmarked),
                    IsRead = group.Any(candidate => candidate.Item.IsRead),
                };
            })
            .OrderByDescending(candidate => candidate.PublishedAtUtc)
            .ToArray();

        var included = new HashSet<long>();
        foreach (var topic in topics)
        {
            foreach (var candidate in candidates
                .Where(candidate => candidate.Topics.Contains(topic, StringComparer.OrdinalIgnoreCase))
                .Take(Math.Clamp(preferences.StoryLimit, 10, 500)))
            {
                included.Add(candidate.Id);
            }
        }
        return candidates
            .Where(candidate => included.Contains(candidate.Id))
            .Select(candidate => new TopicBriefingArticle(
                candidate.Title,
                candidate.Url,
                candidate.Source,
                new DateTimeOffset(candidate.PublishedAtUtc, TimeSpan.Zero),
                candidate.Summary,
                candidate.ImageUrl,
                candidate.Topics,
                candidate.Providers,
                candidate.IsBookmarked,
                candidate.IsRead))
            .ToArray();
    }

    private async Task<TopicRefreshStatus[]> LoadStatesAsync(
        string userId,
        CancellationToken cancellationToken)
    {
        var states = await database.TopicRefreshStates
            .AsNoTracking()
            .Where(item => item.UserId == userId)
            .OrderBy(item => item.Topic)
            .Select(item => new
            {
                item.Topic,
                item.LastAttemptedAtUtc,
                item.LastSuccessfulAtUtc,
                item.NextRefreshAtUtc,
                item.LastViewedAtUtc,
                HasUnread = item.LatestContentVersion > item.ViewedContentVersion,
                item.LastError,
            })
            .ToArrayAsync(cancellationToken);
        return states.Select(item => new TopicRefreshStatus(
            item.Topic,
            AsUtc(item.LastAttemptedAtUtc),
            AsUtc(item.LastSuccessfulAtUtc),
            AsUtc(item.NextRefreshAtUtc),
            AsUtc(item.LastViewedAtUtc),
            item.HasUnread,
            item.LastError)).ToArray();
    }

    private static DateTimeOffset? AsUtc(DateTime? value) =>
        value is null
            ? null
            : new DateTimeOffset(DateTime.SpecifyKind(value.Value, DateTimeKind.Utc));

    private async Task PurgeExpiredAsync(
        string userId,
        int retentionDays,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var cutoff = now.AddDays(-Controllers.PreferencesController.NormalizeRetentionDays(retentionDays));
        var expired = await database.StoredNewsArticles
            .Where(item => item.UserId == userId && !item.IsBookmarked && item.LastSeenAtUtc < cutoff)
            .ToArrayAsync(cancellationToken);
        if (expired.Length == 0) return;
        database.StoredNewsArticles.RemoveRange(expired);
        await database.SaveChangesAsync(cancellationToken);
    }

    private async Task SendSummaryAsync(
        string userId,
        IReadOnlyList<string> topics,
        IReadOnlyList<TopicBriefingArticle> articles,
        DateTime refreshedAt,
        CancellationToken cancellationToken)
    {
        var email = await database.Users
            .Where(user => user.Id == userId)
            .Select(user => user.Email)
            .SingleOrDefaultAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(email)) return;
        try
        {
            await emailSender.SendNewsSummaryAsync(
                email,
                new NewsSummaryDigest(
                    new DateTimeOffset(refreshedAt, TimeSpan.Zero),
                    topics,
                    articles.Take(50).Select(article => new NewsSummaryArticle(
                        article.Title,
                        article.Url,
                        article.Source,
                        article.PublishedAt,
                        article.Summary,
                        article.Topics,
                        article.Providers)).ToArray()),
                cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Could not send scheduled news summary for user {UserId}.", userId);
        }
    }

    private static bool ProviderEnabled(string provider, UserNewsPreferences preferences) =>
        (provider.Equals("Google News", StringComparison.OrdinalIgnoreCase) && preferences.GoogleEnabled)
        || (provider.Equals("GDELT", StringComparison.OrdinalIgnoreCase) && preferences.GdeltEnabled)
        || (provider.StartsWith("RSS /", StringComparison.OrdinalIgnoreCase)
            && DeserializeList(preferences.RssFeedsJson).Length > 0);

    private static string FeedLabel(string value)
    {
        try { return $"RSS / {new Uri(value).Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase)}"; }
        catch { return "Publisher RSS"; }
    }

    private static string NormalizeText(string value, int maximumLength)
    {
        var normalized = string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized[..Math.Min(normalized.Length, maximumLength)];
    }

    private static string[] MergeLists(string json, IEnumerable<string> additions) => DeserializeList(json)
        .Concat(additions)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static string[] DeserializeList(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }

    private sealed record FetchWork(
        string[] Topics,
        string SourceLabel,
        Func<CancellationToken, Task<NewsResult>> Fetch);

    private sealed record FetchOutcome(
        string[] Topics,
        string SourceLabel,
        NewsResult? Result,
        string Error)
    {
        public static FetchOutcome Succeeded(string[] topics, string sourceLabel, NewsResult result) =>
            new(topics, sourceLabel, result, "");

        public static FetchOutcome Failed(string[] topics, string sourceLabel, string error) =>
            new(topics, sourceLabel, null, error);
    }

    private sealed class MutableArticle(
        string title,
        string url,
        string source,
        DateTimeOffset publishedAt,
        string summary,
        string imageUrl)
    {
        public string Title { get; } = title;
        public string Url { get; } = url;
        public string Source { get; } = source;
        public DateTimeOffset PublishedAt { get; } = publishedAt;
        public string Summary { get; set; } = summary;
        public string ImageUrl { get; set; } = imageUrl;
        public HashSet<string> Topics { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Providers { get; } = new(StringComparer.OrdinalIgnoreCase);

        public TopicBriefingArticle ToResponse() =>
            new(Title, Url, Source, PublishedAt, Summary, ImageUrl, Topics.ToArray(), Providers.ToArray(), false, false);
    }
}

public sealed record TopicBriefingResponse(
    TopicBriefingArticle[] Articles,
    TopicRefreshStatus[] Topics,
    DateTimeOffset? RefreshedAt,
    int HistoryTotal,
    int BookmarkTotal);

public sealed record TopicBriefingArticle(
    string Title,
    string Url,
    string Source,
    DateTimeOffset PublishedAt,
    string Summary,
    string ImageUrl,
    string[] Topics,
    string[] Providers,
    bool IsBookmarked,
    bool IsRead);

public sealed record TopicRefreshStatus(
    string Topic,
    DateTimeOffset? LastAttemptedAt,
    DateTimeOffset? LastSuccessfulAt,
    DateTimeOffset? NextRefreshAt,
    DateTimeOffset? LastViewedAt,
    bool HasUnread,
    string LastError);
