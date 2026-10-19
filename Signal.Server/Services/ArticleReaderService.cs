using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;

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
    ILogger<ArticleReaderService> logger,
    IArticlePageRenderer? pageRenderer = null)
{
    internal const string InsufficientTextReason = "Signal Reader could not find enough article text on this page.";
    internal const string GoogleNewsResolutionReason = "Google News did not provide the publisher link this time. Try again later, or open the original story.";
    internal const string PublisherBlockedReason = "This publisher blocked Signal Reader's request. Open the original article in your browser to read it.";
    internal const string BotProtectionReason = "This publisher's bot protection blocked Signal Reader. Open the original article in your browser to read it.";

    private const int MaximumArticleBytes = 2_000_000;
    private const int MaximumParagraphs = 80;
    private const int MaximumTextLength = 30_000;
    private const int MaximumRedirects = 5;

    private static readonly Regex JsonLdBlock = new(
        @"<script\b[^>]*type\s*=\s*[""']application/ld\+json[""'][^>]*>([\s\S]*?)</script\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled,
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
                if (GoogleNewsArticleUrl.IsRedirectPage(currentUri))
                {
                    if (!response.IsSuccessStatusCode) return initialUri.AbsoluteUri;
                    var html = await ReadLimitedHtmlAsync(response.Content, cancellationToken);
                    var publisherUri = await ResolveGoogleNewsAsync(currentUri, html, cancellationToken);
                    if (publisherUri is null) return initialUri.AbsoluteUri;
                    currentUri = publisherUri;
                    continue;
                }
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
        var currentUri = cache.TryGetValue($"article-url:{initialUri.AbsoluteUri}", out string? resolvedUrl)
            && !string.IsNullOrWhiteSpace(resolvedUrl)
            ? await ValidatePublicArticleUriAsync(resolvedUrl, cancellationToken)
            : initialUri;
        for (var redirectCount = 0; redirectCount <= MaximumRedirects; redirectCount++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, currentUri);
            // Some publishers return HTTP 406 without a general fallback, even
            // though they serve HTML. Keep HTML preferred and validate the response below.
            request.Headers.Accept.ParseAdd("text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
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

            if (response.Headers.TryGetValues("cf-mitigated", out var mitigations)
                && mitigations.Any(value => value.Equals("challenge", StringComparison.OrdinalIgnoreCase)))
                return Unavailable(BotProtectionReason);

            if (response.StatusCode == HttpStatusCode.Forbidden)
                return Unavailable(PublisherBlockedReason);

            if (response.StatusCode is HttpStatusCode.PaymentRequired or HttpStatusCode.Unauthorized)
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
            if (GoogleNewsArticleUrl.IsRedirectPage(currentUri))
            {
                var publisherUri = await ResolveGoogleNewsAsync(currentUri, html, cancellationToken);
                if (publisherUri is null) return Unavailable(GoogleNewsResolutionReason);
                cache.Set($"article-url:{initialUri.AbsoluteUri}", publisherUri.AbsoluteUri, TimeSpan.FromHours(6));
                currentUri = publisherUri;
                continue;
            }
            var extracted = ExtractArticle(html, currentUri);
            if (!extracted.Available && extracted.Reason == InsufficientTextReason
                && StuffArticleApiUri(currentUri) is { } stuffApiUri)
            {
                var stuffArticle = await ReadStuffArticleAsync(currentUri, stuffApiUri, cancellationToken);
                if (stuffArticle is not null) return stuffArticle;
            }
            if (!extracted.Available && extracted.Reason == InsufficientTextReason && pageRenderer is not null)
            {
                var rendered = await pageRenderer.RenderAsync(currentUri, html, cancellationToken);
                if (rendered is not null)
                    return ExtractArticle(rendered.Html, rendered.Url);
            }
            return extracted;
        }

        return Unavailable("The publisher did not make this article available to Signal Reader.");
    }

    internal static Uri? StuffArticleApiUri(Uri articleUri)
    {
        if (articleUri.Scheme != Uri.UriSchemeHttps
            || (!articleUri.IsDefaultPort && articleUri.Port != 443)
            || !string.IsNullOrEmpty(articleUri.UserInfo)
            || !(articleUri.Host.Equals("www.stuff.co.nz", StringComparison.OrdinalIgnoreCase)
                || articleUri.Host.Equals("stuff.co.nz", StringComparison.OrdinalIgnoreCase)))
            return null;

        var segments = articleUri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments[0] is "api" or "rss" or "assets" or "media") return null;
        var ids = segments.Where(segment => segment.Length is >= 6 and <= 12
            && segment.All(character => character is >= '0' and <= '9')).ToArray();
        return ids.Length == 1
            ? new Uri($"https://www.stuff.co.nz/api/v1.0/stuff/story/{ids[0]}")
            : null;
    }

    private async Task<ArticleReaderResult?> ReadStuffArticleAsync(
        Uri articleUri, Uri apiUri, CancellationToken cancellationToken)
    {
        try
        {
            // This is the public response used by Stuff's article page. It is only
            // used for explicitly open stories after the page itself has no text.
            apiUri = await ValidatePublicArticleUriAsync(apiUri.AbsoluteUri, cancellationToken);
            using var request = new HttpRequestMessage(HttpMethod.Get, apiUri);
            request.Headers.Accept.ParseAdd("application/json");
            using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode
                || !(response.Content.Headers.ContentType?.MediaType?.Contains("json", StringComparison.OrdinalIgnoreCase) ?? false))
                return null;
            using var document = JsonDocument.Parse(await ReadLimitedHtmlAsync(response.Content, cancellationToken));
            var story = document.RootElement;
            if (story.ValueKind != JsonValueKind.Object
                || !story.TryGetProperty("id", out var id)
                || !string.Equals(id.ToString(), apiUri.Segments[^1], StringComparison.Ordinal)
                || !JsonString(story, "type").Equals("ARTICLE", StringComparison.OrdinalIgnoreCase))
                return null;

            var access = JsonString(story, "contentAccess");
            if (access.Length == 0) return null;
            if (!access.Equals("open", StringComparison.OrdinalIgnoreCase))
                return Unavailable("This story appears to require a subscription or publisher login.");
            if (!story.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Object
                || !content.TryGetProperty("contentBody", out var body) || body.ValueKind != JsonValueKind.Object)
                return null;

            var metadata = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["@type"] = "NewsArticle",
                ["articleBody"] = JsonString(body, "body"),
                ["author"] = story.TryGetProperty("author", out var author) ? author.Clone() : null,
                ["publisher"] = new { name = FirstNonEmpty(JsonString(story, "mainPublicationName"), "Stuff") },
                ["datePublished"] = JsonString(story, "publishedDate"),
            });
            var extracted = ExtractArticle($"<script type='application/ld+json'>{metadata}</script>", articleUri);
            return extracted.Available ? extracted : null;
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException or InvalidOperationException
            || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            logger.LogDebug(exception, "Could not read Stuff's public article response for {ArticleUrl}.", articleUri);
            return null;
        }
    }

    private async Task<Uri?> ResolveGoogleNewsAsync(Uri uri, string html, CancellationToken token)
    {
        try
        {
            return await GoogleNewsArticleUrl.ResolveAsync(httpClient, uri, html, token);
        }
        catch (Exception exception) when (exception is HttpRequestException or InvalidOperationException
            || exception is OperationCanceledException && !token.IsCancellationRequested)
        {
            logger.LogDebug(exception, "Could not resolve Google News article {ArticleUrl}.", uri);
            return null;
        }
    }

    internal ArticleReaderResult ExtractArticle(string html, Uri finalUri)
    {
        try
        {
            // Verification pages can contain enough prose to pass readability.
            // Identify the page itself, rather than mentions of Cloudflare in news.
            var title = new HtmlParser().ParseDocument(html).Title?.Trim() ?? "";
            if (title.Equals("Attention Required! | Cloudflare", StringComparison.OrdinalIgnoreCase)
                || (title.Equals("Just a moment...", StringComparison.OrdinalIgnoreCase)
                    && html.Contains("/cdn-cgi/challenge-platform/", StringComparison.OrdinalIgnoreCase)))
                return Unavailable(BotProtectionReason);

            var structured = ExtractStructuredArticle(html);
            // Paid metadata is authoritative even if hidden text is present in the HTML.
            if (structured.IsPaywalled)
                return Unavailable("This story appears to require a subscription or publisher login.");

            var readable = ExtractReadableArticle(html, finalUri);
            var paragraphs = structured.Paragraphs.Sum(paragraph => paragraph.Length)
                > readable.Paragraphs.Sum(paragraph => paragraph.Length)
                ? structured.Paragraphs
                : readable.Paragraphs;
            if (paragraphs.Sum(paragraph => paragraph.Length) < 300)
            {
                var fallback = ExtractParagraphs(html);
                if (fallback.Sum(paragraph => paragraph.Length) > paragraphs.Sum(paragraph => paragraph.Length))
                    paragraphs = fallback;
            }
            var textLength = paragraphs.Sum(paragraph => paragraph.Length);
            var paywallDetected = structured.IsPaywalled
                || PaywallMarkers.Any(marker => html.Contains(marker, StringComparison.OrdinalIgnoreCase));

            if (structured.IsPaywalled || (paywallDetected && textLength < 1_200))
                return Unavailable("This story appears to require a subscription or publisher login.");

            if (paragraphs.Count == 0 || textLength < 300)
                return Unavailable(InsufficientTextReason);

            return new ArticleReaderResult(
                true,
                "",
                new ReaderArticle(
                    finalUri.AbsoluteUri,
                    FirstNonEmpty(structured.Byline, readable.Byline),
                    FirstNonEmpty(structured.SiteName, readable.SiteName),
                    FirstNonEmpty(structured.PublishedAt, readable.PublishedAt),
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
            var json = match.Groups[1].Value.Trim();
            if (string.IsNullOrWhiteSpace(json)) continue;

            try
            {
                using var document = JsonDocument.Parse(json);
                VisitJson(document.RootElement, candidate =>
                {
                    if (!IsArticle(candidate)) return;
                    best.Byline = FirstNonEmpty(best.Byline, ReadAuthor(candidate));
                    best.SiteName = FirstNonEmpty(best.SiteName, ReadPublisher(candidate));
                    best.PublishedAt = FirstNonEmpty(best.PublishedAt, JsonString(candidate, "datePublished"));
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

    private StructuredArticle ExtractReadableArticle(string html, Uri uri)
    {
        try
        {
            // Supplying HTML prevents SmartReader from fetching URLs itself.
            var reader = new SmartReader.Reader(uri.AbsoluteUri, html)
            {
                CharThreshold = 300,
                MaxElemsToParse = 50_000,
            };
            var article = reader.GetArticle();
            return new StructuredArticle
            {
                Paragraphs = SplitStructuredBody(article.TextContent ?? ""),
                Byline = article.Byline ?? article.Author ?? "",
                SiteName = article.SiteName ?? "",
                PublishedAt = article.PublicationDate?.ToString("o") ?? "",
            };
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Readability could not parse {ArticleUrl}; trying HTML paragraphs.", uri);
            return new StructuredArticle();
        }
    }

    private static List<string> ExtractParagraphs(string html)
    {
        var document = new HtmlParser().ParseDocument(html);
        foreach (var unwanted in document.QuerySelectorAll("script, style, nav, header, footer, aside, form, button, svg, noscript"))
            unwanted.Remove();

        // Evaluate actual text, rather than picking the largest HTML container.
        var candidates = document.QuerySelectorAll("article, main")
            .Select(element => LimitParagraphs(element.QuerySelectorAll("p").Select(p => p.TextContent)))
            .OrderByDescending(paragraphs => paragraphs.Sum(paragraph => paragraph.Length))
            .ToList();
        var best = candidates.FirstOrDefault() ?? [];
        return best.Sum(paragraph => paragraph.Length) >= 300
            ? best
            : LimitParagraphs(document.QuerySelectorAll("p").Select(p => p.TextContent));
    }

    private static List<string> SplitStructuredBody(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return [];
        if (body.Contains('<'))
        {
            var document = new HtmlParser().ParseDocument(body);
            var blocks = document.QuerySelectorAll("p, li");
            if (blocks.Length > 0) return LimitParagraphs(blocks.Select(block => block.TextContent));
            body = document.Body?.TextContent ?? body;
        }
        return LimitParagraphs(Regex.Split(body, @"[\r\n]+"));
    }

    private static List<string> LimitParagraphs(IEnumerable<string> values)
    {
        var paragraphs = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var remaining = MaximumTextLength;
        foreach (var value in values)
        {
            var paragraph = WhiteSpace.Replace(WebUtility.HtmlDecode(value), " ").Trim();
            if (paragraph.Length < 20 || !seen.Add(paragraph)) continue;
            if (paragraph.Length > remaining) paragraph = paragraph[..remaining].TrimEnd();
            if (paragraph.Length == 0) break;
            paragraphs.Add(paragraph);
            remaining -= paragraph.Length;
            if (remaining == 0 || paragraphs.Count == MaximumParagraphs) break;
        }
        return paragraphs;
    }

    private static string FirstNonEmpty(string first, string second) =>
        string.IsNullOrWhiteSpace(first) ? second : first;

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

    internal static async Task<string> ReadLimitedHtmlAsync(
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

    internal static async Task<Uri> ValidatePublicArticleUriAsync(
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

    internal static async ValueTask<Stream> ConnectPublicAsync(
        SocketsHttpConnectionContext context,
        CancellationToken cancellationToken)
    {
        // Validate the addresses used for the socket too, so DNS cannot change
        // from a public address to an internal one between validation and fetch.
        var addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellationToken);
        if (context.DnsEndPoint.Port != 443 || addresses.Length == 0 || addresses.Any(IsPrivateAddress))
            throw new HttpRequestException("Articles must use a public HTTPS address.");
        foreach (var address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), cancellationToken);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (SocketException) { socket.Dispose(); }
            catch { socket.Dispose(); throw; }
        }
        throw new HttpRequestException("The publisher address could not be reached.");
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)
            || address.IsIPv6LinkLocal
            || address.IsIPv6Multicast
            || address.IsIPv6SiteLocal)
            return true;

        if (address.IsIPv4MappedToIPv6) return IsPrivateAddress(address.MapToIPv4());
        if (address.Equals(IPAddress.IPv6Any)) return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
            return (address.GetAddressBytes()[0] & 0xfe) == 0xfc;

        var bytes = address.GetAddressBytes();
        return bytes[0] is 0 or 10 or 127
            || (bytes[0] == 169 && bytes[1] == 254)
            || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
            || (bytes[0] == 192 && bytes[1] == 168)
            || (bytes[0] == 100 && bytes[1] is >= 64 and <= 127)
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
