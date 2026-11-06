using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Signal.Server.Services;

public sealed record BriefingProgressItem(string Url, string Title, string Source, string[] Parts, string ImageUrl = "", bool FullArticle = false, Dictionary<string, string>? CatchUpKeys = null);
public sealed record BriefingProgressDocument(BriefingProgressItem[] Items, int Index, int PartIndex, bool Shuffled = false, string[]? Heard = null, Dictionary<string, string>? CatchUpHeard = null);
public sealed record BriefingProgressMutation(string AccountKey, string BaseVersion, string OperationId, string Action, BriefingProgressDocument? Document = null);
public sealed record BriefingProgressState(string Version, string State, DateTimeOffset UpdatedAt, BriefingProgressDocument? Document = null,
    string? OperationId = null, string? OperationHash = null);
public sealed record BriefingProgressResult(bool Accepted, BriefingProgressState Progress);

/// <summary>Account-scoped compare-and-swap storage for briefing and catch-up queues, preserving completed catch-up fingerprints across devices.</summary>
public sealed class BriefingProgressService
{
    private readonly string directory;
    private readonly object gate = new();
    private readonly TimeProvider clock;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public BriefingProgressService(IWebHostEnvironment environment) : this(Path.Combine(environment.ContentRootPath, "App_Data", "briefing-progress")) { }
    public BriefingProgressService(string directory, TimeProvider? clock = null) { this.directory = directory; this.clock = clock ?? TimeProvider.System; }

    public static bool Version(string? value) => value == "0" || (value is { Length: 32 } && Guid.TryParseExact(value, "N", out _));
    private string PathFor(string user) => Path.Combine(directory, NativeNotificationService.AccountKey(user) + ".json");

    public static void Validate(BriefingProgressMutation value)
    {
        if (!Version(value.BaseVersion) || value.OperationId is not { Length: 32 } || !Guid.TryParseExact(value.OperationId, "N", out _)
            || value.Action is not ("save" or "complete" or "forget") || (value.Action == "save") != (value.Document != null))
            throw new ArgumentException("The saved briefing update is invalid.");
        if (value.Document is { } d) ValidateDocument(d);
    }

    public static void ValidateDocument(BriefingProgressDocument d)
    {
        if (d.Items is null || d.Items.Length > 20 || d.Items.Any(x => x is null))
            throw new ArgumentException("Briefing queue holds up to 20 stories.");
        if (d.Items.Length == 0)
        {
            if (d.Index != 0 || d.PartIndex != 0) throw new ArgumentException("Empty briefing queue must have index 0.");
        }
        else
        {
            if (d.Index < 0 || d.Index >= d.Items.Length) throw new ArgumentException("Briefing story index is out of range.");
            var current = d.Items[d.Index];
            if (d.PartIndex < 0 || d.PartIndex >= current.Parts.Length) throw new ArgumentException("Briefing part index is out of range.");
        }
        foreach (var item in d.Items)
        {
            ListeningHandoffService.Validate(new(item.Url, item.Title, item.Source, item.Parts, 0, ImageUrl: item.ImageUrl));
            if (item.CatchUpKeys is { Count: > 100 }) throw new ArgumentException("Too many catch-up keys per story.");
        }
        if (d.Items.Sum(x => x.Parts.Sum(p => p.Length)) > 100_000)
            throw new ArgumentException("Briefing queue text is too large to save.");
        if (d.Heard is { Length: > 50 }) throw new ArgumentException("Too many heard stories recorded.");
        if (d.CatchUpHeard is { Count: > 200 }) throw new ArgumentException("Too many catch-up fingerprints recorded.");
    }

    private BriefingProgressState Read(string user)
    {
        var path = PathFor(user);
        if (!File.Exists(path)) return new("0", "empty", DateTimeOffset.UnixEpoch);
        if (new FileInfo(path).Length > 500_000) throw new IOException("Saved briefing data needs repair.");
        BriefingProgressState state;
        try { state = JsonSerializer.Deserialize<BriefingProgressState>(File.ReadAllText(path), Json) ?? throw new IOException("Saved briefing data needs repair."); }
        catch (JsonException error) { throw new IOException("Saved briefing data needs repair.", error); }
        if (!Version(state.Version) || state.Version == "0" || state.State is not ("active" or "completed" or "forgotten")
            || (state.State == "active") != (state.Document != null)) throw new IOException("Saved briefing data needs repair.");
        if (state.Document is { } d)
        {
            try { Validate(new("", state.Version, Guid.NewGuid().ToString("N"), "save", d)); }
            catch (ArgumentException error) { throw new IOException("Saved briefing data needs repair.", error); }
        }
        return state;
    }

    private static BriefingProgressDocument Clone(BriefingProgressDocument d) =>
        new(d.Items.Select(item => item with { Parts = item.Parts.ToArray(), CatchUpKeys = item.CatchUpKeys is { } k ? new Dictionary<string, string>(k) : null }).ToArray(),
            d.Index, d.PartIndex, d.Shuffled, d.Heard?.ToArray(), d.CatchUpHeard is { } ch ? new Dictionary<string, string>(ch) : null);

    private static BriefingProgressState Copy(BriefingProgressState value) =>
        value with { Document = value.Document is { } d ? Clone(d) : null };

    private FileStream FileLock(string user)
    {
        Directory.CreateDirectory(directory);
        for (var attempt = 0; ; attempt++)
        {
            try { return new FileStream(PathFor(user) + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 50) { Thread.Sleep(10); }
        }
    }

    public BriefingProgressState Get(string user)
    {
        lock (gate)
        {
            using var fileLock = FileLock(user);
            return Copy(Read(user));
        }
    }

    public BriefingProgressResult Apply(string user, BriefingProgressMutation mutation)
    {
        if (mutation.AccountKey != NativeNotificationService.AccountKey(user))
            throw new UnauthorizedAccessException("The Signal account changed. Sign in again.");
        Validate(mutation);
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(mutation, Json))));

        lock (gate)
        {
            using var fileLock = FileLock(user);
            var current = Read(user);
            if (current.OperationId == mutation.OperationId)
                return new(current.OperationHash == digest, Copy(current));
            if (current.Version != mutation.BaseVersion)
                return new(false, Copy(current));

            BriefingProgressDocument? nextDoc = null;
            if (mutation.Action == "save" && mutation.Document is { } incoming)
            {
                // Merge catch-up heard fingerprints so neither device loses track of heard versions
                var mergedHeard = new Dictionary<string, string>(StringComparer.Ordinal);
                if (current.Document?.CatchUpHeard is { } prior)
                {
                    foreach (var (k, v) in prior) mergedHeard[k] = v;
                }
                if (incoming.CatchUpHeard is { } inc)
                {
                    foreach (var (k, v) in inc) mergedHeard[k] = v;
                }
                // Cap to latest 200
                if (mergedHeard.Count > 200)
                {
                    var excess = mergedHeard.Count - 200;
                    foreach (var key in mergedHeard.Keys.Take(excess).ToList()) mergedHeard.Remove(key);
                }

                nextDoc = Clone(incoming) with { CatchUpHeard = mergedHeard };
            }

            var next = new BriefingProgressState(
                Guid.NewGuid().ToString("N"),
                mutation.Action switch { "save" => "active", "complete" => "completed", _ => "forgotten" },
                clock.GetUtcNow(),
                nextDoc,
                mutation.OperationId,
                digest);

            Directory.CreateDirectory(directory);
            var path = PathFor(user);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    JsonSerializer.Serialize(stream, next, Json);
                    stream.Flush(true);
                }
                File.Move(temporary, path, true);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
            return new(true, Copy(next));
        }
    }
}
