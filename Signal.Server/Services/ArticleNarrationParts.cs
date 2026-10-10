using System.Text.RegularExpressions;

namespace Signal.Server.Services;

internal static class ArticleNarrationParts
{
    // Keep these boundaries identical to articleNarrationParts in headline-audio.ts.
    internal static string[] Split(string title, IReadOnlyList<string> paragraphs, int length = 300)
    {
        length = Math.Clamp(length, 80, 900);
        var body = paragraphs.Select(Normalize).Where(text => text.Length > 0).ToArray();
        if (body.Length == 0 || body.Sum(text => text.Length) + title.Length > 40_000)
            throw new ArgumentException("This article cannot be prepared as audio.");
        return new[] { title }.Concat(body).SelectMany(text => SplitText(text, length)).ToArray();
    }

    internal static string[] SplitText(string text, int length = 300)
    {
        var parts = new List<string>();
        var remaining = Normalize(text);
        var minimumBreak = length / 3;
        while (remaining.Length > length)
        {
            var window = remaining[..length];
            var sentence = Regex.Matches(window, @"(?:[.!?](?=\s)|[。！？])[""'”’]?").LastOrDefault();
            var end = sentence is null ? 0 : sentence.Index + sentence.Length;
            if (end < minimumBreak) end = window.LastIndexOf(' ') + 1;
            if (end < minimumBreak) end = length;
            if (char.IsHighSurrogate(remaining[end - 1])) end--;
            parts.Add(remaining[..end].Trim());
            remaining = remaining[end..].Trim();
        }
        if (remaining.Length > 0) parts.Add(remaining);
        return parts.ToArray();
    }
    private static string Normalize(string text) => Regex.Replace(text, @"\s+", " ").Trim();
}
