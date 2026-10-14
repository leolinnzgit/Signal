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

    public async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken token)
    {
        var titles = HeadlineAudioService.Validate(request);
        var available = await GetVoicesAsync(token);
        var clips = titles.Select(title =>
        {
            var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
            var voice = ChooseVoice(available, request.Language, chinese, request.Voices?.GetValueOrDefault(chinese ? "zh" : "en"), chinese ? settings.ChineseVoice : settings.EnglishVoice);
            var text = Regex.IsMatch(title, @"[.!?。！？][""'”’]*$") ? title : title + (chinese ? "。" : ".");
            return new Clip(voice.Id, text);
        }).ToArray();
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
}
