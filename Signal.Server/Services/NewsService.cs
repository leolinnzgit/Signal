using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class NewsService(HttpClient httpClient)
{
    private const string GoogleNewsRss = "https://news.google.com/rss/search";
    private const string GdeltDocApi = "https://api.gdeltproject.org/api/v2/doc/doc";
    private const int MaxFeedBytes = 1_500_000;

    public async Task<NewsResult> GetGoogleNewsAsync(
        string topic,
        int limit,
        CancellationToken cancellationToken)
    {
        var query = BuildQuery(new Dictionary<string, string?>
        {
            ["q"] = $"\"{topic}\" when:7d",
            ["hl"] = "en-NZ",
            ["gl"] = "NZ",
            ["ceid"] = "NZ:en",
        });
        using var response = await httpClient.GetAsync($"{GoogleNewsRss}?{query}", cancellationToken);
        response.EnsureSuccessStatusCode();
        var xml = await response.Content.ReadAsStringAsync(cancellationToken);
        var articles = ParseGoogleFeed(xml, topic).Take(limit).ToArray();
        return new NewsResult(topic, "Google News", DateTimeOffset.UtcNow, articles);
    }

    public async Task<NewsResult> GetGdeltNewsAsync(
        IReadOnlyList<string> topics,
        int limit,
        CancellationToken cancellationToken)
    {
        var query = BuildQuery(new Dictionary<string, string?>
        {
            ["query"] = string.Join(" OR ", topics.Select(topic => $"\"{topic}\"")),
            ["mode"] = "ArtList",
            ["maxrecords"] = Math.Min(250, Math.Max(50, limit * topics.Count * 3)).ToString(CultureInfo.InvariantCulture),
            ["format"] = "json",
            ["sort"] = "DateDesc",
            ["timespan"] = "1week",
        });
        using var response = await httpClient.GetAsync($"{GdeltDocApi}?{query}", cancellationToken);
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!text.TrimStart().StartsWith('{')) throw new InvalidOperationException("GDELT is currently rate limited.");

        using var document = JsonDocument.Parse(text);
        var articles = new List<NewsArticle>();
        if (document.RootElement.TryGetProperty("articles", out var entries))
        {
            foreach (var entry in entries.EnumerateArray())
            {
                var title = GetJsonString(entry, "title");
                var url = GetJsonString(entry, "url");
                if (string.IsNullOrWhiteSpace(title) || !IsPublicArticleUrl(url)) continue;

                var article = new NewsArticle(
                    StripHtml(title),
                    url,
                    GetJsonString(entry, "domain").Trim().Replace("www.", "", StringComparison.OrdinalIgnoreCase),
                    ParseDate(GetJsonString(entry, "seendate")),
                    "");
                var matchedTopics = topics.Where(topic => TopicMatcher.Matches(article, topic)).ToArray();
                if (matchedTopics.Length > 0) articles.Add(article with { MatchedTopics = matchedTopics });
            }
        }

        return new NewsResult(topics[0], "GDELT", DateTimeOffset.UtcNow, articles);
    }

    public async Task<NewsResult> GetPublisherFeedAsync(
        string feedUrl,
        string topic,
        int limit,
        CancellationToken cancellationToken)
    {
        var (xml, finalUrl) = await FetchPublisherFeedAsync(feedUrl, cancellationToken);
        var articles = ParsePublisherFeed(xml, finalUrl, topic).Take(limit).ToArray();
        var providerName = articles.FirstOrDefault()?.Source ?? finalUrl.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase);
        return new NewsResult(topic, $"RSS / {providerName}", DateTimeOffset.UtcNow, articles);
    }

    private async Task<(string Xml, Uri FinalUrl)> FetchPublisherFeedAsync(
        string feedUrl,
        CancellationToken cancellationToken)
    {
        var current = await ValidateFeedUrlAsync(feedUrl, cancellationToken);

        for (var redirectCount = 0; redirectCount < 3; redirectCount++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Accept.ParseAdd("application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9");
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);

            if ((int)response.StatusCode is >= 300 and < 400)
            {
                var location = response.Headers.Location
                    ?? throw new InvalidOperationException("Publisher feed redirected without a destination.");
                current = await ValidateFeedUrlAsync(new Uri(current, location).ToString(), cancellationToken);
                continue;
            }

            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"Publisher feed returned {(int)response.StatusCode}.");
            if (response.Content.Headers.ContentLength > MaxFeedBytes)
                throw new InvalidOperationException("Publisher feed is too large.");

            return (await ReadLimitedTextAsync(response.Content, cancellationToken), current);
        }

        throw new InvalidOperationException("Publisher feed redirected too many times.");
    }

    private static IEnumerable<NewsArticle> ParseGoogleFeed(string xml, string topic)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        foreach (var item in document.Descendants().Where(element => element.Name.LocalName == "item"))
        {
            var rawTitle = StripHtml(Value(item, "title"));
            var source = StripHtml(Value(item, "source"));
            if (string.IsNullOrWhiteSpace(source)) source = rawTitle.Split(" - ").LastOrDefault() ?? "News source";
            var suffix = $" - {source}";
            var title = rawTitle.EndsWith(suffix, StringComparison.Ordinal)
                ? rawTitle[..^suffix.Length]
                : rawTitle;
            var url = Value(item, "link");
            if (string.IsNullOrWhiteSpace(title) || !IsPublicArticleUrl(url)) continue;
            var article = new NewsArticle(title, url!, source, ParseDate(Value(item, "pubDate")), "");
            if (TopicMatcher.Matches(article, topic)) yield return article;
        }
    }

    private static IEnumerable<NewsArticle> ParsePublisherFeed(string xml, Uri feedUrl, string topic)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var channel = document.Descendants().FirstOrDefault(element => element.Name.LocalName == "channel");
        var feedTitle = StripHtml(channel is null ? "" : Value(channel, "title"));
        var fallbackSource = string.IsNullOrWhiteSpace(feedTitle)
            ? feedUrl.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase)
            : feedTitle;
        var entries = document.Descendants().Where(element => element.Name.LocalName is "item" or "entry").Take(100);

        foreach (var entry in entries)
        {
            var title = StripHtml(Value(entry, "title"));
            var linkElement = entry.Elements().FirstOrDefault(element => element.Name.LocalName == "link");
            var url = Value(entry, "link");
            if (string.IsNullOrWhiteSpace(url)) url = linkElement?.Attribute("href")?.Value ?? Value(entry, "guid");
            if (string.IsNullOrWhiteSpace(title) || !IsPublicArticleUrl(url)) continue;

            var summary = StripHtml(
                Value(entry, "description")
                ?? Value(entry, "summary")
                ?? Value(entry, "encoded")
                ?? "");
            if (summary.Length > 240) summary = summary[..240];
            var source = StripHtml(Value(entry, "source"));
            if (string.IsNullOrWhiteSpace(source)) source = fallbackSource;
            var article = new NewsArticle(
                title,
                url!,
                source,
                ParseDate(Value(entry, "pubDate") ?? Value(entry, "published") ?? Value(entry, "updated")),
                summary);
            if (TopicMatcher.Matches(article, topic)) yield return article;
        }
    }

    private static async Task<Uri> ValidateFeedUrlAsync(string value, CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var url)
            || url.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(url.UserInfo)
            || !url.IsDefaultPort)
            throw new ArgumentException("Publisher feeds must use a public HTTPS domain.");

        var hostname = url.DnsSafeHost.ToLowerInvariant();
        if (hostname is "localhost"
            || hostname.EndsWith(".localhost", StringComparison.Ordinal)
            || hostname.EndsWith(".local", StringComparison.Ordinal)
            || hostname.EndsWith(".internal", StringComparison.Ordinal)
            || hostname.EndsWith(".lan", StringComparison.Ordinal))
            throw new ArgumentException("Publisher feeds must use a public HTTPS domain.");

        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(hostname, cancellationToken);
        }
        catch (SocketException)
        {
            throw new ArgumentException("Publisher feed domain could not be resolved.");
        }
        if (addresses.Length == 0 || addresses.Any(IsPrivateAddress))
            throw new ArgumentException("Publisher feeds must resolve to a public internet address.");

        return url;
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)) return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast) return true;
            var bytes = address.GetAddressBytes();
            return (bytes[0] & 0xFE) == 0xFC;
        }

        var octets = address.GetAddressBytes();
        return octets[0] is 0 or 10 or 127
            || octets[0] >= 224
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && octets[1] is >= 16 and <= 31)
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 100 && octets[1] is >= 64 and <= 127);
    }

    private static async Task<string> ReadLimitedTextAsync(HttpContent content, CancellationToken cancellationToken)
    {
        await using var source = await content.ReadAsStreamAsync(cancellationToken);
        using var target = new MemoryStream();
        var buffer = new byte[16_384];
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            if (target.Length + read > MaxFeedBytes)
                throw new InvalidOperationException("Publisher feed is too large.");
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        return Encoding.UTF8.GetString(target.ToArray());
    }

    private static string BuildQuery(IReadOnlyDictionary<string, string?> values) =>
        string.Join("&", values.Where(pair => pair.Value is not null)
            .Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value!)}"));

    private static string? Value(XElement parent, string localName) =>
        parent.Elements().FirstOrDefault(element => element.Name.LocalName == localName)?.Value.Trim();

    private static string GetJsonString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static string StripHtml(string? value) =>
        Regex.Replace(WebUtility.HtmlDecode(value ?? ""), "<[^>]*>", " ")
            .Replace("\r", " ").Replace("\n", " ").Trim();

    private static DateTimeOffset ParseDate(string? value)
    {
        if (!string.IsNullOrWhiteSpace(value)
            && DateTimeOffset.TryParseExact(value, "yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var compact)) return compact.ToUniversalTime();
        return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? parsed.ToUniversalTime()
            : DateTimeOffset.UtcNow;
    }

    private static bool IsPublicArticleUrl(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var url)
        && (url.Scheme == Uri.UriSchemeHttps || url.Scheme == Uri.UriSchemeHttp);
}
