namespace Signal.Server.Services;

public sealed class KokoroSpeechOptions
{
    public string Provider { get; set; } = "Windows";
    public string KokoroDirectory { get; set; } = "";
    public int KokoroThreads { get; set; } = 4;
    public string KokoroEnglishVoice { get; set; } = "bf_emma";
    public string KokoroChineseVoice { get; set; } = "zf_xiaobei";
    public bool Enabled => Provider.Equals("Kokoro", StringComparison.OrdinalIgnoreCase);
}
