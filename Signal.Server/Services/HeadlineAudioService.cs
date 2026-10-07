using System.Runtime.Versioning;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed record HeadlineAudioRequest(string[] Titles, int Seconds = 6, string Language = "en-NZ");
public sealed record HeadlineAudio(byte[] Wave, double[] Starts);

public sealed class HeadlineAudioService
{
    private const int SampleRate = 16_000;
    private const int BytesPerSecond = SampleRate * 2;
    private const int MaximumAudioBytes = 64 * 1024 * 1024;
    private readonly SemaphoreSlim generation = new(1, 1);

    internal static string[] Validate(HeadlineAudioRequest request)
    {
        if (request.Titles is not { Length: > 0 and <= 200 }
            || request.Seconds is not (3 or 6 or 10 or 15)
            || request.Titles.Any(title => string.IsNullOrWhiteSpace(title) || title.Length > 1_000)
            || request.Titles.Sum(title => title.Length) > 20_000)
            throw new ArgumentException("This briefing is too long to prepare as audio. Try a shorter briefing.");
        return request.Titles.Select(title => Regex.Replace(title, @"\s+", " ").Trim()).ToArray();
    }

    public async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken cancellationToken)
    {
        var titles = Validate(request);
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Screen-off audio is unavailable on this server.");
        if (!await generation.WaitAsync(TimeSpan.FromSeconds(3), cancellationToken))
            throw new InvalidOperationException("Another briefing is being prepared. Please try again shortly.");
        try
        {
            return await Task.Run(() =>
            {
                if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
                return GenerateWindows(titles, request.Seconds, request.Language, cancellationToken);
            }, cancellationToken);
        }
        finally
        {
            generation.Release();
        }
    }

    [SupportedOSPlatform("windows")]
    private static HeadlineAudio GenerateWindows(string[] titles, int seconds, string language, CancellationToken cancellationToken)
    {
        using var pcm = new MemoryStream();
        using var synth = new SpeechSynthesizer();
        var voices = synth.GetInstalledVoices().Where(voice => voice.Enabled).Select(voice => voice.VoiceInfo).ToArray();
        synth.SetOutputToAudioStream(pcm, new SpeechAudioFormatInfo(SampleRate, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
        var starts = new double[titles.Length];
        var silence = new byte[BytesPerSecond];
        for (var index = 0; index < titles.Length; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var title = titles[index];
            var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
            var desired = chinese ? "zh" : "en";
            var voice = voices.Where(candidate => candidate.Culture.TwoLetterISOLanguageName == desired)
                .OrderByDescending(candidate => candidate.Culture.Name.Equals(language, StringComparison.OrdinalIgnoreCase))
                .ThenByDescending(candidate => desired == "en" && candidate.Culture.Name is "en-GB" or "en-AU" or "en-NZ")
                .FirstOrDefault();
            if (voice is null)
                throw new InvalidOperationException($"A {desired} voice is unavailable for this briefing.");
            synth.SelectVoice(voice.Name);
            var startBytes = pcm.Length;
            starts[index] = startBytes / (double)BytesPerSecond;
            var text = Regex.IsMatch(title, @"[.!?。！？][""'”’]*$") ? title : title + (chinese ? "。" : ".");
            synth.Speak(text);
            // Keep the display interval and the gap inside the track, so neither needs a background timer.
            var spokenBytes = pcm.Length - startBytes;
            var remainingSilence = Math.Max((long)seconds * BytesPerSecond - spokenBytes, (long)(0.65 * BytesPerSecond));
            while (remainingSilence > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var length = (int)Math.Min(silence.Length, remainingSilence);
                pcm.Write(silence, 0, length);
                remainingSilence -= length;
            }
            if (pcm.Length > MaximumAudioBytes)
                throw new ArgumentException("This briefing is too long to prepare as audio. Try a shorter briefing.");
        }
        synth.SetOutputToNull();
        using var wave = new MemoryStream(checked((int)pcm.Length + 44));
        using (var writer = new BinaryWriter(wave, Encoding.ASCII, leaveOpen: true))
        {
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(checked((int)pcm.Length + 36));
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)1);
            writer.Write(SampleRate);
            writer.Write(BytesPerSecond);
            writer.Write((short)2);
            writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(checked((int)pcm.Length));
        }
        pcm.Position = 0;
        pcm.CopyTo(wave);
        return new HeadlineAudio(wave.ToArray(), starts);
    }
}
