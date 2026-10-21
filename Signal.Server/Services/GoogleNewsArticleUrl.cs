using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using AngleSharp.Html.Parser;

namespace Signal.Server.Services;

internal static class GoogleNewsArticleUrl
{
    private static readonly Regex ArticlePath = new(
        @"^/(?:rss/articles|articles|read)/([A-Za-z0-9_-]{1,2048})/?$",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Uri Endpoint = new("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je");

    public static bool IsRedirectPage(Uri uri) =>
        uri.Host.Equals("news.google.com", StringComparison.OrdinalIgnoreCase)
        && ArticlePath.IsMatch(uri.AbsolutePath);

    public static async Task<Uri?> ResolveAsync(HttpClient client, Uri uri, string html, CancellationToken token)
    {
        if (!IsRedirectPage(uri)) return null;
        var id = ArticlePath.Match(uri.AbsolutePath).Groups[1].Value;
        var document = new HtmlParser().ParseDocument(html);
        var parameters = document.QuerySelectorAll("[data-n-a-id][data-n-a-ts][data-n-a-sg]")
            .FirstOrDefault(element => element.GetAttribute("data-n-a-id") == id);
        var signature = parameters?.GetAttribute("data-n-a-sg") ?? "";
        if (signature.Length is 0 or > 256
            || !long.TryParse(parameters?.GetAttribute("data-n-a-ts"), NumberStyles.None,
                CultureInfo.InvariantCulture, out var timestamp) || timestamp <= 0)
            return null;

        // Resolve the public redirect using Google's page-supplied ID and signature.
        // This is separate from browser rendering, whose non-GET requests remain blocked.
        object?[] context = [
            new object?[] { "X", "X", new[] { "X", "X" }, null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1 },
            "X", "X", 1, new[] { 1, 1, 1 }, 1, 1, null, 0, 0, null, 0,
        ];
        var query = JsonSerializer.Serialize(new object?[] { "garturlreq", context, id, timestamp, signature });
        var payload = JsonSerializer.Serialize(new[] { new[] { new object?[] { "Fbv4je", query, null, "generic" } } });
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["f.req"] = payload }),
        };
        request.Headers.Referrer = new Uri("https://news.google.com/");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        // Do not follow redirects from the fixed resolution endpoint.
        if (!response.IsSuccessStatusCode) return null;
        var body = await ArticleReaderService.ReadLimitedHtmlAsync(response.Content, token);
        var url = ReadResolvedUrl(body);
        if (url is null) return null;
        var resolved = await ArticleReaderService.ValidatePublicArticleUriAsync(url, token);
        return resolved.Host.Equals("news.google.com", StringComparison.OrdinalIgnoreCase) ? null : resolved;
    }

    internal static string? ReadResolvedUrl(string body)
    {
        // Google prefixes JSON with an XSSI guard and may include length-framed chunks.
        foreach (var line in body.Split('\n'))
        {
            var json = line.Trim();
            if (!json.StartsWith('[')) continue;
            try
            {
                using var document = JsonDocument.Parse(json);
                if (document.RootElement.ValueKind != JsonValueKind.Array) continue;
                foreach (var frame in document.RootElement.EnumerateArray())
                {
                    if (frame.ValueKind != JsonValueKind.Array || frame.GetArrayLength() < 3
                        || frame[0].ValueKind != JsonValueKind.String || frame[0].GetString() != "wrb.fr"
                        || frame[1].ValueKind != JsonValueKind.String || frame[1].GetString() != "Fbv4je"
                        || frame[2].ValueKind != JsonValueKind.String) continue;
                    using var result = JsonDocument.Parse(frame[2].GetString()!);
                    var value = result.RootElement;
                    if (value.ValueKind == JsonValueKind.Array && value.GetArrayLength() >= 2
                        && value[0].ValueKind == JsonValueKind.String && value[0].GetString() == "garturlres"
                        && value[1].ValueKind == JsonValueKind.String)
                        return value[1].GetString();
                }
            }
            catch (JsonException) { /* Unsupported frames leave the original link available. */ }
        }
        return null;
    }
}
