using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Services;

public sealed record ReaderArticle(
    string FinalUrl,
    string Byline,
    string SiteName,
    string PublishedAt,
    IReadOnlyList<string> Paragraphs);

public sealed record ArticleReaderResult(bool Available, string Reason, ReaderArticle? Article);

public sealed class ArticleReaderService(
    HttpClient httpClient,
    IMemoryCache cache,
    ILogger<ArticleReaderService> logger)
{
    private const int MaximumArticleBytes = 2_000_000;
    private const int MaximumParagraphs = 80;
    private const int MaximumTextLength = 30_000;
    private const int MaximumRedirects = 5;

    private static readonly Regex ScriptBlock = new(
        @"<script\b[^>]*>[\s\S]*?</script\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex JsonLdBlock = new(
        @"<script\b[^>]*type\s*=\s*[""']application/ld\+json[""'][^>]*>([\s\S]*?)</script\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex ParagraphBlock = new(
        @"<p\b[^>]*>([\s\S]*?)</p\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex ArticleBlock = new(
        @"<article\b[^>]*>([\s\S]*?)</article\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex MainBlock = new(
        @"<main\b[^>]*>([\s\S]*?)</main\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex UnwantedBlock = new(
        @"<(nav|header|footer|aside|form|button|style|svg|noscript)\b[^>]*>[\s\S]*?</\1\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex HtmlTag = new(
        @"<[^>]+>",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));
    private static readonly Regex WhiteSpace = new(
        @"\s+",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly string[] PaywallMarkers =
    [
        "subscribe to continue",
        "subscription required",
        "sign in to continue reading",
        "log in to continue reading",
        "register to continue reading",
        "this article is for subscribers",
        "exclusive to subscribers",
        "unlock this article",
        "data-paywall",
        "class=\"paywall",
        "class='paywall",
    ];

    public async Task<ArticleReaderResult> ReadAsync(string value, CancellationToken cancellationToken)
    {
        var initialUri = await ValidatePublicArticleUriAsync(value, cancellationToken);
        var cacheKey = $"article-reader:{initialUri.AbsoluteUri}";
        if (cache.TryGetValue(cacheKey, out ArticleReaderResult? cached) && cached is not null)
            return cached;

        var result = await FetchAndExtractAsync(initialUri, cancellationToken);
        cache.Set(
            cacheKey,
            result,
            result.Available ? TimeSpan.FromMinutes(30) : TimeSpan.FromMinutes(5));
        return result;
    }

    public async Task<string> ResolveUrlAsync(string value, CancellationToken cancellationToken)
    {
        var initialUri = await ValidatePublicArticleUriAsync(value, cancellationToken);
        var cacheKey = $"article-url:{initialUri.AbsoluteUri}";
        if (cache.TryGetValue(cacheKey, out string? cached) && !string.IsNullOrWhiteSpace(cached))
            return cached;

        var currentUri = initialUri;
        for (var redirectCount = 0; redirectCount <= MaximumRedirects; redirectCount++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, currentUri);
            request.Headers.Accept.ParseAdd("text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);

            if (!IsRedirect(response.StatusCode))
            {
                var resolvedUrl = currentUri.AbsoluteUri;
                cache.Set(cacheKey, resolvedUrl, TimeSpan.FromHours(6));
                return resolvedUrl;
            }

            if (redirectCount == MaximumRedirects || response.Headers.Location is null)
                throw new InvalidOperationException("The publisher redirected this story too many times.");

            var redirectUri = response.Headers.Location.IsAbsoluteUri
                ? response.Headers.Location
                : new Uri(currentUri, response.Headers.Location);
            currentUri = await ValidatePublicArticleUriAsync(redirectUri.AbsoluteUri, cancellationToken);
        }

        return initialUri.AbsoluteUri;
    }

    private async Task<ArticleReaderResult> FetchAndExtractAsync(
        Uri initialUri,
        CancellationToken cancellationToken)
    {
        var currentUri = initialUri;
        for (var redirectCount = 0; redirectCount <= MaximumRedirects; redirectCount++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, currentUri);
            request.Headers.Accept.ParseAdd("text/html,application/xhtml+xml;q=0.9");
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);

            if (IsRedirect(response.StatusCode))
            {
                if (redirectCount == MaximumRedirects || response.Headers.Location is null)
                    return Unavailable("The publisher redirected this story too many times.");

                var redirectUri = response.Headers.Location.IsAbsoluteUri
                    ? response.Headers.Location
                    : new Uri(currentUri, response.Headers.Location);
                currentUri = await ValidatePublicArticleUriAsync(redirectUri.AbsoluteUri, cancellationToken);
                continue;
            }

            if (response.StatusCode is HttpStatusCode.PaymentRequired
                or HttpStatusCode.Unauthorized
                or HttpStatusCode.Forbidden)
            {
                return Unavailable("This publisher requires a subscription or direct access.");
            }

            if (!response.IsSuccessStatusCode)
                return Unavailable("The publisher did not make this article available to Signal Reader.");

            var mediaType = response.Content.Headers.ContentType?.MediaType ?? "";
            if (!mediaType.Contains("html", StringComparison.OrdinalIgnoreCase))
                return Unavailable("This link is not a readable web article.");

            if (response.Content.Headers.ContentLength > MaximumArticleBytes)
                return Unavailable("This article is too large for Signal Reader.");

            var html = await ReadLimitedHtmlAsync(response.Content, cancellationToken);
            var extracted = ExtractArticle(html, currentUri);
            return extracted;
        }

        return Unavailable("The publisher did not make this article available to Signal Reader.");
    }

    private ArticleReaderResult ExtractArticle(string html, Uri finalUri)
    {
        try
        {
            var structured = ExtractStructuredArticle(html);
            var paragraphs = structured.Paragraphs.Count > 0
                ? structured.Paragraphs
                : ExtractParagraphs(html);
            var textLength = paragraphs.Sum(paragraph => paragraph.Length);
            var paywallDetected = structured.IsPaywalled
                || PaywallMarkers.Any(marker => html.Contains(marker, StringComparison.OrdinalIgnoreCase));

            if (structured.IsPaywalled || (paywallDetected && textLength < 1_200))
                return Unavailable("This story appears to require a subscription or publisher login.");

            if (paragraphs.Count == 0 || textLength < 300)
                return Unavailable("The publisher blocked extraction or did not expose enough readable text.");

            return new ArticleReaderResult(
                true,
                "",
                new ReaderArticle(
                    finalUri.AbsoluteUri,
                    structured.Byline,
                    structured.SiteName,
                    structured.PublishedAt,
                    paragraphs));
        }
        catch (Exception exception) when (exception is JsonException or RegexMatchTimeoutException)
        {
            logger.LogDebug(exception, "Could not extract reader content from {ArticleUrl}.", finalUri);
            return Unavailable("The publisher blocked extraction or used an unsupported article format.");
        }
    }

    private static StructuredArticle ExtractStructuredArticle(string html)
    {
        var best = new StructuredArticle();
        foreach (Match match in JsonLdBlock.Matches(html))
        {
            var json = WebUtility.HtmlDecode(match.Groups[1].Value.Trim());
            if (string.IsNullOrWhiteSpace(json)) continue;

            try
            {
                using var document = JsonDocument.Parse(json);
                VisitJson(document.RootElement, candidate =>
                {
                    if (!IsArticle(candidate)) return;
                    var body = JsonString(candidate, "articleBody");
                    var paragraphs = SplitStructuredBody(body);
                    if (paragraphs.Sum(paragraph => paragraph.Length)
                        > best.Paragraphs.Sum(paragraph => paragraph.Length))
                    {
                        best.Paragraphs = paragraphs;
                        best.Byline = ReadAuthor(candidate);
                        best.SiteName = ReadPublisher(candidate);
                        best.PublishedAt = JsonString(candidate, "datePublished");
                    }

                    if (candidate.TryGetProperty("isAccessibleForFree", out var accessible)
                        && ((accessible.ValueKind == JsonValueKind.False)
                            || (accessible.ValueKind == JsonValueKind.String
                                && bool.TryParse(accessible.GetString(), out var isFree)
                                && !isFree)))
                    {
                        best.IsPaywalled = true;
                    }
                });
            }
            catch (JsonException)
            {
                // Invalid publisher metadata should not prevent HTML paragraph extraction.
            }
        }
        return best;
    }

    private static List<string> ExtractParagraphs(string html)
    {
        var candidates = ArticleBlock.Matches(html)
            .Select(match => match.Groups[1].Value)
            .OrderByDescending(value => value.Length)
            .ToArray();
        if (candidates.Length == 0)
        {
            candidates = MainBlock.Matches(html)
                .Select(match => match.Groups[1].Value)
                .OrderByDescending(value => value.Length)
                .ToArray();
        }

        var content = candidates.FirstOrDefault() ?? ScriptBlock.Replace(html, " ");
        content = UnwantedBlock.Replace(content, " ");
        var paragraphs = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var totalLength = 0;

        foreach (Match match in ParagraphBlock.Matches(content))
        {
            var paragraph = CleanText(match.Groups[1].Value);
            if (paragraph.Length < 40 || !seen.Add(paragraph)) continue;
            if (totalLength + paragraph.Length > MaximumTextLength) break;
            paragraphs.Add(paragraph);
            totalLength += paragraph.Length;
            if (paragraphs.Count == MaximumParagraphs) break;
        }

        return paragraphs;
    }

    private static List<string> SplitStructuredBody(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return [];
        var cleaned = CleanText(body);
        if (cleaned.Length > MaximumTextLength)
            cleaned = cleaned[..MaximumTextLength].TrimEnd();
        return cleaned.Length < 40 ? [] : [cleaned];
    }

    private static string CleanText(string value)
    {
        var withoutTags = HtmlTag.Replace(value, " ");
        return WhiteSpace.Replace(WebUtility.HtmlDecode(withoutTags), " ").Trim();
    }

    private static void VisitJson(JsonElement element, Action<JsonElement> visitor)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            visitor(element);
            foreach (var property in element.EnumerateObject())
                VisitJson(property.Value, visitor);
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in element.EnumerateArray())
                VisitJson(child, visitor);
        }
    }

    private static bool IsArticle(JsonElement candidate)
    {
        if (!candidate.TryGetProperty("@type", out var type)) return false;
        return type.ValueKind switch
        {
            JsonValueKind.String => IsArticleType(type.GetString()),
            JsonValueKind.Array => type.EnumerateArray()
                .Any(item => item.ValueKind == JsonValueKind.String && IsArticleType(item.GetString())),
            _ => false,
        };
    }

    private static bool IsArticleType(string? value) =>
        value is not null && (value.Equals("Article", StringComparison.OrdinalIgnoreCase)
            || value.EndsWith("Article", StringComparison.OrdinalIgnoreCase));

    private static string JsonString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? ""
            : "";

    private static string ReadAuthor(JsonElement article)
    {
        if (!article.TryGetProperty("author", out var author)) return "";
        return ReadNames(author);
    }

    private static string ReadPublisher(JsonElement article)
    {
        if (!article.TryGetProperty("publisher", out var publisher)) return "";
        return ReadNames(publisher);
    }

    private static string ReadNames(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String) return value.GetString()?.Trim() ?? "";
        if (value.ValueKind == JsonValueKind.Object) return JsonString(value, "name");
        if (value.ValueKind != JsonValueKind.Array) return "";
        return string.Join(", ", value.EnumerateArray()
            .Select(ReadNames)
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase));
    }

    private static async Task<string> ReadLimitedHtmlAsync(
        HttpContent content,
        CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[16_384];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, cancellationToken);
            if (read == 0) break;
            if (buffer.Length + read > MaximumArticleBytes)
                throw new InvalidOperationException("The article exceeded the reader size limit.");
            await buffer.WriteAsync(chunk.AsMemory(0, read), cancellationToken);
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private static async Task<Uri> ValidatePublicArticleUriAsync(
        string value,
        CancellationToken cancellationToken)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo)
            || (!uri.IsDefaultPort && uri.Port != 443))
        {
            throw new ArgumentException("Articles must use a public HTTPS address.");
        }

        var host = uri.DnsSafeHost;
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".internal", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".lan", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Articles must use a public HTTPS address.");
        }

        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(host, cancellationToken);
        }
        catch (SocketException exception)
        {
            throw new ArgumentException("The publisher address could not be resolved.", exception);
        }

        if (addresses.Length == 0 || addresses.Any(IsPrivateAddress))
            throw new ArgumentException("Articles must use a public HTTPS address.");
        return uri;
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)
            || address.IsIPv6LinkLocal
            || address.IsIPv6Multicast
            || address.IsIPv6SiteLocal)
            return true;

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
            return (address.GetAddressBytes()[0] & 0xfe) == 0xfc;

        var bytes = address.GetAddressBytes();
        return bytes[0] is 0 or 10 or 127
            || (bytes[0] == 169 && bytes[1] == 254)
            || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
            || (bytes[0] == 192 && bytes[1] == 168)
            || bytes[0] >= 224;
    }

    private static bool IsRedirect(HttpStatusCode statusCode) =>
        statusCode is HttpStatusCode.Moved
            or HttpStatusCode.Redirect
            or HttpStatusCode.RedirectMethod
            or HttpStatusCode.TemporaryRedirect
            or HttpStatusCode.PermanentRedirect;

    private static ArticleReaderResult Unavailable(string reason) =>
        new(false, reason, null);

    private sealed class StructuredArticle
    {
        public List<string> Paragraphs { get; set; } = [];
        public string Byline { get; set; } = "";
        public string SiteName { get; set; } = "";
        public string PublishedAt { get; set; } = "";
        public bool IsPaywalled { get; set; }
    }
}
