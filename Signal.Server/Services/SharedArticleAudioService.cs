using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Signal.Server.Models;

namespace Signal.Server.Services;

// Only persisted shared stories can reach this service through the public endpoint.
// The cache is separate from temporary, authenticated reader audio sessions.
public sealed class SharedArticleAudioService
{
    private readonly AzureSpeechAudioRenderer azure;
    private readonly IAzureSpeechStreamer synth;
    private readonly string directory;
    private readonly SemaphoreSlim generation = new(1, 1);
    private readonly object timingGate = new();
    private Recording? active;
    private double?[] activeStarts = [];
    internal const long MaximumCacheBytes = 128 * 1024 * 1024;
    internal static readonly TimeSpan CacheLifetime = TimeSpan.FromDays(30);
    internal sealed record Recording(string Path, AzureSpeechAudioRenderer.Clip[] Clips, int[] Sections);
    internal sealed record Timing(double[] Starts, int[] Sections, bool Complete, double Duration);

    internal SharedArticleAudioService(AzureSpeechAudioRenderer azure, IAzureSpeechStreamer synth, string directory)
    {
        this.azure = azure;
        this.synth = synth;
        this.directory = directory;
    }

    internal async Task<Recording> PrepareAsync(SharedNewsArticle article, CancellationToken token, string? preferred = null)
    {
        if (!azure.Enabled) throw new HeadlineAudioUnavailableException("configuration", "Azure audio is not available on this Signal server.");
        var paragraphs = JsonSerializer.Deserialize<string[]>(article.ParagraphsJson) ?? [];
        if (article.Title.Length is 0 or > 2_000 || paragraphs.Length > 80
            || paragraphs.Any(string.IsNullOrWhiteSpace) || paragraphs.Sum(text => (long)text.Length) > 80_000)
            throw new ArgumentException("This saved story cannot be prepared as audio.");
        var texts = new[] { article.Title }.Concat(paragraphs).ToArray();
        var voices = await azure.GetAllVoicesAsync(token);
        var chinese = texts.Any(text => text.Any(character => character is >= '\u3400' and <= '\u9fff'));
        var voice = ChooseVoice(voices, article.Language, chinese, azure.DefaultVoice(chinese));
        if (!string.IsNullOrEmpty(preferred))
            voice = AvailableVoices(voices, article.Language, chinese).FirstOrDefault(item => item.Id == preferred)
                ?? throw new ArgumentException("Choose an available voice for this story's language.");
        var parts = texts.SelectMany((text, section) => ArticleNarrationParts.SplitText(text, 900)
            .Select(part => (Text: part, Section: section))).ToArray();
        var clips = parts.Select(part => new AzureSpeechAudioRenderer.Clip(voice.Id, part.Text)).ToArray();
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(
            new { Version = 2, Voice = voice.Id, article.Language, Texts = texts }))));
        var path = Path.Combine(directory, key + ".mp3");
        Prune(path);
        return new(path, clips, parts.Select(part => part.Section).ToArray());
    }

    private static string Locale(string language, bool chinese)
        => language switch
        {
            "zh-Hans" => "zh-CN", "zh-Hant" => "zh-TW", "en" => "en-NZ", "ja" => "ja-JP",
            "ko" => "ko-KR", "fr" => "fr-FR", "de" => "de-DE", "es" => "es-ES", "it" => "it-IT",
            "pt" => "pt-BR", "ar" => "ar-SA", "hi" => "hi-IN", "" => chinese ? "zh-TW" : "en-NZ",
            _ => throw new ArgumentException("The saved story language is unsupported."),
        };

    private static NarrationVoice[] AvailableVoices(IReadOnlyList<NarrationVoice> voices, string language, bool chinese)
    {
        var locale = Locale(language, chinese);
        var prefix = locale[..2] + "-";
        // Chinese script must match the saved translation, even if the account's default differs.
        return voices.Where(voice => language is "zh-Hans" or "zh-Hant"
            ? voice.Language.Equals(locale, StringComparison.OrdinalIgnoreCase)
            : voice.Language.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).ToArray();
    }

    internal async Task<object> GetVoicesAsync(SharedNewsArticle article, CancellationToken token)
    {
        var paragraphs = JsonSerializer.Deserialize<string[]>(article.ParagraphsJson) ?? [];
        var chinese = new[] { article.Title }.Concat(paragraphs).Any(text => text.Any(character => character is >= '\u3400' and <= '\u9fff'));
        var voices = await azure.GetAllVoicesAsync(token);
        return new { voices = AvailableVoices(voices, article.Language, chinese),
            selected = ChooseVoice(voices, article.Language, chinese, azure.DefaultVoice(chinese)).Id };
    }

    internal static NarrationVoice ChooseVoice(IReadOnlyList<NarrationVoice> voices, string language, bool chinese, string configured)
    {
        var locale = Locale(language, chinese);
        var available = AvailableVoices(voices, language, chinese);
        return available.OrderByDescending(voice => voice.Language.Equals(locale, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(voice => voice.Id.Equals(configured, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(voice => voice.Gender.Equals("Female", StringComparison.OrdinalIgnoreCase))
            .ThenBy(voice => voice.Id, StringComparer.Ordinal).FirstOrDefault()
            ?? throw new HeadlineAudioUnavailableException("voices", "Azure has no available voice for this story's language.");
    }

    internal static bool IsCached(Recording recording)
    {
        try
        {
            var file = new FileInfo(recording.Path);
            return file.Exists && File.Exists(recording.Path + ".json") && file.Length is > 0 and <= 32 * 1024 * 1024
                && file.LastWriteTimeUtc >= DateTime.UtcNow - CacheLifetime;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    internal Timing GetTiming(Recording recording)
    {
        lock (timingGate)
        {
            if (active?.Path == recording.Path)
            {
                var starts = activeStarts.TakeWhile(start => start.HasValue).Select(start => start!.Value).ToArray();
                return new(starts, recording.Sections.Take(starts.Length).ToArray(), false, 0);
            }
        }
        if (IsCached(recording))
        {
            try
            {
                return JsonSerializer.Deserialize<Timing>(File.ReadAllText(recording.Path + ".json"))
                    ?? new([], [], false, 0);
            }
            catch (IOException) { }
            catch (JsonException) { }
        }
        return new([], [], false, 0);
    }

    internal void Prune(string? keep = null)
    {
        DerivedAudioCachePruner.Prune(directory, [".mp3"], MaximumCacheBytes, CacheLifetime, keep);
        if (!Directory.Exists(directory)) return;
        foreach (var metadata in Directory.GetFiles(directory, "*.mp3.json"))
        {
            if (!DerivedAudioCachePruner.IsCacheFile(Path.GetFileName(metadata), [".mp3.json"]) || metadata == keep + ".json") continue;
            try { if (!File.Exists(metadata[..^5])) File.Delete(metadata); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    internal async Task WriteAsync(Recording recording, Stream output, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(8));
        if (!await generation.WaitAsync(TimeSpan.FromSeconds(30), deadline.Token))
            throw new HeadlineAudioUnavailableException("busy", "Signal is preparing another recording. Please try again shortly.");
        string? temporary = null;
        string? temporaryTiming = null;
        try
        {
            if (IsCached(recording))
            {
                await using var cached = File.OpenRead(recording.Path);
                await cached.CopyToAsync(output, deadline.Token);
                return;
            }
            Directory.CreateDirectory(directory);
            lock (timingGate) { active = recording; activeStarts = new double?[recording.Clips.Length]; }
            var elapsed = 0d;
            temporary = recording.Path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            await using (var cached = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16_384, useAsync: true))
            {
                for (var first = 0; first < recording.Clips.Length;)
                {
                    var batch = new List<AzureSpeechAudioRenderer.Clip>();
                    var characters = 0;
                    foreach (var clip in recording.Clips.Skip(first))
                    {
                        if (batch.Count > 0 && (batch.Count == 10 || characters + clip.Text.Length > 1500)) break;
                        batch.Add(clip);
                        characters += clip.Text.Length;
                    }
                    var offset = first;
                    var batchStart = elapsed;
                    var duration = await synth.StreamAsync(ArticleAudioStreamService.CreateSsml(batch), async (bytes, cancellation) =>
                    {
                        if (cached.Length + bytes.Length > 32 * 1024 * 1024)
                            throw new HeadlineAudioUnavailableException("size", "This story's recording is too large.");
                        await cached.WriteAsync(bytes, cancellation);
                        await output.WriteAsync(bytes, cancellation);
                        await output.FlushAsync(cancellation);
                    }, (mark, ticks) =>
                    {
                        if (mark.StartsWith("clip-", StringComparison.Ordinal) && mark.EndsWith("-start", StringComparison.Ordinal)
                            && int.TryParse(mark.AsSpan(5, mark.Length - 11), out var index) && index >= 0 && index < batch.Count)
                            lock (timingGate) activeStarts[offset + index] = batchStart + ticks / (double)TimeSpan.TicksPerSecond;
                    }, deadline.Token);
                    if (duration <= TimeSpan.Zero) throw new HeadlineAudioUnavailableException("stream", "Azure returned incomplete audio.");
                    elapsed += duration.TotalSeconds;
                    first += batch.Count;
                }
                if (cached.Length == 0) throw new HeadlineAudioUnavailableException("stream", "Azure returned no audio.");
                await cached.FlushAsync(deadline.Token);
            }
            deadline.Token.ThrowIfCancellationRequested();
            var timing = GetTiming(recording) with { Complete = true, Duration = elapsed };
            if (timing.Starts.Length != recording.Clips.Length || timing.Starts.Any(start => !double.IsFinite(start) || start < 0 || start >= elapsed)
                || timing.Starts.Zip(timing.Starts.Skip(1)).Any(pair => pair.Second <= pair.First))
                throw new HeadlineAudioUnavailableException("stream", "Azure returned incomplete narration timings.");
            temporaryTiming = recording.Path + ".json." + Guid.NewGuid().ToString("N") + ".tmp";
            await File.WriteAllTextAsync(temporaryTiming, JsonSerializer.Serialize(timing), deadline.Token);
            File.Move(temporary, recording.Path, overwrite: true);
            temporary = null;
            File.Move(temporaryTiming, recording.Path + ".json", overwrite: true);
            temporaryTiming = null;
            Prune(recording.Path);
        }
        finally
        {
            lock (timingGate) { active = null; activeStarts = []; }
            if (temporary is not null && File.Exists(temporary)) File.Delete(temporary);
            if (temporaryTiming is not null && File.Exists(temporaryTiming)) File.Delete(temporaryTiming);
            generation.Release();
        }
    }
}
