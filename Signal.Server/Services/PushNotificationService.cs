using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using WebPush;

namespace Signal.Server.Services;

public sealed class PushNotificationService(
    SignalDbContext database,
    VapidKeyStore keyStore,
    ILogger<PushNotificationService> logger)
{
    public async Task<string> GetPublicKeyAsync(CancellationToken cancellationToken) =>
        (await keyStore.GetAsync(cancellationToken)).PublicKey;

    public async Task SaveSubscriptionAsync(
        string userId,
        PushSubscriptionDetails details,
        CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var subscription = await database.UserPushSubscriptions
            .SingleOrDefaultAsync(item => item.Endpoint == details.Endpoint, cancellationToken);
        if (subscription is null)
        {
            subscription = new UserPushSubscription
            {
                UserId = userId,
                Endpoint = details.Endpoint,
                CreatedAtUtc = now,
            };
            database.UserPushSubscriptions.Add(subscription);
        }

        subscription.UserId = userId;
        subscription.P256Dh = details.P256Dh;
        subscription.Auth = details.Auth;
        subscription.UpdatedAtUtc = now;
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task RemoveSubscriptionAsync(
        string userId,
        string endpoint,
        CancellationToken cancellationToken)
    {
        var subscription = await database.UserPushSubscriptions
            .SingleOrDefaultAsync(
                item => item.UserId == userId && item.Endpoint == endpoint,
                cancellationToken);
        if (subscription is null) return;
        database.UserPushSubscriptions.Remove(subscription);
        await database.SaveChangesAsync(cancellationToken);
    }

    public async Task<int> SendTestAsync(
        string userId,
        CancellationToken cancellationToken)
    {
        var badgeCount = await database.TopicRefreshStates.CountAsync(
            item => item.UserId == userId && item.LatestContentVersion > item.ViewedContentVersion,
            cancellationToken);
        return await SendAsync(
            userId,
            [new PushMessage(
                "Signal notifications are on",
                "New stories will now appear here, even while Signal is closed.",
                "/#top",
                badgeCount)],
            cancellationToken);
    }

    public async Task<int> SendNewStoriesAsync(
        string userId,
        IReadOnlySet<string> newTopicKeys,
        IReadOnlyCollection<StoredNewsArticle> newArticles,
        bool showNewsTitles,
        CancellationToken cancellationToken)
    {
        if (newTopicKeys.Count == 0) return 0;

        var topicKeys = newTopicKeys.ToArray();
        var topics = await database.TopicRefreshStates
            .AsNoTracking()
            .Where(item => item.UserId == userId && topicKeys.Contains(item.TopicKey))
            .OrderBy(item => item.Topic)
            .Select(item => item.Topic)
            .ToArrayAsync(cancellationToken);
        var badgeCount = await database.TopicRefreshStates.CountAsync(
            item => item.UserId == userId && item.LatestContentVersion > item.ViewedContentVersion,
            cancellationToken);
        return await SendAsync(
            userId,
            BuildNewsMessages(topics, newArticles, showNewsTitles, badgeCount),
            cancellationToken);
    }

    internal static PushMessage[] BuildNewsMessages(
        string[] topics,
        IReadOnlyCollection<StoredNewsArticle> newArticles,
        bool showNewsTitles,
        int badgeCount)
    {
        if (showNewsTitles)
        {
            // Stored titles are limited to 500 characters. Keep the publisher short
            // so even escaped Unicode fits in a single Web Push payload.
            return newArticles.DistinctBy(article => article.Id).Select(article => new PushMessage(
                article.Title,
                article.Source.Length > 0 ? article.Source[..Math.Min(article.Source.Length, 80)] : "New story in Signal",
                "/#top",
                badgeCount,
                $"signal-new-stories-{article.Id}")).ToArray();
        }

        var topicLabel = topics.Length switch
        {
            0 => "your followed topics",
            1 => topics[0],
            2 => string.Join(" and ", topics),
            _ => $"{topics[0]}, {topics[1]} and {topics.Length - 2} more",
        };
        return [new PushMessage(
            topics.Length == 1 ? $"New stories about {topics[0]}" : "New stories in Signal",
            $"Fresh coverage is available for {topicLabel}.",
            "/#top",
            badgeCount)];
    }

    private async Task<int> SendAsync(
        string userId,
        IReadOnlyList<PushMessage> messages,
        CancellationToken cancellationToken)
    {
        if (messages.Count == 0) return 0;
        var subscriptions = await database.UserPushSubscriptions
            .Where(item => item.UserId == userId)
            .ToArrayAsync(cancellationToken);
        if (subscriptions.Length == 0) return 0;

        var keys = await keyStore.GetAsync(cancellationToken);
        var vapid = new VapidDetails(keys.Subject, keys.PublicKey, keys.PrivateKey);
        var payloads = messages.Select(SerializeMessage).ToArray();
        var delivered = 0;
        var stale = new List<UserPushSubscription>();
        var client = new WebPushClient();
        foreach (var saved in subscriptions)
        {
            foreach (var payload in payloads)
            {
                try
                {
                    var subscription = new PushSubscription(saved.Endpoint, saved.P256Dh, saved.Auth);
                    await client.SendNotificationAsync(
                        subscription,
                        payload,
                        vapid,
                        cancellationToken: cancellationToken);
                    delivered += 1;
                }
                catch (WebPushException exception)
                    when (exception.StatusCode is HttpStatusCode.Gone or HttpStatusCode.NotFound)
                {
                    stale.Add(saved);
                    break;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    logger.LogWarning(
                        exception,
                        "Could not deliver a Signal Web Push notification for user {UserId}.",
                        userId);
                }
            }
        }

        if (stale.Count > 0)
        {
            database.UserPushSubscriptions.RemoveRange(stale);
            await database.SaveChangesAsync(cancellationToken);
        }
        return delivered;
    }

    internal static string SerializeMessage(PushMessage message) => JsonSerializer.Serialize(new
    {
        title = message.Title,
        body = message.Body,
        url = message.Url,
        tag = message.Tag,
        badgeCount = Math.Clamp(message.BadgeCount, 0, 99),
        icon = "/icons/signal-medallion-192.png",
        badge = "/icons/signal-notification-medallion-96.png",
    });

    internal sealed record PushMessage(
        string Title,
        string Body,
        string Url,
        int BadgeCount,
        string Tag = "signal-new-stories");
}

public sealed record PushSubscriptionDetails(
    string Endpoint,
    string P256Dh,
    string Auth);
