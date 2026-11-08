using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class AzureSpeechAudioRenderer
{
    private const int BytesPerSecond = 32_000;
    private readonly AzureSpeechOptions settings;
    private readonly HttpClient client;
    private readonly IAzureSpeechSynthesizer synth;
    private readonly HeadlineAudioClipCache cache;
    private readonly SemaphoreSlim voiceLock = new(1, 1);
    private IReadOnlyList<NarrationVoice>? voices;
    private DateTimeOffset voicesExpire;

    internal AzureSpeechAudioRenderer(IOptions<AzureSpeechOptions> options, HttpClient client, IAzureSpeechSynthesizer synth, string cacheDirectory)
    {
        settings = options.Value;
        this.client = client;
        this.synth = synth;
        cache = new HeadlineAudioClipCache(cacheDirectory);
    }

    public bool Enabled => settings.Enabled;
    internal bool BackgroundPreparationEnabled => Enabled && settings.Prewarm;
    internal string DefaultVoice(bool chinese) => chinese ? settings.ChineseVoice : settings.EnglishVoice;

    public async Task<IReadOnlyList<NarrationVoice>> GetVoicesAsync(CancellationToken token)
    {
        var available = (await GetAllVoicesAsync(token)).Where(voice => voice.Language.StartsWith("en-", StringComparison.OrdinalIgnoreCase)
            || voice.Language.StartsWith("zh-", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (available.Length == 0) throw new HeadlineAudioUnavailableException("voices", "Azure did not return any supported English or Chinese neural voices.");
        return available;
    }

    internal async Task<IReadOnlyList<NarrationVoice>> GetAllVoicesAsync(CancellationToken token)
    {
        settings.Validate();
        await voiceLock.WaitAsync(token);
        try
        {
            if (voices is not null && voicesExpire > DateTimeOffset.UtcNow) return voices;
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://{settings.Region}.tts.speech.microsoft.com/cognitiveservices/voices/list");
            request.Headers.Add("Ocp-Apim-Subscription-Key", settings.Key);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            if (!response.IsSuccessStatusCode)
                throw new HeadlineAudioUnavailableException("voices", "Azure Speech voice choices could not be loaded. Check the Speech resource key and region, then try again.");
            await using var input = await response.Content.ReadAsStreamAsync(token);
            using var body = new MemoryStream();
            var buffer = new byte[16_384];
            int read;
            while ((read = await input.ReadAsync(buffer, token)) > 0)
            {
                if (body.Length + read > 2 * 1024 * 1024) throw new InvalidOperationException("Azure's voice list exceeded the supported size.");
                body.Write(buffer, 0, read);
            }
            using var json = JsonDocument.Parse(body.ToArray());
            var available = json.RootElement.EnumerateArray()
                .Where(voice => Field(voice, "VoiceType") == "Neural" && Field(voice, "Status") == "GA")
                // Standard neural voices are supported by F0. HD voices have separate availability/pricing.
                .Where(voice => Regex.IsMatch(Field(voice, "ShortName"), "^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$"))
                .Select(voice => new NarrationVoice(Field(voice, "ShortName"), Field(voice, "DisplayName") + " (Azure Neural)", Field(voice, "Locale"), Field(voice, "Gender")))
                .DistinctBy(voice => voice.Id).OrderBy(voice => voice.Language).ThenBy(voice => voice.Name).ToArray();
            if (available.Length == 0) throw new HeadlineAudioUnavailableException("voices", "Azure did not return any supported neural voices.");
            voices = available;
            voicesExpire = DateTimeOffset.UtcNow.AddHours(12);
            return voices;
        }
        finally { voiceLock.Release(); }
    }

    private static string Field(JsonElement voice, string name) => voice.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString()! : "";

    internal static NarrationVoice ChooseVoice(IReadOnlyList<NarrationVoice> voices, string language, bool chinese, string? preferred, string configured)
        => RecordedNarration.ChooseVoice(voices, language, chinese, preferred, configured);

    internal sealed record Clip(string Voice, string Text);

    internal static string? ResolveMultilingualLanguage(string? language)
    {
        if (string.IsNullOrWhiteSpace(language)) return null;
        var trimmed = language.Trim();
        if (trimmed.Equals("zh-Hans", StringComparison.OrdinalIgnoreCase) || trimmed.Equals("zh-CN", StringComparison.OrdinalIgnoreCase))
            return "zh-Hans";
        if (trimmed.Equals("zh-Hant", StringComparison.OrdinalIgnoreCase) || trimmed.Equals("zh-TW", StringComparison.OrdinalIgnoreCase) || trimmed.Equals("zh-HK", StringComparison.OrdinalIgnoreCase))
            return "zh-Hant";
        var prefix = trimmed.Split('-')[0].ToLowerInvariant();
        return prefix switch
        {
            "ja" => "ja",
            "ko" => "ko",
            "fr" => "fr",
            "de" => "de",
            "es" => "es",
            "it" => "it",
            "pt" => "pt",
            "ar" => "ar",
            "hi" => "hi",
            _ => null,
        };
    }

    internal async Task<Clip[]> SelectVoiceClipsAsync(HeadlineAudioRequest request, string[] titles, CancellationToken token)
    {
        if (ResolveMultilingualLanguage(request.Language) is { } multiLanguage)
        {
            var allVoices = await GetAllVoicesAsync(token);
            return titles.Select(title =>
            {
                var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
                var configured = DefaultVoice(chinese);
                if (multiLanguage is "zh-Hans" or "zh-Hant"
                    && request.Voices?.GetValueOrDefault("zh") is { Length: > 0 } preferredZh
                    && allVoices.FirstOrDefault(v => v.Id.Equals(preferredZh, StringComparison.OrdinalIgnoreCase)) is { } matchedZh)
                {
                    return new Clip(matchedZh.Id, title);
                }
                var selected = SharedArticleAudioService.ChooseVoice(allVoices, multiLanguage, chinese, configured);
                return new Clip(selected.Id, title);
            }).ToArray();
        }

        var available = await GetVoicesAsync(token);
        return titles.Select(title =>
        {
            var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
            var voice = ChooseVoice(available, request.Language, chinese, request.Voices?.GetValueOrDefault(chinese ? "zh" : "en"), chinese ? settings.ChineseVoice : settings.EnglishVoice);
            return new Clip(voice.Id, title);
        }).ToArray();
    }

    private async Task<Clip[]> GetClipsAsync(HeadlineAudioRequest request, CancellationToken token)
    {
        var titles = HeadlineAudioService.Validate(request);
        var rawClips = await SelectVoiceClipsAsync(request, titles, token);
        return rawClips.Select(NormalizeClip).ToArray();
    }

    internal async Task<HeadlineAudio?> GetCachedAsync(HeadlineAudioRequest request, CancellationToken token)
        => GetCached(await GetClipsAsync(request, token), request.Seconds);

    internal HeadlineAudio? GetCached(IReadOnlyList<Clip> clips, int seconds)
    {
        var pcm = clips.Select(clip => cache.TryGet("azure-v1/" + clip.Voice, clip.Text)).ToArray();
        return pcm.All(clip => clip is not null) ? Assemble(pcm.Select(clip => clip!).ToArray(), seconds) : null;
    }

    internal static Clip NormalizeClip(Clip clip)
        => clip with { Text = Regex.IsMatch(clip.Text, @"[.!?。！？][""'”’]*$") ? clip.Text
            : clip.Text + (clip.Text.Any(character => character is >= '\u3400' and <= '\u9fff') ? "。" : ".") };

    public async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken token)
    {
        var clips = await GetClipsAsync(request, token);
        var pcm = new Dictionary<Clip, byte[]>();
        var missing = new List<Clip>();
        cache.Prune();
        foreach (var clip in clips.Distinct())
        {
            token.ThrowIfCancellationRequested();
            if (cache.TryGet("azure-v1/" + clip.Voice, clip.Text) is { } ready) pcm[clip] = ready;
            else missing.Add(clip);
        }
        // Bookmarks let one cloud transaction generate many clips while preserving
        // exact positions. Bound text and voice tags below Azure's per-request limits.
        while (missing.Count > 0)
        {
            token.ThrowIfCancellationRequested();
            var batch = new List<Clip>();
            var characters = 0;
            foreach (var clip in missing)
            {
                if (batch.Count == 50 || (batch.Count > 0 && characters + clip.Text.Length > 4_000)) break;
                batch.Add(clip);
                characters += clip.Text.Length;
            }
            var rendered = await synth.SynthesizeAsync(CreateSsml(batch), token);
            var segments = SplitClips(rendered, batch.Count);
            // Validate the entire batch before caching any of its clips.
            for (var index = 0; index < batch.Count; index++)
            {
                token.ThrowIfCancellationRequested();
                var clip = batch[index];
                pcm[clip] = segments[index];
                cache.Store("azure-v1/" + clip.Voice, clip.Text, segments[index]);
            }
            missing.RemoveRange(0, batch.Count);
        }
        var result = Assemble(clips.Select(clip => pcm[clip]).ToArray(), request.Seconds);
        cache.Prune();
        return result;
    }

    internal static string CreateSsml(IReadOnlyList<Clip> clips)
    {
        XNamespace ns = "http://www.w3.org/2001/10/synthesis";
        return new XElement(ns + "speak", new XAttribute("version", "1.0"), new XAttribute(XNamespace.Xml + "lang", "en-US"),
            clips.Select((clip, index) => new XElement(ns + "voice", new XAttribute("name", clip.Voice),
                new XElement(ns + "bookmark", new XAttribute("mark", $"clip-{index}-start")),
                new XText(clip.Text),
                // Azure can omit bookmarks after sentence-ending punctuation.
                // Split at the next start marker (or PCM end) instead, retaining
                // all speech and this short spacer in the cached clip.
                new XElement(ns + "break", new XAttribute("time", "100ms")))))
            .ToString(SaveOptions.DisableFormatting);
    }

    internal static byte[][] SplitClips(AzureSpeechBatch batch, int count)
    {
        if (batch.Pcm.Length is 0 or > 16 * 1024 * 1024 || batch.Pcm.Length % 2 != 0)
            throw new InvalidOperationException("Azure returned an invalid recording.");
        var segments = new byte[count][];
        var previousEnd = 0;
        for (var index = 0; index < count; index++)
        {
            if (!batch.Bookmarks.TryGetValue($"clip-{index}-start", out var startTicks)
                || startTicks / (double)TimeSpan.TicksPerSecond >= batch.Pcm.Length / (double)BytesPerSecond)
                throw new InvalidOperationException("Azure returned an incomplete recording. Try preparing audio again.");
            var start = checked((int)Math.Round(startTicks / (double)TimeSpan.TicksPerSecond * 16_000) * 2);
            var end = batch.Pcm.Length;
            if (index + 1 < count)
            {
                if (!batch.Bookmarks.TryGetValue($"clip-{index + 1}-start", out var nextTicks)
                    || nextTicks / (double)TimeSpan.TicksPerSecond >= batch.Pcm.Length / (double)BytesPerSecond)
                    throw new InvalidOperationException("Azure returned an incomplete recording. Try preparing audio again.");
                end = checked((int)Math.Round(nextTicks / (double)TimeSpan.TicksPerSecond * 16_000) * 2);
            }
            if (start < previousEnd || end <= start || batch.Pcm.AsSpan(start, end - start).IndexOfAnyExcept((byte)0) < 0)
                throw new InvalidOperationException("Azure returned missing or silent narration.");
            segments[index] = batch.Pcm[start..end];
            previousEnd = end;
        }
        return segments;
    }

    internal static HeadlineAudio Assemble(IReadOnlyList<byte[]> clips, int seconds) => RecordedNarration.Assemble(clips, seconds);

    public async Task<HeadlineAudio> GenerateDialogueAsync(
        IReadOnlyList<(string Speaker, string Text)> turns,
        int gapMilliseconds,
        CancellationToken token)
    {
        if (!Enabled)
            throw new HeadlineAudioUnavailableException("configuration", "Azure Neural speech is not configured on this server.");
        if (turns is not { Count: > 0 } || turns.Count > 30)
            throw new ArgumentException("Daily Cast audio supports between 1 and 30 turns.");

        var normalized = new List<(string Speaker, string Text)>(turns.Count);
        var totalChars = 0;
        foreach (var (speaker, rawText) in turns)
        {
            var text = Regex.Replace(rawText ?? "", @"\s+", " ").Trim();
            if (text.Length == 0 || text.Length > 1_000)
                throw new ArgumentException("Each dialogue turn must be between 1 and 1,000 characters.");
            totalChars += text.Length;
            if (totalChars > 12_000)
                throw new ArgumentException("This Daily Cast script exceeds the 12,000-character synthesis limit.");
            normalized.Add((speaker, text));
        }

        var available = await GetVoicesAsync(token);
        var englishVoices = available
            .Where(v => v.Language.StartsWith("en-", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (englishVoices.Length == 0)
            throw new HeadlineAudioUnavailableException("voices", "No English neural voices are available for Daily Cast.");

        var davidVoice =
            englishVoices.FirstOrDefault(v => v.Id.Equals("en-US-AndrewNeural", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => v.Id.Equals("en-US-BrianNeural", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => v.Id.Equals("en-US-GuyNeural", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => v.Gender.Equals("Male", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices[0];

        var sarahVoice =
            englishVoices.FirstOrDefault(v => v.Id.Equals(settings.EnglishVoice, StringComparison.OrdinalIgnoreCase) && !v.Id.Equals(davidVoice.Id, StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => v.Id.Equals("en-US-AvaNeural", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => v.Id.Equals("en-US-JennyNeural", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => v.Gender.Equals("Female", StringComparison.OrdinalIgnoreCase))
            ?? englishVoices.FirstOrDefault(v => !v.Id.Equals(davidVoice.Id, StringComparison.OrdinalIgnoreCase))
            ?? englishVoices[0];

        var clips = normalized
            .Select(turn =>
            {
                var isDavid = string.Equals(turn.Speaker, "david", StringComparison.OrdinalIgnoreCase);
                return NormalizeClip(new Clip(isDavid ? davidVoice.Id : sarahVoice.Id, turn.Text));
            })
            .ToArray();

        var pcm = new Dictionary<Clip, byte[]>();
        var missing = new List<Clip>();
        cache.Prune();
        foreach (var clip in clips.Distinct())
        {
            token.ThrowIfCancellationRequested();
            if (cache.TryGet("azure-v1/" + clip.Voice, clip.Text) is { } ready) pcm[clip] = ready;
            else missing.Add(clip);
        }

        while (missing.Count > 0)
        {
            token.ThrowIfCancellationRequested();
            var batch = new List<Clip>();
            var characters = 0;
            foreach (var clip in missing)
            {
                if (batch.Count == 50 || (batch.Count > 0 && characters + clip.Text.Length > 4_000)) break;
                batch.Add(clip);
                characters += clip.Text.Length;
            }
            var rendered = await synth.SynthesizeAsync(CreateSsml(batch), token);
            var segments = SplitClips(rendered, batch.Count);
            for (var index = 0; index < batch.Count; index++)
            {
                token.ThrowIfCancellationRequested();
                var clip = batch[index];
                pcm[clip] = segments[index];
                cache.Store("azure-v1/" + clip.Voice, clip.Text, segments[index]);
            }
            missing.RemoveRange(0, batch.Count);
        }

        var result = AssembleDialogue(clips.Select(clip => pcm[clip]).ToArray(), gapMilliseconds);
        cache.Prune();
        return result;
    }

    internal static HeadlineAudio AssembleDialogue(IReadOnlyList<byte[]> clips, int gapMilliseconds)
    {
        var boundedGapMs = Math.Clamp(gapMilliseconds, 100, 3_000);
        var gapBytes = (boundedGapMs * BytesPerSecond / 1000) & ~1;
        using var pcm = new MemoryStream();
        var starts = new double[clips.Count];
        var silence = new byte[Math.Min(gapBytes, BytesPerSecond)];
        for (var index = 0; index < clips.Count; index++)
        {
            starts[index] = pcm.Length / (double)BytesPerSecond;
            var clip = clips[index];
            if (pcm.Length + clip.Length + gapBytes > 64 * 1024 * 1024)
                throw new ArgumentException("This Daily Cast recording is too long to prepare.");
            pcm.Write(clip);
            if (index + 1 < clips.Count)
            {
                var remaining = gapBytes;
                while (remaining > 0)
                {
                    var length = Math.Min(remaining, silence.Length);
                    pcm.Write(silence, 0, length);
                    remaining -= length;
                }
            }
        }
        using var wave = new MemoryStream(checked((int)pcm.Length + 44));
        using (var writer = new BinaryWriter(wave, Encoding.ASCII, leaveOpen: true))
        {
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(checked((int)pcm.Length + 36));
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
            writer.Write((short)1); writer.Write((short)1); writer.Write(16_000); writer.Write(BytesPerSecond);
            writer.Write((short)2); writer.Write((short)16); writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(checked((int)pcm.Length));
        }
        pcm.Position = 0;
        pcm.CopyTo(wave);
        return new HeadlineAudio(wave.ToArray(), starts);
    }
}
