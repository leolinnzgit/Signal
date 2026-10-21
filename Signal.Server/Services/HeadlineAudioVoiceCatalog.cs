using System.Globalization;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Signal.Server.Services;

public sealed record NarrationVoice(string Id, string Name, string Language, string Gender);

internal static class HeadlineAudioVoiceCatalog
{
    internal static string VoiceKey(string tokenId) => tokenId.Split('\\')[^1];

    [SupportedOSPlatform("windows")]
    internal static IReadOnlyList<NarrationVoice> GetInstalled()
    {
        var voices = ReadCategory(@"SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens");
        return voices.Count > 0 ? voices : ReadCategory(@"SOFTWARE\Microsoft\Speech\Voices\Tokens");
    }

    [SupportedOSPlatform("windows")]
    private static List<NarrationVoice> ReadCategory(string path)
    {
        var voices = new List<NarrationVoice>();
        using var category = Registry.LocalMachine.OpenSubKey(path);
        if (category is null) return voices;
        foreach (var id in category.GetSubKeyNames())
        {
            using var token = category.OpenSubKey(id);
            using var attributes = token?.OpenSubKey("Attributes");
            var language = (attributes?.GetValue("Language") as string)?.Split(';')[0];
            if (!int.TryParse(language, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var locale)) continue;
            CultureInfo culture;
            try { culture = CultureInfo.GetCultureInfo(locale); }
            catch (CultureNotFoundException) { continue; }
            if (culture.TwoLetterISOLanguageName is not ("en" or "zh")) continue;
            var name = attributes?.GetValue("Name") as string ?? token?.GetValue(null) as string ?? id;
            voices.Add(new NarrationVoice(id, name, culture.Name, attributes?.GetValue("Gender") as string ?? ""));
        }
        return voices;
    }
}
