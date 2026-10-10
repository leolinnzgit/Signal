using System.Text;

namespace Signal.Server.Services;

internal static class RecordedNarration
{
    private const int BytesPerSecond = 32_000;

    internal static NarrationVoice ChooseVoice(IReadOnlyList<NarrationVoice> voices, string language, bool chinese, string? preferred, string configured)
    {
        var desired = chinese ? "zh" : "en";
        var available = voices.Where(voice => voice.Language.StartsWith(desired + "-", StringComparison.OrdinalIgnoreCase)).ToArray();
        return available.FirstOrDefault(voice => voice.Id.Equals(preferred, StringComparison.OrdinalIgnoreCase))
            ?? available.FirstOrDefault(voice => voice.Id.Equals(configured, StringComparison.OrdinalIgnoreCase))
            ?? available.OrderByDescending(voice => voice.Gender.Equals("Female", StringComparison.OrdinalIgnoreCase))
                .ThenByDescending(voice => voice.Language.Equals(language, StringComparison.OrdinalIgnoreCase))
                .FirstOrDefault()
            ?? throw new HeadlineAudioUnavailableException("voices", $"No available {desired} reading voice.");
    }

    internal static HeadlineAudio Assemble(IReadOnlyList<byte[]> clips, int seconds)
    {
        using var pcm = new MemoryStream();
        var starts = new double[clips.Count];
        var silence = new byte[BytesPerSecond];
        for (var index = 0; index < clips.Count; index++)
        {
            starts[index] = pcm.Length / (double)BytesPerSecond;
            var clip = clips[index];
            var gap = Math.Max(seconds * BytesPerSecond - clip.Length, (int)(0.65 * BytesPerSecond));
            if (pcm.Length + clip.Length + gap > 64 * 1024 * 1024)
                throw new ArgumentException("This briefing is too long to prepare as audio. Try a shorter briefing.");
            pcm.Write(clip);
            while (gap > 0)
            {
                var length = Math.Min(gap, silence.Length);
                pcm.Write(silence, 0, length);
                gap -= length;
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
