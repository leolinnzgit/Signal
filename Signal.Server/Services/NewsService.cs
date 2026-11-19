using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.AspNetCore.WebUtilities;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class NewsService(HttpClient httpClient)
{
    private const string GoogleNewsRss = "https://news.google.com/rss/search";
    private const string BingNewsRss = "https://www.bing.com/news/search";
    private const string GdeltDocApi = "https://api.gdeltproject.org/api/v2/doc/doc";
    private const int MaxFeedBytes = 1_500_000;

    public Task<NewsResult> GetGoogleNewsAsync(
        string topic,
        int limit,
        CancellationToken cancellationToken) =>
        GetGoogleNewsAsync(topic, limit, dateRange: null, cancellationToken);

    public async Task<NewsResult> GetGoogleNewsAsync(
        string topic,
        int limit,
        NewsDateRange? dateRange,
        CancellationToken cancellationToken)
    {
        var searchQuery = BuildGoogleDateQuery(topic, dateRange);
        var query = BuildQuery(new Dictionary<string, string?>
        {
            ["q"] = searchQuery,
            ["hl"] = "en-NZ",
            ["gl"] = "NZ",
            ["ceid"] = "NZ:en",
        });
        using var response = await httpClient.GetAsync($"{GoogleNewsRss}?{query}", cancellationToken);
        response.EnsureSuccessStatusCode();
        var xml = await response.Content.ReadAsStringAsync(cancellationToken);
        var parsed = ParseGoogleFeed(xml, topic);
        if (dateRange is { HasBounds: true })
            parsed = parsed.Where(article => dateRange.Contains(article.PublishedAt));

        var boundedLimit = Math.Clamp(limit, 1, 500);
        var articles = parsed
            .OrderByDescending(article => article.PublishedAt)
            .Take(boundedLimit)
            .Select(article => article with { MatchedTopics = [topic] })
            .ToArray();
        return new NewsResult(
            topic,
            "Google News",
            DateTimeOffset.UtcNow,
            articles,
            [topic],
            dateRange?.From,
            dateRange?.To);
    }

    public async Task<NewsResult> GetGoogleNewsAsync(
        IReadOnlyList<string> topics,
        int limit,
        NewsDateRange? dateRange,
        CancellationToken cancellationToken)
    {
        if (topics.Count == 0) throw new ArgumentException("Choose at least one topic.");
        if (topics.Count == 1) return await GetGoogleNewsAsync(topics[0], limit, dateRange, cancellationToken);

        using var gate = new SemaphoreSlim(4, 4);
        var outcomes = await Task.WhenAll(topics.Select(async topic =>
        {
            await gate.WaitAsync(cancellationToken);
            try
            {
                return (Result: (NewsResult?)await GetGoogleNewsAsync(topic, limit, dateRange, cancellationToken), Error: (Exception?)null);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                return (Result: (NewsResult?)null, Error: (Exception?)exception);
            }
            finally
            {
                gate.Release();
            }
        }));

        var succeeded = outcomes.Where(outcome => outcome.Result is not null).Select(outcome => outcome.Result!).ToArray();
        if (succeeded.Length == 0)
        {
            var firstError = outcomes.First(outcome => outcome.Error is not null).Error!;
            ExceptionDispatchInfo.Capture(firstError).Throw();
        }

        var maxArticles = Math.Min(500, Math.Max(1, limit) * topics.Count);
        var merged = MergeArticles(succeeded.SelectMany(result => result.Articles), topics, maxArticles);
        return new NewsResult(
            topics[0],
            "Google News",
            DateTimeOffset.UtcNow,
            merged,
            topics.ToArray(),
            dateRange?.From,
            dateRange?.To);
    }

    public async Task<IReadOnlyList<NewsArticle>> SearchGoogleNewsKeywordsAsync(
        string keywords,
        int limit,
        CancellationToken cancellationToken)
    {
        var trimmed = (keywords ?? "").Trim();
        if (trimmed.Length == 0) return [];
        var query = BuildQuery(new Dictionary<string, string?>
        {
            ["q"] = trimmed,
            ["hl"] = "en-NZ",
            ["gl"] = "NZ",
            ["ceid"] = "NZ:en",
        });
        using var response = await httpClient.GetAsync($"{GoogleNewsRss}?{query}", HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var xml = await ReadLimitedTextAsync(response.Content, cancellationToken);
        return ParseGoogleFeedItems(xml).Take(Math.Max(1, limit)).ToArray();
    }

    public async Task<IReadOnlyList<NewsArticle>> SearchBingNewsKeywordsAsync(
        string keywords,
        int limit,
        CancellationToken cancellationToken)
    {
        var trimmed = (keywords ?? "").Trim();
        if (trimmed.Length == 0) return [];
        var query = BuildQuery(new Dictionary<string, string?>
        {
            ["q"] = trimmed,
            ["format"] = "rss",
        });
        using var response = await httpClient.GetAsync($"{BingNewsRss}?{query}", HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var xml = await ReadLimitedTextAsync(response.Content, cancellationToken);
        return ParseBingFeedItems(xml).Take(Math.Max(1, limit)).ToArray();
    }

    public Task<NewsResult> GetGdeltNewsAsync(
        IReadOnlyList<string> topics,
        int limit,
        CancellationToken cancellationToken) =>
        GetGdeltNewsAsync(topics, limit, dateRange: null, cancellationToken);

    public async Task<NewsResult> GetGdeltNewsAsync(
        IReadOnlyList<string> topics,
        int limit,
        NewsDateRange? dateRange,
        CancellationToken cancellationToken)
    {
        if (topics.Count == 0) throw new ArgumentException("Choose at least one topic.");

        var queryParameters = new Dictionary<string, string?>
        {
            ["query"] = string.Join(" OR ", topics.Select(topic => $"\"{topic}\"")),
            ["mode"] = "ArtList",
            ["maxrecords"] = Math.Min(250, Math.Max(50, limit * topics.Count * 3)).ToString(CultureInfo.InvariantCulture),
            ["format"] = "json",
            ["sort"] = "DateDesc",
        };
        if (dateRange is { HasBounds: true })
        {
            if (dateRange.From is { } from)
                queryParameters["startdatetime"] = from.ToUniversalTime().ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            if (dateRange.To is { } to)
                queryParameters["enddatetime"] = to.ToUniversalTime().ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        }
        else
        {
            queryParameters["timespan"] = "1week";
        }

        var query = BuildQuery(queryParameters);
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
                var normalizedUrl = ArticleIdentity.NormalizeUrl(GetJsonString(entry, "url"));
                if (string.IsNullOrWhiteSpace(title) || normalizedUrl is null) continue;

                var publishedAt = ParseDate(GetJsonString(entry, "seendate"));
                if (dateRange is { HasBounds: true } && !dateRange.Contains(publishedAt)) continue;

                var article = new NewsArticle(
                    StripHtml(title),
                    normalizedUrl,
                    GetJsonString(entry, "domain").Trim().Replace("www.", "", StringComparison.OrdinalIgnoreCase),
                    publishedAt,
                    "",
                    ImageUrl: NormalizeImageUrl(GetJsonString(entry, "socialimage"), new Uri(normalizedUrl)));
                var matchedTopics = topics.Where(topic => TopicMatcher.Matches(article, topic)).ToArray();
                if (matchedTopics.Length > 0) articles.Add(article with { MatchedTopics = matchedTopics });
            }
        }

        var maxArticles = Math.Min(500, Math.Max(1, limit) * topics.Count);
        var ordered = articles
            .OrderByDescending(article => article.PublishedAt)
            .Take(maxArticles)
            .ToArray();
        return new NewsResult(
            topics[0],
            "GDELT",
            DateTimeOffset.UtcNow,
            ordered,
            topics.ToArray(),
            dateRange?.From,
            dateRange?.To);
    }

    public Task<NewsResult> GetPublisherFeedAsync(
        string feedUrl,
        string topic,
        int limit,
        CancellationToken cancellationToken) =>
        GetPublisherFeedAsync(feedUrl, [topic], limit, dateRange: null, cancellationToken);

    public Task<NewsResult> GetPublisherFeedAsync(
        string feedUrl,
        IReadOnlyList<string> topics,
        int limit,
        CancellationToken cancellationToken) =>
        GetPublisherFeedAsync(feedUrl, topics, limit, dateRange: null, cancellationToken);

    public async Task<NewsResult> GetPublisherFeedAsync(
        string feedUrl,
        IReadOnlyList<string> topics,
        int limit,
        NewsDateRange? dateRange,
        CancellationToken cancellationToken)
    {
        if (topics.Count == 0) throw new ArgumentException("Choose at least one topic.");
        var (xml, finalUrl) = await FetchPublisherFeedAsync(feedUrl, cancellationToken);
        var parsed = ParsePublisherFeed(xml, finalUrl, topics);
        if (dateRange is { HasBounds: true })
            parsed = parsed.Where(article => dateRange.Contains(article.PublishedAt));

        var articles = parsed
            .OrderByDescending(article => article.PublishedAt)
            .Take(Math.Min(500, Math.Max(1, limit) * topics.Count))
            .ToArray();
        var providerName = articles.FirstOrDefault()?.Source ?? finalUrl.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase);
        return new NewsResult(
            topics[0],
            $"RSS / {providerName}",
            DateTimeOffset.UtcNow,
            articles,
            topics.ToArray(),
            dateRange?.From,
            dateRange?.To);
    }

    public async Task<NewsResult> GetCombinedNewsAsync(
        IReadOnlyList<string> topics,
        int limit,
        NewsDateRange? dateRange,
        CancellationToken cancellationToken)
    {
        if (topics.Count == 0) throw new ArgumentException("Choose at least one topic.");

        var googleTask = RunProviderAsync(() => GetGoogleNewsAsync(topics, limit, dateRange, cancellationToken), cancellationToken);
        var gdeltTask = RunProviderAsync(() => GetGdeltNewsAsync(topics, limit, dateRange, cancellationToken), cancellationToken);
        await Task.WhenAll(googleTask, gdeltTask);

        var (googleResult, googleError) = googleTask.Result;
        var (gdeltResult, gdeltError) = gdeltTask.Result;

        if (googleResult is null && gdeltResult is null)
        {
            ExceptionDispatchInfo.Capture(googleError ?? gdeltError!).Throw();
        }

        if (googleResult is not null && gdeltResult is null) return googleResult;
        if (gdeltResult is not null && googleResult is null) return gdeltResult;

        var maxArticles = Math.Min(500, Math.Max(1, limit) * topics.Count);
        var merged = MergeArticles(
            googleResult!.Articles.Concat(gdeltResult!.Articles),
            topics,
            maxArticles);
        return new NewsResult(
            topics[0],
            "Google News + GDELT",
            DateTimeOffset.UtcNow,
            merged,
            topics.ToArray(),
            dateRange?.From,
            dateRange?.To);
    }

    private static string BuildGoogleDateQuery(string topic, NewsDateRange? dateRange)
    {
        if (dateRange is null or { HasBounds: false })
            return $"\"{topic}\" when:7d";

        var parts = new List<string>(3) { $"\"{topic}\"" };
        if (dateRange.From is { } from)
            parts.Add($"after:{from.ToUniversalTime().UtcDateTime.Date.AddDays(-1):yyyy-MM-dd}");
        if (dateRange.To is { } to)
            parts.Add($"before:{to.ToUniversalTime().UtcDateTime.Date.AddDays(1):yyyy-MM-dd}");
        return string.Join(' ', parts);
    }

    private static async Task<(NewsResult? Result, Exception? Error)> RunProviderAsync(
        Func<Task<NewsResult>> fetch,
        CancellationToken cancellationToken)
    {
        try
        {
            return (await fetch(), null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            return (null, exception);
        }
    }

    private static NewsArticle[] MergeArticles(
        IEnumerable<NewsArticle> articles,
        IReadOnlyList<string> topics,
        int maxArticles)
    {
        var prepared = articles
            .Select(article =>
            {
                var url = ArticleIdentity.NormalizeUrl(article.Url) ?? article.Url;
                var matched = new HashSet<string>(article.MatchedTopics ?? [], StringComparer.OrdinalIgnoreCase);
                foreach (var topic in topics)
                {
                    if (TopicMatcher.Matches(article, topic)) matched.Add(topic);
                }
                return article with
                {
                    Url = url,
                    MatchedTopics = OrderTopics(matched, topics),
                };
            })
            .ToArray();

        if (prepared.Length == 0) return [];

        return ArticleIdentity.GroupDuplicates(prepared, article => article.Title, article => article.Url)
            .Select(group => MergeDuplicateGroup(group, topics))
            .OrderByDescending(article => article.PublishedAt)
            .Take(maxArticles)
            .ToArray();
    }

    private static NewsArticle MergeDuplicateGroup(NewsArticle[] group, IReadOnlyList<string> topics)
    {
        var primary = group
            .OrderBy(article => ArticleIdentity.IsGoogleNewsWrapperUrl(article.Url) ? 1 : 0)
            .ThenBy(article => article.Url.Length)
            .ThenByDescending(article => article.PublishedAt)
            .First();

        var mergedTopics = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in group)
        {
            if (item.MatchedTopics is not null)
                mergedTopics.UnionWith(item.MatchedTopics);
        }

        var summary = group.Select(item => item.Summary).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
        var imageUrl = group.Select(item => item.ImageUrl).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
        var publishedAt = group.Max(item => item.PublishedAt);

        return primary with
        {
            Summary = summary,
            ImageUrl = imageUrl,
            PublishedAt = publishedAt,
            MatchedTopics = OrderTopics(mergedTopics, topics),
        };
    }

    private static string[] OrderTopics(HashSet<string> matched, IReadOnlyList<string> requestedOrder)
    {
        if (matched.Count == 0) return [];
        var ordered = new List<string>(matched.Count);
        foreach (var topic in requestedOrder)
        {
            if (matched.Contains(topic) && !ordered.Contains(topic, StringComparer.OrdinalIgnoreCase))
                ordered.Add(topic);
        }
        foreach (var topic in matched)
        {
            if (!ordered.Contains(topic, StringComparer.OrdinalIgnoreCase))
                ordered.Add(topic);
        }
        return ordered.ToArray();
    }

    public async Task<string> ResolvePublisherFeedUrlAsync(
        string feedUrl,
        CancellationToken cancellationToken)
    {
        var (xml, finalUrl) = await FetchPublisherFeedAsync(feedUrl, cancellationToken);
        try
        {
            var document = XDocument.Parse(xml, LoadOptions.None);
            if (document.Root?.Name.LocalName is not ("rss" or "feed" or "RDF"))
                throw new ArgumentException("The address did not return an RSS or Atom feed.");
        }
        catch (System.Xml.XmlException)
        {
            throw new ArgumentException("The address did not return a valid RSS or Atom feed.");
        }

        return FeedUrlCanonicalizer.NormalizeForStorage(finalUrl.AbsoluteUri)
            ?? throw new ArgumentException("Publisher feeds must use a public HTTPS domain.");
    }

    public sealed record FeedDiagnosticResult(
        string Url,
        string Status,
        int StatusCode,
        long LatencyMs,
        string? FeedTitle,
        string? RedirectedUrl,
        bool IsPermanentRedirect,
        string Message);

    public async Task<FeedDiagnosticResult> DiagnosePublisherFeedAsync(
        string feedUrl,
        CancellationToken cancellationToken)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var initialUri = await ValidateFeedUrlAsync(feedUrl, cancellationToken);
            using var request = new HttpRequestMessage(HttpMethod.Get, initialUri);
            request.Headers.Accept.ParseAdd("application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9");
            request.Headers.UserAgent.ParseAdd("SignalReader/2.0");

            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            sw.Stop();

            var statusCode = (int)response.StatusCode;
            var isRedirect = statusCode is >= 300 and < 400;
            var isPermanent = statusCode is 301 or 308;
            string? redirectTarget = null;

            if (isRedirect && response.Headers.Location is not null)
            {
                var resolved = new Uri(initialUri, response.Headers.Location);
                redirectTarget = FeedUrlCanonicalizer.NormalizeForStorage(resolved.AbsoluteUri);
            }

            if (!response.IsSuccessStatusCode && !isRedirect)
            {
                return new FeedDiagnosticResult(
                    feedUrl,
                    "Unreachable",
                    statusCode,
                    sw.ElapsedMilliseconds,
                    null,
                    null,
                    false,
                    $"Feed returned HTTP {statusCode}.");
            }

            if (isRedirect)
            {
                return new FeedDiagnosticResult(
                    feedUrl,
                    "Redirected",
                    statusCode,
                    sw.ElapsedMilliseconds,
                    null,
                    redirectTarget,
                    isPermanent,
                    isPermanent ? "Permanent redirect to new feed URL." : "Temporary redirect.");
            }

            var text = await ReadLimitedTextAsync(response.Content, cancellationToken);
            string? feedTitle = null;
            try
            {
                var doc = XDocument.Parse(text, LoadOptions.None);
                var rootName = doc.Root?.Name.LocalName;
                if (rootName is not ("rss" or "feed" or "RDF"))
                {
                    return new FeedDiagnosticResult(
                        feedUrl,
                        "Degraded",
                        statusCode,
                        sw.ElapsedMilliseconds,
                        null,
                        null,
                        false,
                        "Response did not return valid RSS or Atom XML.");
                }

                feedTitle = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "title")?.Value?.Trim();
            }
            catch
            {
                return new FeedDiagnosticResult(
                    feedUrl,
                    "Degraded",
                    statusCode,
                    sw.ElapsedMilliseconds,
                    null,
                    null,
                    false,
                    "Feed XML failed to parse.");
            }

            var status = sw.ElapsedMilliseconds > 3000 ? "Degraded" : "Healthy";
            var msg = sw.ElapsedMilliseconds > 3000
                ? "Slow feed response (>3s)."
                : "Feed responsive and valid XML.";

            return new FeedDiagnosticResult(
                feedUrl,
                status,
                statusCode,
                sw.ElapsedMilliseconds,
                feedTitle,
                null,
                false,
                msg);
        }
        catch (OperationCanceledException)
        {
            sw.Stop();
            return new FeedDiagnosticResult(
                feedUrl,
                "Unreachable",
                0,
                sw.ElapsedMilliseconds,
                null,
                null,
                false,
                "Connection timed out.");
        }
        catch (Exception ex)
        {
            sw.Stop();
            return new FeedDiagnosticResult(
                feedUrl,
                "Unreachable",
                0,
                sw.ElapsedMilliseconds,
                null,
                null,
                false,
                ex.Message);
        }
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

    private static IEnumerable<NewsArticle> ParseGoogleFeed(string xml, string topic) =>
        ParseGoogleFeedItems(xml).Where(article => TopicMatcher.Matches(article, topic));

    internal static IEnumerable<NewsArticle> ParseGoogleFeedItems(string xml)
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
            var normalizedUrl = ArticleIdentity.NormalizeUrl(Value(item, "link"));
            if (string.IsNullOrWhiteSpace(title) || normalizedUrl is null) continue;
            var articleUrl = new Uri(normalizedUrl);
            yield return new NewsArticle(
                title,
                normalizedUrl,
                source,
                ParseDate(Value(item, "pubDate")),
                "",
                ImageUrl: ExtractFeedImage(item, articleUrl));
        }
    }

    internal static IEnumerable<NewsArticle> ParseBingFeedItems(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        foreach (var item in document.Descendants().Where(element => element.Name.LocalName == "item"))
        {
            var title = StripHtml(Value(item, "title"));
            var rawLink = Value(item, "link");
            var unwrapped = UnwrapBingNewsUrl(rawLink);
            var normalizedUrl = ArticleIdentity.NormalizeUrl(unwrapped);
            if (string.IsNullOrWhiteSpace(title) || normalizedUrl is null) continue;

            var uri = new Uri(normalizedUrl);
            if (uri.Scheme != Uri.UriSchemeHttps) continue;

            var source = StripHtml(Value(item, "Source") ?? Value(item, "source"));
            if (source.StartsWith("www.", StringComparison.OrdinalIgnoreCase))
                source = source[4..];
            if (string.IsNullOrWhiteSpace(source))
                source = uri.DnsSafeHost.Replace("www.", "", StringComparison.OrdinalIgnoreCase);

            var summary = StripHtml(Value(item, "description") ?? "");
            if (summary.Length > 240) summary = summary[..240];

            yield return new NewsArticle(
                title,
                normalizedUrl,
                source,
                ParseDate(Value(item, "pubDate")),
                summary);
        }
    }

    internal static string? UnwrapBingNewsUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)) return null;
        if (uri.DnsSafeHost.EndsWith("bing.com", StringComparison.OrdinalIgnoreCase)
            && uri.AbsolutePath.Contains("apiclick.aspx", StringComparison.OrdinalIgnoreCase))
        {
            var query = QueryHelpers.ParseQuery(uri.Query);
            if (query.TryGetValue("url", out var target) && !string.IsNullOrWhiteSpace(target.ToString()))
                return target.ToString().Trim();
        }
        return uri.AbsoluteUri;
    }

    internal static IEnumerable<NewsArticle> ParsePublisherFeed(
        string xml,
        Uri feedUrl,
        IReadOnlyList<string> topics)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var channel = document.Descendants().FirstOrDefault(element => element.Name.LocalName == "channel");
        var feedTitle = StripHtml(channel is null ? "" : Value(channel, "title"));
        var fallbackSource = string.IsNullOrWhiteSpace(feedTitle)
            ? feedUrl.Host.Replace("www.", "", StringComparison.OrdinalIgnoreCase)
            : feedTitle;
        var entries = document.Descendants().Where(element => element.Name.LocalName is "item" or "entry").Take(500);

        foreach (var entry in entries)
        {
            var title = StripHtml(Value(entry, "title"));
            var linkElement = entry.Elements().FirstOrDefault(element => element.Name.LocalName == "link");
            var url = Value(entry, "link");
            if (string.IsNullOrWhiteSpace(url)) url = linkElement?.Attribute("href")?.Value ?? Value(entry, "guid");
            var normalizedUrl = ArticleIdentity.NormalizeUrl(url);
            if (string.IsNullOrWhiteSpace(title) || normalizedUrl is null) continue;

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
                normalizedUrl,
                source,
                ParseDate(
                    Value(entry, "pubDate")
                    ?? Value(entry, "published")
                    ?? Value(entry, "date")
                    ?? Value(entry, "updated")
                    ?? Value(entry, "created")
                    ?? Value(entry, "issued")),
                summary,
                ImageUrl: ExtractFeedImage(entry, new Uri(normalizedUrl)));
            var matchedTopics = topics.Where(topic => TopicMatcher.Matches(article, topic)).ToArray();
            if (matchedTopics.Length > 0) yield return article with { MatchedTopics = matchedTopics };
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

    private static string ExtractFeedImage(XElement entry, Uri articleUrl)
    {
        foreach (var element in entry.Descendants())
        {
            var localName = element.Name.LocalName;
            if (localName is not ("thumbnail" or "content")) continue;
            var candidate = element.Attribute("url")?.Value;
            if (string.IsNullOrWhiteSpace(candidate)) continue;
            var medium = element.Attribute("medium")?.Value;
            var type = element.Attribute("type")?.Value;
            if (localName == "thumbnail"
                || string.Equals(medium, "image", StringComparison.OrdinalIgnoreCase)
                || type?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) == true
                || LooksLikeImageUrl(candidate))
            {
                var normalized = NormalizeImageUrl(candidate, articleUrl);
                if (normalized.Length > 0) return normalized;
            }
        }

        foreach (var enclosure in entry.Descendants().Where(element => element.Name.LocalName == "enclosure"))
        {
            var type = enclosure.Attribute("type")?.Value;
            var candidate = enclosure.Attribute("url")?.Value;
            if (string.IsNullOrWhiteSpace(candidate)
                || (type?.StartsWith("image/", StringComparison.OrdinalIgnoreCase) != true
                    && !LooksLikeImageUrl(candidate))) continue;
            var normalized = NormalizeImageUrl(candidate, articleUrl);
            if (normalized.Length > 0) return normalized;
        }

        var embeddedHtml = Value(entry, "description")
            ?? Value(entry, "summary")
            ?? Value(entry, "encoded")
            ?? "";
        var imageMatch = Regex.Match(
            WebUtility.HtmlDecode(embeddedHtml),
            """<img\b[^>]*\b(?:src|data-src)=["']([^"']+)["']""",
            RegexOptions.IgnoreCase);
        return imageMatch.Success ? NormalizeImageUrl(imageMatch.Groups[1].Value, articleUrl) : "";
    }

    private static bool LooksLikeImageUrl(string value)
    {
        var path = value.Split('?', '#')[0];
        return path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".webp", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".gif", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeImageUrl(string? value, Uri articleUrl)
    {
        if (string.IsNullOrWhiteSpace(value)
            || !Uri.TryCreate(articleUrl, value.Trim(), out var imageUrl)
            || imageUrl.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(imageUrl.UserInfo)
            || imageUrl.AbsoluteUri.Length > 2048)
            return "";
        return imageUrl.AbsoluteUri;
    }

    private static string StripHtml(string? value) =>
        Regex.Replace(WebUtility.HtmlDecode(value ?? ""), "<[^>]*>", " ")
            .Replace("\r", " ").Replace("\n", " ").Trim();

    private static readonly Dictionary<string, string> TimeZoneOffsets = new(StringComparer.OrdinalIgnoreCase)
    {
        ["UT"] = "+00:00",
        ["UTC"] = "+00:00",
        ["GMT"] = "+00:00",
        ["EDT"] = "-04:00",
        ["EST"] = "-05:00",
        ["CDT"] = "-05:00",
        ["CST"] = "-06:00",
        ["MDT"] = "-06:00",
        ["MST"] = "-07:00",
        ["PDT"] = "-07:00",
        ["PST"] = "-08:00",
        ["ADT"] = "-03:00",
        ["AST"] = "-04:00",
        ["NDT"] = "-02:30",
        ["NST"] = "-03:30",
        ["BST"] = "+01:00",
        ["CET"] = "+01:00",
        ["CEST"] = "+02:00",
        ["EET"] = "+02:00",
        ["EEST"] = "+03:00",
        ["IST"] = "+05:30",
        ["AWST"] = "+08:00",
        ["HKT"] = "+08:00",
        ["SGT"] = "+08:00",
        ["JST"] = "+09:00",
        ["KST"] = "+09:00",
        ["ACST"] = "+09:30",
        ["ACDT"] = "+10:30",
        ["AEST"] = "+10:00",
        ["AEDT"] = "+11:00",
        ["NZST"] = "+12:00",
        ["NZDT"] = "+13:00",
    };

    internal static DateTimeOffset ParseDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return DateTimeOffset.UtcNow;
        var trimmed = value.Trim();
        if (DateTimeOffset.TryParseExact(trimmed, "yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var compact))
            return compact.ToUniversalTime();
        if (DateTimeOffset.TryParse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
            return parsed.ToUniversalTime();

        var lastSpace = trimmed.LastIndexOf(' ');
        if (lastSpace > 0)
        {
            var zone = trimmed[(lastSpace + 1)..];
            if (TimeZoneOffsets.TryGetValue(zone, out var offset)
                && DateTimeOffset.TryParse($"{trimmed[..lastSpace]} {offset}", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var zoneParsed))
            {
                return zoneParsed.ToUniversalTime();
            }
        }

        return DateTimeOffset.UtcNow;
    }
}
