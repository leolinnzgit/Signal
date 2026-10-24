using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class NativeNotificationChecks
{
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private sealed class Sender(NativeDeliveryReceipts receipts) : INativePushSender
    {
        public bool Ready { get; set; } = true;
        public NativePushResult Result { get; set; } = NativePushResult.Delivered;
        public string Account { get; set; } = "owner";
        public string Device { get; set; } = "phone1";
        public bool Confirm { get; set; } = true;
        public int Sends { get; private set; }
        public Task<NativePushResult> SendAsync(string token, IReadOnlyDictionary<string, string> data, CancellationToken ct)
        {
            Sends++;
            Check(data["accountKey"] == NativeNotificationService.AccountKey(Account), "Native payloads must be scoped to their owning account.");
            if (Confirm) Check(receipts.Receive(data["id"], Account, Device, true), "A posted native notification must acknowledge its own delivery.");
            return Task.FromResult(Result);
        }
    }
    public static async Task RunAsync()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var database = new SignalDbContext(new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options);
        await database.Database.EnsureCreatedAsync();
        database.Users.AddRange(new ApplicationUser { Id = "owner", UserName = "owner" }, new ApplicationUser { Id = "other", UserName = "other" });
        database.UserPushSubscriptions.AddRange(
            new UserPushSubscription { UserId = "owner", Endpoint = "https://push.invalid/phone", P256Dh = "key", Auth = "auth" },
            new UserPushSubscription { UserId = "owner", Endpoint = "https://push.invalid/laptop", P256Dh = "key", Auth = "auth" },
            new UserPushSubscription { UserId = "other", Endpoint = "https://push.invalid/other", P256Dh = "key", Auth = "auth" });
        await database.SaveChangesAsync();
        var receipts = new NativeDeliveryReceipts();
        var sender = new Sender(receipts);
        var service = new NativeNotificationService(database, sender, receipts);
        var message = new PushNotificationService.PushMessage("New story", "Details", "/#top", 1);
        Check((await service.SendAsync("owner", message, default)).ReplacedEndpoints.Count == 0, "Without a companion all browser alerts must remain enabled.");
        var phone = new NativeNotificationDevice { Id = "phone1", Kind = "phone", Token = "token1", BrowserEndpoint = "https://push.invalid/phone" };
        sender.Ready = false;
        Check(!await service.RegisterAsync("owner", phone, default), "Missing push configuration must not switch off browser delivery.");
        sender.Ready = true;
        phone.BrowserEndpoint = "https://push.invalid/other";
        Check(!await service.RegisterAsync("owner", phone, default), "Another account's browser must never be linked.");
        phone.BrowserEndpoint = "https://push.invalid/phone";
        Check(await service.RegisterAsync("owner", phone, default), "The owner can link this phone's browser endpoint.");
        Check(!await service.RegisterAsync("other", new NativeNotificationDevice { Id = "phone1", Kind = "phone", Token = "different" }, default), "Installation IDs cannot cross account ownership.");
        var delivered = await service.SendAsync("owner", message, default);
        Check(delivered.Count == 1 && delivered.ReplacedEndpoints.SetEquals(["https://push.invalid/phone"]), "Only the explicitly linked endpoint can be replaced after Android posts the alert.");
        sender.Confirm = false;
        var unconfirmed = await service.SendAsync("owner", message, default);
        Check(unconfirmed.Count == 0 && unconfirmed.ReplacedEndpoints.Count == 0, "FCM acceptance without a phone display receipt must preserve browser delivery.");
        sender.Confirm = true;
        sender.Result = NativePushResult.Unavailable;
        Check((await service.SendAsync("owner", message, default)).ReplacedEndpoints.Count == 0, "FCM failures must preserve browser delivery.");
        sender.Result = NativePushResult.Unregistered;
        Check((await service.SendAsync("owner", message, default)).ReplacedEndpoints.Count == 0 && !await database.Set<NativeNotificationDevice>().AnyAsync(), "Uninstalled phone companions must be removed and resume browser alerts.");
        sender.Result = NativePushResult.Delivered;
        await service.RegisterAsync("owner", phone, default);
        var stored = await database.Set<NativeNotificationDevice>().SingleAsync();
        stored.ExpiresAtUtc = DateTime.UtcNow.AddSeconds(-1);
        await database.SaveChangesAsync();
        var sends = sender.Sends;
        Check((await service.SendAsync("owner", message, default)).Count == 0 && sender.Sends == sends, "Expired installations must not replace browser alerts.");
        await service.RemoveAsync("other", "phone1", default);
        Check(await database.Set<NativeNotificationDevice>().AnyAsync(), "Other accounts cannot unregister a phone.");
        await service.RemoveAsync("owner", "phone1", default);
        Check(!await database.Set<NativeNotificationDevice>().AnyAsync(), "Turning off native alerts restores normal browser delivery.");
        var waiting = receipts.Begin("receipt", "owner", "phone1");
        Check(!receipts.Receive("receipt", "other", "phone1", true) && !receipts.Receive("receipt", "owner", "other", true), "Receipts must match both account and installation.");
        Check(receipts.Receive("receipt", "owner", "phone1", false) && !waiting.IsCompleted, "Checking readiness is not proof of an Android notification.");
        Check(receipts.Receive("receipt", "owner", "phone1", true) && await waiting, "Only actual display confirms replacement.");
        receipts.End("receipt");
        Check(!receipts.Receive("receipt", "owner", "phone1", false), "Late native deliveries must be rejected after browser fallback.");
        var large = new Dictionary<string, string> { ["title"] = new string('新', 500), ["body"] = string.Concat(Enumerable.Repeat("📰新聞", 1000)), ["accountKey"] = new string('A', 64) };
        NativeNotificationService.BoundPayload(large);
        Check(System.Text.Encoding.UTF8.GetByteCount(System.Text.Json.JsonSerializer.Serialize(large)) <= 3800 && !large["body"].EndsWith('\ud83d'), "Unicode payloads must fit FCM without splitting an emoji.");
        Console.WriteLine("Native notification routing passed ownership, per-browser linking, display receipts, configuration, expiry, failure and uninstall fallback checks.");
    }
}
