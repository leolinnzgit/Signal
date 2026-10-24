using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class NativeNotificationService(SignalDbContext database, INativePushSender sender, NativeDeliveryReceipts receipts, TimeProvider? clock = null)
{
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    public static string AccountKey(string userId) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(userId)));

    public async Task<bool> RegisterAsync(string userId, NativeNotificationDevice request, CancellationToken ct)
    {
        if (!sender.Ready) return false;
        if (request.Kind != "phone") return false;
        if (request.BrowserEndpoint is not null && (request.Kind != "phone" ||
            !await database.UserPushSubscriptions.AnyAsync(s => s.UserId == userId && s.Endpoint == request.BrowserEndpoint, ct))) return false;
        var existing = await database.Set<NativeNotificationDevice>().SingleOrDefaultAsync(d => d.Id == request.Id, ct);
        if (existing is not null && existing.UserId != userId) return false;
        var expired = await database.Set<NativeNotificationDevice>().Where(d => d.UserId == userId && d.Id != request.Id && d.ExpiresAtUtc <= time.GetUtcNow().UtcDateTime).ToArrayAsync(ct);
        database.RemoveRange(expired);
        if (existing is null && await database.Set<NativeNotificationDevice>().CountAsync(d => d.UserId == userId && d.ExpiresAtUtc > time.GetUtcNow().UtcDateTime, ct) >= 16) return false;
        // One token must never receive another account's stories after a new sign-in.
        var previous = await database.Set<NativeNotificationDevice>().Where(d => d.Token == request.Token && d.Id != request.Id).ToArrayAsync(ct);
        database.RemoveRange(previous);
        if (request.BrowserEndpoint is not null)
        {
            var linked = await database.Set<NativeNotificationDevice>()
                .Where(d => d.UserId == userId && d.BrowserEndpoint == request.BrowserEndpoint && d.Id != request.Id).ToArrayAsync(ct);
            foreach (var device in linked) device.BrowserEndpoint = null;
        }
        if (existing is null) { existing = new NativeNotificationDevice { Id = request.Id, UserId = userId }; database.Add(existing); }
        existing.Token = request.Token; existing.Kind = request.Kind; existing.BrowserEndpoint = request.BrowserEndpoint;
        existing.ExpiresAtUtc = time.GetUtcNow().UtcDateTime.AddDays(7);
        await database.SaveChangesAsync(ct);
        return true;
    }

    public async Task RemoveAsync(string userId, string id, CancellationToken ct)
    {
        var device = await database.Set<NativeNotificationDevice>().SingleOrDefaultAsync(d => d.UserId == userId && d.Id == id, ct);
        if (device is not null) { database.Remove(device); await database.SaveChangesAsync(ct); }
    }

    internal sealed record Delivery(int Count, HashSet<string> ReplacedEndpoints);
    internal async Task<Delivery> SendAsync(string userId, PushNotificationService.PushMessage message, CancellationToken ct, string? endpoint = null, PushNotificationService.PushMessage? watchBriefing = null)
    {
        var now = time.GetUtcNow().UtcDateTime;
        var devices = await database.Set<NativeNotificationDevice>().Where(d => d.UserId == userId && d.ExpiresAtUtc > now && (endpoint == null || d.BrowserEndpoint == endpoint)).ToArrayAsync(ct);
        var replaced = new HashSet<string>(StringComparer.Ordinal);
        var count = 0;
        // Wait for installations concurrently so multiple offline phones cannot
        // multiply the browser fallback delay. EF changes are applied sequentially afterwards.
        var attempts = await Task.WhenAll(devices.Where(d => d.Kind == "phone").Select(async device =>
        {
            var id = Guid.NewGuid().ToString("N");
            var confirmation = receipts.Begin(id, userId, device.Id);
            var elapsed = Stopwatch.StartNew();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(12));
            try
            {
                var data = new Dictionary<string, string> {
                    ["title"] = message.Title, ["body"] = message.Body, ["url"] = message.Url, ["tag"] = message.Tag,
                    ["accountKey"] = AccountKey(userId), ["id"] = id,
                    ["sentAt"] = time.GetUtcNow().ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture),
                };
                if (watchBriefing is not null)
                {
                    data["watchAllowed"] = watchBriefing.WatchAllowed ? "true" : "false";
                    data["watchTitle"] = watchBriefing.Title;
                    data["watchBody"] = watchBriefing.Body;
                }
                BoundPayload(data);
                NativePushResult result;
                try { result = await sender.SendAsync(device.Token, data, deadline.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return (device, NativePushResult.Unavailable, false); }
                if (result != NativePushResult.Delivered) return (device, result, false);
                var displayed = false;
                var remaining = TimeSpan.FromSeconds(12) - elapsed.Elapsed;
                try { if (remaining > TimeSpan.Zero) displayed = await confirmation.WaitAsync(remaining, ct); }
                catch (TimeoutException) { /* Preserve browser delivery when Android did not post the alert. */ }
                return (device, result, displayed);
            }
            finally { receipts.End(id); }
        }));
        foreach (var (device, result, displayed) in attempts)
        {
            if (result == NativePushResult.Unregistered) database.Remove(device);
            if (displayed) {
                count++;
                if (device.BrowserEndpoint is not null) replaced.Add(device.BrowserEndpoint);
            }
        }
        await database.SaveChangesAsync(ct);
        return new(count, replaced);
    }

    internal static void BoundPayload(Dictionary<string, string> data)
    {
        foreach (var key in new[] { "title", "watchTitle" })
            if (data.TryGetValue(key, out var title)) data[key] = Truncate(title, 160);
        while (Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(data)) > 3800)
        {
            var key = new[] { "body", "watchBody" }.Where(data.ContainsKey)
                .OrderByDescending(k => data[k].Length).FirstOrDefault(k => data[k].Length > 0);
            if (key is null) throw new InvalidOperationException("Native push metadata exceeds the delivery budget.");
            data[key] = Truncate(data[key], Math.Max(0, data[key].Length - 20));
        }
    }

    private static string Truncate(string value, int limit)
    {
        if (value.Length <= limit) return value;
        if (limit > 0 && char.IsHighSurrogate(value[limit - 1])) limit--;
        return value[..limit];
    }
}
