using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Signal.Server.Services;

public sealed record ListeningQueueDocument(ListeningProgressDocument[] Items, string? CurrentUrl);
public sealed record ListeningQueueMutation(string AccountKey, string BaseVersion, string OperationId, string Action, ListeningQueueDocument? Document = null);
public sealed record ListeningQueueState(string Version, string State, DateTimeOffset UpdatedAt, ListeningQueueDocument? Document = null,
    string? OperationId = null, string? OperationHash = null);
public sealed record ListeningQueueResult(bool Accepted, ListeningQueueState Progress);

/// <summary>One bounded queue per account, independent of legacy single-story progress. Terminal revisions survive clearing text, preventing stale offline resurrection.</summary>
public sealed class ListeningQueueService
{
    private readonly string directory;
    private readonly object gate = new();
    private readonly TimeProvider clock;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public ListeningQueueService(IWebHostEnvironment environment) : this(Path.Combine(environment.ContentRootPath, "App_Data", "listening-queue")) { }
    public ListeningQueueService(string directory, TimeProvider? clock = null) { this.directory = directory; this.clock = clock ?? TimeProvider.System; }
    public static bool Version(string? value) => value == "0" || (value is { Length: 32 } && Guid.TryParseExact(value, "N", out _));
    private string PathFor(string user) => Path.Combine(directory, NativeNotificationService.AccountKey(user) + ".json");
    public static void Validate(ListeningQueueMutation value)
    {
        if (!Version(value.BaseVersion) || value.OperationId is not { Length: 32 } || !Guid.TryParseExact(value.OperationId, "N", out _)
            || value.Action is not ("save" or "complete" or "forget") || (value.Action == "save") != (value.Document != null))
            throw new ArgumentException("The Listen later update is invalid.");
        if (value.Document is { } d) ValidateDocument(d);
    }
    public static void ValidateDocument(ListeningQueueDocument d)
    {
        if (d.Items is null || d.Items.Length > 10 || d.Items.Any(x => x is null)
            || d.Items.Select(x => x.Url).Distinct(StringComparer.Ordinal).Count() != d.Items.Length
            || (d.Items.Length == 0 ? d.CurrentUrl != null : !d.Items.Any(x => x.Url == d.CurrentUrl)))
            throw new ArgumentException("Listen later holds up to 10 unique stories and a valid current story.");
        foreach (var item in d.Items) ListeningHandoffService.Validate(new(item.Url, item.Title, item.Source, item.Parts, item.PartIndex, ImageUrl: item.ImageUrl));
        if (d.Items.Sum(x => x.Parts.Sum(p => p.Length)) > 100_000)
            throw new ArgumentException("Listen later is full. Remove a story before adding more.");
    }
    private ListeningQueueState Read(string user)
    {
        var path = PathFor(user);
        if (!File.Exists(path)) return new("0", "empty", DateTimeOffset.UnixEpoch);
        // A broken file must fail closed: resetting to version zero could resurrect old offline writes.
        if (new FileInfo(path).Length > 1_500_000) throw new IOException("Listen later data needs repair.");
        ListeningQueueState state;
        try { state = JsonSerializer.Deserialize<ListeningQueueState>(File.ReadAllText(path), Json) ?? throw new IOException("Listen later data needs repair."); }
        catch (JsonException error) { throw new IOException("Listen later data needs repair.", error); }
        if (!Version(state.Version) || state.Version == "0" || state.State is not ("active" or "completed" or "forgotten")
            || (state.State == "active") != (state.Document != null)) throw new IOException("Listen later data needs repair.");
        if (state.Document is { } d) try { Validate(new("", state.Version, Guid.NewGuid().ToString("N"), "save", d)); }
            catch (ArgumentException error) { throw new IOException("Listen later data needs repair.", error); }
        return state;
    }
    private static ListeningQueueDocument Clone(ListeningQueueDocument d) => d with { Items = d.Items.Select(item => item with { Parts = item.Parts.ToArray() }).ToArray() };
    private static ListeningQueueState Copy(ListeningQueueState value) => value with { Document = value.Document is { } d ? Clone(d) : null };
    private FileStream FileLock(string user)
    {
        Directory.CreateDirectory(directory);
        for (var attempt = 0; ; attempt++)
        {
            try { return new FileStream(PathFor(user) + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 50) { Thread.Sleep(10); }
        }
    }
    public ListeningQueueState Get(string user) { lock (gate) { using var fileLock = FileLock(user); return Copy(Read(user)); } }
    public ListeningQueueResult Apply(string user, ListeningQueueMutation mutation)
    {
        if (mutation.AccountKey != NativeNotificationService.AccountKey(user)) throw new UnauthorizedAccessException("The Signal account changed. Sign in again.");
        Validate(mutation);
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(mutation, Json))));
        lock (gate)
        {
            using var fileLock = FileLock(user);
            var current = Read(user);
            if (current.OperationId == mutation.OperationId) return new(current.OperationHash == digest, Copy(current));
            if (current.Version != mutation.BaseVersion) return new(false, Copy(current));
            var next = new ListeningQueueState(Guid.NewGuid().ToString("N"), mutation.Action switch { "save" => "active", "complete" => "completed", _ => "forgotten" },
                clock.GetUtcNow(), mutation.Document is { } d ? Clone(d) : null, mutation.OperationId, digest);
            Directory.CreateDirectory(directory);
            var path = PathFor(user); var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { JsonSerializer.Serialize(stream, next, Json); stream.Flush(true); }
                File.Move(temporary, path, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return new(true, Copy(next));
        }
    }
}
