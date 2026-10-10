using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class KokoroAudioRenderer
{
    private readonly KokoroSpeechOptions settings;
    private readonly string directory;
    private readonly IKokoroSpeechWorker worker;
    private readonly HeadlineAudioClipCache cache;
    private IReadOnlyList<NarrationVoice>? voices;

    internal KokoroAudioRenderer(IOptions<KokoroSpeechOptions> options, IKokoroSpeechWorker worker, string contentRoot, string? cacheDirectory = null)
    {
        settings = options.Value;
        directory = string.IsNullOrWhiteSpace(settings.KokoroDirectory) ? Path.Combine(contentRoot, "App_Data", "Kokoro") : Path.GetFullPath(settings.KokoroDirectory);
        this.worker = worker;
        cache = new HeadlineAudioClipCache(cacheDirectory ?? Path.Combine(contentRoot, "App_Data", "HeadlineAudioClips"));
    }
    public bool Enabled => settings.Enabled;
    public IReadOnlyList<NarrationVoice> GetVoices()
    {
        if (voices is not null) return voices;
        var path = Path.Combine(directory, "voices.json");
        if (!File.Exists(Path.Combine(directory, "kokoro-v1.0.onnx")) || !File.Exists(Path.Combine(directory, "voices-v1.0.bin")) || !File.Exists(path))
            throw new HeadlineAudioUnavailableException("configuration", "Kokoro is not installed. Run Install Signal Kokoro on the server.");
        if (new FileInfo(path).Length > 64 * 1024) throw new InvalidOperationException("Kokoro voice catalog is too large.");
        var installed = JsonSerializer.Deserialize<NarrationVoice[]>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (installed is not { Length: > 0 } || installed.Any(voice => !Regex.IsMatch(voice.Id, @"^kokoro/[abz][fm]_[a-z0-9]+$") || voice.Language is not ("en-US" or "en-GB" or "zh-CN")))
            throw new InvalidOperationException("Kokoro voice catalog is invalid.");
        voices = installed;
        return voices;
    }

    public async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken token)
    {
        var titles = HeadlineAudioService.Validate(request);
        var installed = GetVoices();
        var clips = titles.Select(title =>
        {
            var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
            var voice = RecordedNarration.ChooseVoice(installed, request.Language, chinese, request.Voices?.GetValueOrDefault(chinese ? "zh" : "en"), "kokoro/" + (chinese ? settings.KokoroChineseVoice : settings.KokoroEnglishVoice));
            var text = Regex.IsMatch(title, @"[.!?。！？][""'”’]*$") ? title : title + (chinese ? "。" : ".");
            return new KokoroClip(voice.Id[7..], text);
        }).ToArray();
        var pcm = new Dictionary<KokoroClip, byte[]>();
        var missing = new List<KokoroClip>();
        cache.Prune();
        foreach (var clip in clips.Distinct())
        {
            token.ThrowIfCancellationRequested();
            if (cache.TryGet("kokoro-fp32-v1/" + clip.Voice, clip.Text) is { } ready) pcm[clip] = ready;
            else missing.Add(clip);
        }
        while (missing.Count > 0)
        {
            var batch = new List<KokoroClip>();
            var characters = 0;
            foreach (var clip in missing)
            {
                if (batch.Count == 50 || (batch.Count > 0 && characters + clip.Text.Length > 1000)) break;
                batch.Add(clip); characters += clip.Text.Length;
            }
            var audio = await worker.GenerateAsync(batch, token);
            if (audio.Length != batch.Count) throw new InvalidOperationException("Kokoro omitted narration clips.");
            for (var index = 0; index < batch.Count; index++)
            {
                token.ThrowIfCancellationRequested();
                cache.Store("kokoro-fp32-v1/" + batch[index].Voice, batch[index].Text, audio[index]);
                pcm[batch[index]] = audio[index];
            }
            missing.RemoveRange(0, batch.Count);
        }
        cache.Prune();
        return RecordedNarration.Assemble(clips.Select(clip => pcm[clip]).ToArray(), request.Seconds);
    }
}
