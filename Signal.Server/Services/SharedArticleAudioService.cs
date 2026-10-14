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
    internal const long MaximumCacheBytes = 128 * 1024 * 1024;
    internal static readonly TimeSpan CacheLifetime = TimeSpan.FromDays(30);
    internal sealed record Recording(string Path, AzureSpeechAudioRenderer.Clip[] Clips);

    internal SharedArticleAudioService(AzureSpeechAudioRenderer azure, IAzureSpeechStreamer synth, string directory)
    {
        this.azure = azure;
        this.synth = synth;
        this.directory = directory;
    }

    internal async Task<Recording> PrepareAsync(SharedNewsArticle article, CancellationToken token)
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
        var clips = texts.SelectMany(text => ArticleNarrationParts.SplitText(text, 900))
            .Select(text => new AzureSpeechAudioRenderer.Clip(voice.Id, text)).ToArray();
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(
            new { Version = 1, Voice = voice.Id, article.Language, Texts = texts }))));
        var path = Path.Combine(directory, key + ".mp3");
        Prune(path);
        return new(path, clips);
    }

    internal static NarrationVoice ChooseVoice(IReadOnlyList<NarrationVoice> voices, string language, bool chinese, string configured)
    {
        var locale = language switch
        {
            "zh-Hans" => "zh-CN", "zh-Hant" => "zh-TW", "en" => "en-NZ", "ja" => "ja-JP",
            "ko" => "ko-KR", "fr" => "fr-FR", "de" => "de-DE", "es" => "es-ES", "it" => "it-IT",
            "pt" => "pt-BR", "ar" => "ar-SA", "hi" => "hi-IN", "" => chinese ? "zh-TW" : "en-NZ",
            _ => throw new ArgumentException("The saved story language is unsupported."),
        };
        var prefix = locale[..2] + "-";
        // Chinese script must match the saved translation, even if the account's default differs.
        var available = voices.Where(voice => language is "zh-Hans" or "zh-Hant"
            ? voice.Language.Equals(locale, StringComparison.OrdinalIgnoreCase)
            : voice.Language.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).ToArray();
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
            return file.Exists && file.Length is > 0 and <= 32 * 1024 * 1024
                && file.LastWriteTimeUtc >= DateTime.UtcNow - CacheLifetime;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    internal void Prune(string? keep = null) => DerivedAudioCachePruner.Prune(directory, [".mp3"], MaximumCacheBytes, CacheLifetime, keep);

    internal async Task WriteAsync(Recording recording, Stream output, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(8));
        if (!await generation.WaitAsync(TimeSpan.FromSeconds(30), deadline.Token))
            throw new HeadlineAudioUnavailableException("busy", "Signal is preparing another recording. Please try again shortly.");
        string? temporary = null;
        try
        {
            if (IsCached(recording))
            {
                await using var cached = File.OpenRead(recording.Path);
                await cached.CopyToAsync(output, deadline.Token);
                return;
            }
            Directory.CreateDirectory(directory);
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
                    var duration = await synth.StreamAsync(ArticleAudioStreamService.CreateSsml(batch), async (bytes, cancellation) =>
                    {
                        if (cached.Length + bytes.Length > 32 * 1024 * 1024)
                            throw new HeadlineAudioUnavailableException("size", "This story's recording is too large.");
                        await cached.WriteAsync(bytes, cancellation);
                        await output.WriteAsync(bytes, cancellation);
                        await output.FlushAsync(cancellation);
                    }, (_, _) => { }, deadline.Token);
                    if (duration <= TimeSpan.Zero) throw new HeadlineAudioUnavailableException("stream", "Azure returned incomplete audio.");
                    first += batch.Count;
                }
                if (cached.Length == 0) throw new HeadlineAudioUnavailableException("stream", "Azure returned no audio.");
                await cached.FlushAsync(deadline.Token);
            }
            deadline.Token.ThrowIfCancellationRequested();
            File.Move(temporary, recording.Path, overwrite: true);
            temporary = null;
            Prune(recording.Path);
        }
        finally
        {
            if (temporary is not null && File.Exists(temporary)) File.Delete(temporary);
            generation.Release();
        }
    }
}
