using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed class AzureSpeechOptions
{
    public const string SectionName = "Speech";
    public string Provider { get; set; } = "Windows";
    public bool Prewarm { get; set; } = true;
    public string Key { get; set; } = "";
    public string Region { get; set; } = "";
    public string EnglishVoice { get; set; } = "en-NZ-MollyNeural";
    public string ChineseVoice { get; set; } = "zh-TW-HsiaoChenNeural";

    public bool Enabled => Provider.Equals("Azure", StringComparison.OrdinalIgnoreCase);

    internal void Validate()
    {
        if (!Enabled) return;
        if (Key.Length is < 20 or > 256 || Key.Any(character => char.IsWhiteSpace(character) || char.IsControl(character))
            || !Regex.IsMatch(Region, "^[a-z][a-z0-9]{1,39}$"))
            throw new HeadlineAudioUnavailableException("configuration", "Azure narration needs a valid Speech resource key and region. Run Configure Signal Speech on the server.");
    }
}
