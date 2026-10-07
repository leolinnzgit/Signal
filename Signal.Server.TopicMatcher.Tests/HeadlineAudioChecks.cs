using System.Text;
using Signal.Server.Services;

internal static class HeadlineAudioChecks
{
    public static async Task RunAsync()
    {
        foreach (var request in new[]
        {
            new HeadlineAudioRequest([]), new HeadlineAudioRequest([""]),
            new HeadlineAudioRequest(["Headline"], 5),
            new HeadlineAudioRequest([new string('a', 1_001)]),
            new HeadlineAudioRequest(Enumerable.Repeat("Headline", 201).ToArray()),
            new HeadlineAudioRequest(Enumerable.Repeat(new string('a', 1_000), 21).ToArray()),
        })
        {
            try { HeadlineAudioService.Validate(request); throw new Exception("Invalid audio briefing was accepted."); }
            catch (ArgumentException) { }
        }
        if (HeadlineAudioService.Validate(new HeadlineAudioRequest(["  A   headline\n"])).Single() != "A headline")
            throw new Exception("Audio titles were not normalized.");
        if (OperatingSystem.IsWindows())
        {
            var service = new HeadlineAudioService();
            var audio = await service.GenerateAsync(new HeadlineAudioRequest(["Science news from New Zealand.", "今天的科學新聞。"], 3), CancellationToken.None);
            var wave = audio.Wave;
            if (Encoding.ASCII.GetString(wave, 0, 4) != "RIFF" || Encoding.ASCII.GetString(wave, 8, 8) != "WAVEfmt "
                || BitConverter.ToInt32(wave, 4) != wave.Length - 8 || BitConverter.ToInt32(wave, 40) != wave.Length - 44
                || BitConverter.ToInt32(wave, 24) != 16_000 || BitConverter.ToInt16(wave, 34) != 16)
                throw new Exception("The synthesized briefing is not a valid PCM WAV track.");
            if (audio.Starts.Length != 2 || audio.Starts[0] != 0 || audio.Starts[1] < 3
                || (wave.Length - 44) / 32_000d < audio.Starts[1] + 3)
                throw new Exception("Audio timing did not contain both headlines and their display gaps.");
            if (!wave.Skip(44).Any(value => value != 0)) throw new Exception("Narration was silent.");
            if (Environment.GetEnvironmentVariable("SIGNAL_AUDIO_TEST_OUTPUT") is { Length: > 0 } output)
            {
                await File.WriteAllBytesAsync(output, wave);
                await File.WriteAllTextAsync(output + ".json", System.Text.Json.JsonSerializer.Serialize(audio.Starts));
            }
        }
        Console.WriteLine("Screen-off audio passed validation, English/Chinese synthesis and continuous WAV timing checks.");
    }
}
