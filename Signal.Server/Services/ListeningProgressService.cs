using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Signal.Server.Services;

public sealed record ListeningProgressDocument(string Url, string Title, string Source, string[] Parts, int PartIndex, string ImageUrl = "");
public sealed record ListeningProgressMutation(string AccountKey, string BaseVersion, string OperationId, string Action, ListeningProgressDocument? Document = null);
public sealed record ListeningProgressState(string Version, string State, DateTimeOffset UpdatedAt, ListeningProgressDocument? Document = null,
    string? OperationId = null, string? OperationHash = null);
public sealed record ListeningProgressResult(bool Accepted, ListeningProgressState Progress);

/// <summary>One bounded snapshot per account. Terminal revisions survive clearing text, preventing stale offline resurrection.</summary>
public sealed class ListeningProgressService
{
    private readonly string directory;
    private readonly object gate = new();
    private readonly TimeProvider clock;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public ListeningProgressService(IWebHostEnvironment environment) : this(Path.Combine(environment.ContentRootPath, "App_Data", "listening-progress")) { }
    public ListeningProgressService(string directory, TimeProvider? clock = null) { this.directory = directory; this.clock = clock ?? TimeProvider.System; }
    public static bool Version(string? value) => value == "0" || (value is { Length: 32 } && Guid.TryParseExact(value, "N", out _));
    private string PathFor(string user) => Path.Combine(directory, NativeNotificationService.AccountKey(user) + ".json");
    public static void Validate(ListeningProgressMutation value)
    {
        if (!Version(value.BaseVersion) || value.OperationId is not { Length: 32 } || !Guid.TryParseExact(value.OperationId, "N", out _)
            || value.Action is not ("save" or "complete" or "forget") || (value.Action == "save") != (value.Document != null))
            throw new ArgumentException("The saved listening update is invalid.");
        if (value.Document is { } d) ListeningHandoffService.Validate(new(d.Url, d.Title, d.Source, d.Parts, d.PartIndex, ImageUrl: d.ImageUrl));
    }
    private ListeningProgressState Read(string user)
    {
        var path = PathFor(user);
        if (!File.Exists(path)) return new("0", "empty", DateTimeOffset.UnixEpoch);
        // A broken file must fail closed: resetting to version zero could resurrect old offline writes.
        if (new FileInfo(path).Length > 256_000) throw new IOException("Saved listening data needs repair.");
        ListeningProgressState state;
        try { state = JsonSerializer.Deserialize<ListeningProgressState>(File.ReadAllText(path), Json) ?? throw new IOException("Saved listening data needs repair."); }
        catch (JsonException error) { throw new IOException("Saved listening data needs repair.", error); }
        if (!Version(state.Version) || state.Version == "0" || state.State is not ("active" or "completed" or "forgotten")
            || (state.State == "active") != (state.Document != null)) throw new IOException("Saved listening data needs repair.");
        if (state.Document is { } d) try { Validate(new("", state.Version, Guid.NewGuid().ToString("N"), "save", d)); }
            catch (ArgumentException error) { throw new IOException("Saved listening data needs repair.", error); }
        return state;
    }
    private static ListeningProgressState Copy(ListeningProgressState value) => value with { Document = value.Document is { } d ? d with { Parts = d.Parts.ToArray() } : null };
    private FileStream FileLock(string user)
    {
        Directory.CreateDirectory(directory);
        for (var attempt = 0; ; attempt++)
        {
            try { return new FileStream(PathFor(user) + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 50) { Thread.Sleep(10); }
        }
    }
    public ListeningProgressState Get(string user) { lock (gate) { using var fileLock = FileLock(user); return Copy(Read(user)); } }
    public ListeningProgressResult Apply(string user, ListeningProgressMutation mutation)
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
            var next = new ListeningProgressState(Guid.NewGuid().ToString("N"), mutation.Action switch { "save" => "active", "complete" => "completed", _ => "forgotten" },
                clock.GetUtcNow(), mutation.Document is { } d ? d with { Parts = d.Parts.ToArray() } : null, mutation.OperationId, digest);
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
