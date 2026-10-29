using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed record ListeningHandoffDocument(string Url, string Title, string Source, string[] Parts, int PartIndex, string Target = "phone", string ImageUrl = "", string? QueueVersion = null);
public sealed record ListeningHandoffCreated(string Id, string SourceToken, DateTimeOffset ExpiresAt, bool IsQueue = false, int QueueCount = 0);
public sealed record ListeningHandoffView(string Id, string Status, string Url, string Title, string Source,
    int PartIndex, int PartCount, DateTimeOffset ExpiresAt, string[]? Parts = null, string Target = "phone", string ImageUrl = "",
    bool IsQueue = false, int QueueCount = 0, string? QueueVersion = null, ListeningQueueDocument? Queue = null);

/// <summary>Bounded, account-scoped, two-phase transfers. No phone may play before a watch pause acknowledgement.</summary>
public sealed partial class ListeningHandoffService(TimeProvider? clock = null, int capacity = 256, ListeningQueueService? queues = null)
{
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private sealed class Entry(string user, ListeningHandoffDocument document, byte[] sourceHash, DateTimeOffset expiry)
    {
        public string User { get; } = user;
        public ListeningHandoffDocument Document { get; set; } = document;
        public int PartCount { get; } = document.Parts.Length;
        public byte[] SourceHash { get; } = sourceHash;
        public byte[]? ReceiverHash { get; set; }
        public DateTimeOffset Expiry { get; set; } = expiry;
        public string Status { get; set; } = "pending";
        public bool IsQueue { get; } = document.QueueVersion != null;
        public int QueueCount { get; set; }
        public string? ReadyBase { get; set; }
        public string? QueueVersion { get; set; }
        public ListeningQueueDocument? Queue { get; set; }
    }
    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex TokenPattern();
    public static bool ValidToken(string? value) => value is { Length: 64 } && TokenPattern().IsMatch(value);
    private static string Token() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private static byte[] Hash(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
    private static bool Matches(byte[]? hash, string? token) => hash is not null && ValidToken(token)
        && CryptographicOperations.FixedTimeEquals(hash, Hash(token!));
    private void Prune()
    {
        foreach (var key in entries.Where(pair => pair.Value.Expiry <= time.GetUtcNow()).Select(pair => pair.Key).ToArray()) entries.Remove(key);
    }
    private Entry? Find(string user, string id)
    {
        Prune();
        return ValidToken(id) && entries.TryGetValue(id, out var entry) && entry.User == user ? entry : null;
    }
    public static void Validate(ListeningHandoffDocument value)
    {
        if (value.QueueVersion != null && (value.QueueVersion == "0" || !ListeningQueueService.Version(value.QueueVersion))
            || value.ImageUrl is null || value.ImageUrl.Length > 2048 || (value.ImageUrl.Length > 0 &&
                (!Uri.TryCreate(value.ImageUrl, UriKind.Absolute, out var image) || image.Scheme != "https" || image.UserInfo.Length > 0 || image.IsLoopback))
            || value.Target is not ("phone" or "watch") || value.Url is null || value.Url.Length > 2048 || !Uri.TryCreate(value.Url, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length != 0 || uri.IsLoopback
            || string.IsNullOrWhiteSpace(value.Title) || value.Title.Length > 500 || value.Source is null || value.Source.Length > 256
            || value.Parts is null || value.Parts.Length is < 1 or > 190 || value.PartIndex < 0 || value.PartIndex >= value.Parts.Length
            || value.Parts.Any(part => string.IsNullOrWhiteSpace(part) || part.Length > 1000) || value.Parts.Sum(part => part.Length) > 19_500)
            throw new ArgumentException("Choose a full story with valid text and a saved speech section.");
    }
    public ListeningHandoffCreated Create(string user, ListeningHandoffDocument document)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(user);
        Validate(document);
        lock (gate)
        {
            var queueCount = 0;
            if (document.QueueVersion != null)
            {
                var progress = queues?.Get(user);
                if (progress?.Version != document.QueueVersion || !MatchesCurrent(progress.Document, document, document.PartIndex))
                    throw new ArgumentException("Listen later changed. Reopen the queue and start a new transfer.");
                queueCount = progress.Document!.Items.Length;
            }
            Prune();
            if (entries.Count >= capacity || entries.Values.Count(value => value.User == user && value.Status != "cancelled") >= 8)
                throw new InvalidOperationException("Listening transfers are busy. Cancel an old transfer or try again shortly.");
            var id = Token(); var source = Token(); var expiry = time.GetUtcNow().AddMinutes(5);
            entries.Add(id, new Entry(user, document with { Parts = document.Parts.ToArray() }, Hash(source), expiry) { QueueCount = queueCount });
            return new(id, source, expiry, document.QueueVersion != null, queueCount);
        }
    }
    public ListeningHandoffView? Get(string user, string id, string? receiverToken = null)
    {
        lock (gate)
        {
            var entry = Find(user, id);
            if (entry is null) return null;
            var document = entry.Document;
            return new(id, entry.Status, document.Url, document.Title, document.Source, document.PartIndex,
                entry.PartCount, entry.Expiry, entry.Status == "ready" && Matches(entry.ReceiverHash, receiverToken) ? document.Parts.ToArray() : null, document.Target, document.ImageUrl,
                entry.IsQueue, entry.QueueCount, entry.QueueVersion,
                entry.Status == "ready" && Matches(entry.ReceiverHash, receiverToken) && entry.Queue is { } q ? Clone(q) : null);
        }
    }
    public ListeningHandoffView[] Inbox(string user, bool queuesSupported = false)
    {
        lock (gate)
        {
            Prune();
            return entries.Where(pair => pair.Value.User == user && pair.Value.Document.Target == "watch" && pair.Value.Status == "pending" && (!pair.Value.IsQueue || queuesSupported))
                .Reverse().Select(pair => new ListeningHandoffView(pair.Key, pair.Value.Status, pair.Value.Document.Url,
                    pair.Value.Document.Title, pair.Value.Document.Source, pair.Value.Document.PartIndex,
                    pair.Value.PartCount, pair.Value.Expiry, Target: "watch", ImageUrl: pair.Value.Document.ImageUrl, IsQueue: pair.Value.IsQueue, QueueCount: pair.Value.QueueCount)).ToArray();
        }
    }
    public bool Accept(string user, string id, string receiverToken, string target = "phone", bool supportsQueue = false)
    {
        if (!ValidToken(receiverToken)) return false;
        lock (gate)
        {
            var entry = Find(user, id);
            if (entry is null || entry.Document.Target != target || entry.Status == "cancelled" || entry.IsQueue && !supportsQueue) return false;
            if (entry.Status != "pending") return Matches(entry.ReceiverHash, receiverToken); // Idempotent retry by the same browser.
            entry.ReceiverHash = Hash(receiverToken);
            entry.Status = "accepted";
            entry.Expiry = time.GetUtcNow().AddSeconds(45);
            return true;
        }
    }
    private static ListeningQueueDocument Clone(ListeningQueueDocument q) => q with { Items = q.Items.Select(item => item with { Parts = item.Parts.ToArray() }).ToArray() };
    private static bool MatchesCurrent(ListeningQueueDocument? q, ListeningHandoffDocument d, int part) => q?.CurrentUrl == d.Url
        && q.Items.Any(item => item.Url == d.Url && item.Title == d.Title && item.Source == d.Source && item.ImageUrl == d.ImageUrl
            && item.PartIndex == part && item.Parts.SequenceEqual(d.Parts));
    public bool Ready(string user, string id, string sourceToken, int partIndex, string? queueVersion = null)
    {
        lock (gate)
        {
            var entry = Find(user, id);
            if (entry is null || !Matches(entry.SourceHash, sourceToken) || entry.Status is not ("accepted" or "ready")) return false;
            if (partIndex < 0 || partIndex >= entry.Document.Parts.Length) return false;
            if (entry.Status == "ready") return partIndex == entry.Document.PartIndex && queueVersion == entry.ReadyBase;
            if (entry.IsQueue)
            {
                if (queues == null || queueVersion == null || !ListeningQueueService.Version(queueVersion)) return false;
                var progress = queues.Get(user);
                if (progress.Version != queueVersion || !MatchesCurrent(progress.Document, entry.Document, partIndex)) return false;
                // Rotate the durable revision, even for identical text: old offline writers cannot reclaim the queue.
                var result = queues.Apply(user, new(NativeNotificationService.AccountKey(user), queueVersion, id[..32], "save", progress.Document));
                if (!result.Accepted) return false;
                entry.Queue = result.Progress.Document; entry.QueueVersion = result.Progress.Version; entry.QueueCount = entry.Queue!.Items.Length;
            }
            else if (queueVersion != null) return false;
            entry.ReadyBase = queueVersion;
            entry.Document = entry.Document with { PartIndex = partIndex };
            entry.Status = "ready";
            entry.Expiry = time.GetUtcNow().AddMinutes(5);
            return true;
        }
    }
    public bool Cancel(string user, string id, string? sourceToken, string? receiverToken)
    {
        lock (gate)
        {
            var entry = Find(user, id);
            if (entry is null || entry.Status == "ready") return false;
            if (!Matches(entry.SourceHash, sourceToken) && !(ValidToken(receiverToken)
                && (entry.Status == "pending" || Matches(entry.ReceiverHash, receiverToken)))) return false;
            entry.Status = "cancelled";
            entry.Document = entry.Document with { Parts = [] };
            entry.Queue = null;
            entry.Expiry = time.GetUtcNow().AddSeconds(30);
            return true;
        }
    }
}
