using System.Net;
using System.Security.Claims;
using System.Text;
using System.Web;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class OpenCoverageChecks
{
    public static async Task RunAsync()
    {
        await PaywalledArticleCachesHeadlineAndSetsPaywalledFlagAsync();
        BingAndGoogleFeedParsersHandleRedirectsAndMetadata();
        await OpenCoverageRefinesDiscoversAndExcludesPaywalledDuplicateAsync();
        await OpenCoverageValidationAndControllerResponsesWorkAsync();
        Console.WriteLine("OpenCoverage checks passed.");
    }

    private static async Task PaywalledArticleCachesHeadlineAndSetsPaywalledFlagAsync()
    {
        var paywalledUrl = "https://93.184.216.34/business/new-taipei-auckland-flights/premium/ABC123/";
        using var handler = new RoutingHandler(req =>
        {
            if (req.RequestUri?.AbsoluteUri == paywalledUrl)
            {
                return HtmlResponse("""
                    <!doctype html>
                    <html>
                    <head>
                      <title>New Taipei-Auckland flights via Sydney as Starlux Airlines expands - NZ Herald</title>
                      <meta property="og:title" content="New Taipei-Auckland flights via Sydney as Starlux Airlines expands" />
                      <script type="application/ld+json">
                      {
                        "@context": "https://schema.org",
                        "@type": "NewsArticle",
                        "headline": "New Taipei-Auckland flights via Sydney as Starlux Airlines expands",
                        "isAccessibleForFree": false
                      }
                      </script>
                    </head>
                    <body>
                      <article>
                        <p>Subscribe to NZ Herald Premium to read this story.</p>
                      </article>
                    </body>
                    </html>
                    """);
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        using var http = new HttpClient(handler);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var reader = new ArticleReaderService(http, cache, NullLogger<ArticleReaderService>.Instance);

        var result = await reader.ReadAsync(paywalledUrl, CancellationToken.None);
        Assert(!result.Available, "Paywalled article should not be marked available.");
        Assert(result.Paywalled, "Paywalled article should set Paywalled = true.");

        var cachedHeadline = reader.GetCachedPublicHeadline(paywalledUrl);
        Assert(
            cachedHeadline is not null && cachedHeadline.Contains("Starlux Airlines", StringComparison.OrdinalIgnoreCase),
            $"Expected cached public headline to include Starlux Airlines, got '{cachedHeadline}'.");
    }

    private static void BingAndGoogleFeedParsersHandleRedirectsAndMetadata()
    {
        var unwrapped = NewsService.UnwrapBingNewsUrl(
            "https://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&url=https%3a%2f%2fwww.aeroroutes.com%2feng%2f261110-jxns27sw&c=123");
        AssertEqual("https://www.aeroroutes.com/eng/261110-jxns27sw", unwrapped ?? "", "Bing apiclick unwrapping");

        var unwrappedHttp = NewsService.UnwrapBingNewsUrl(
            "https://www.bing.com/news/apiclick.aspx?url=http%3a%2f%2fexample.com%2fstory");
        AssertEqual("http://example.com/story", unwrappedHttp ?? "", "Unwrapped insecure URL before normalization");

        const string bingXml = """
            <?xml version="1.0" encoding="utf-8" ?>
            <rss version="2.0" xmlns:News="http://www.bing.com:80/news/search/">
              <channel>
                <item>
                  <title>Insecure http article should be skipped</title>
                  <link>https://www.bing.com/news/apiclick.aspx?url=http%3A%2F%2Fexample.com%2Fstory</link>
                  <description>Skipped insecure article.</description>
                  <pubDate>Wed, 11 Nov 2026 02:00:00 GMT</pubDate>
                  <News:Source>Example</News:Source>
                </item>
                <item>
                  <title>Starlux Plans Sydney / Auckland late-March 2027 Debut</title>
                  <link>https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fwww.aeroroutes.com%2Feng%2F261110-jxns27sw</link>
                  <description>&lt;p&gt;Taipei carrier plans 4 weekly flights.&lt;/p&gt;</description>
                  <pubDate>Wed, 11 Nov 2026 02:30:00 GMT</pubDate>
                  <News:Source>AeroRoutes</News:Source>
                </item>
              </channel>
            </rss>
            """;

        var bingItems = NewsService.ParseBingFeedItems(bingXml).ToArray();
        AssertEqual(1, bingItems.Length, "Bing item count");
        AssertEqual("https://www.aeroroutes.com/eng/261110-jxns27sw", bingItems[0].Url, "Bing parsed URL");
        AssertEqual("Taipei carrier plans 4 weekly flights.", bingItems[0].Summary, "Bing stripped summary");

        const string googleXml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0">
              <channel>
                <item>
                  <title>Sydney Airport welcomes Starlux - Aviation Wire</title>
                  <link>https://www.aviationwire.example/starlux-sydney-auckland</link>
                  <description>New Taipei-Sydney-Auckland route announced.</description>
                  <pubDate>Wed, 11 Nov 2026 05:00:00 GMT</pubDate>
                  <source url="https://www.aviationwire.example">Aviation Wire</source>
                </item>
              </channel>
            </rss>
            """;

        var googleItems = NewsService.ParseGoogleFeedItems(googleXml).ToArray();
        AssertEqual(1, googleItems.Length, "Google item count");
        AssertEqual("Aviation Wire", googleItems[0].Source, "Google source");
        AssertEqual("Sydney Airport welcomes Starlux", googleItems[0].Title, "Google stripped title");
    }

    private static async Task OpenCoverageRefinesDiscoversAndExcludesPaywalledDuplicateAsync()
    {
        const string originalUrl = "https://93.184.216.34/business/taipei-auckland-flights/123";
        const string sameHostPremiumUrl = "https://93.184.216.34/premium/taipei-auckland-flights/999";
        const string openArticleUrl = "https://93.184.216.35/eng/starlux-auckland-debut";
        const string paywalledCandidateUrl = "https://93.184.216.37/subscriber-starlux-auckland";

        var requestsSeen = new List<string>();
        var pubDate = DateTimeOffset.UtcNow.AddHours(-4).ToString("R");

        using var handler = new RoutingHandler(req =>
        {
            var uri = req.RequestUri!;
            requestsSeen.Add(uri.AbsoluteUri);

            if (uri.Host.Equals("www.bing.com", StringComparison.OrdinalIgnoreCase))
            {
                var q = HttpUtility.ParseQueryString(uri.Query)["q"] ?? "";
                if (q.Contains("Starlux", StringComparison.OrdinalIgnoreCase))
                {
                    var encodedOpen = Uri.EscapeDataString(openArticleUrl);
                    return XmlResponse($"""
                        <?xml version="1.0" encoding="utf-8" ?>
                        <rss version="2.0" xmlns:News="http://www.bing.com:80/news/search/">
                          <channel>
                            <item>
                              <title>Starlux Plans Sydney / Auckland late-March 2027 Debut</title>
                              <link>https://www.bing.com/news/apiclick.aspx?url={encodedOpen}</link>
                              <description>Starlux Airlines schedules Taipei to Auckland flights via Sydney.</description>
                              <pubDate>{pubDate}</pubDate>
                              <News:Source>AeroRoutes</News:Source>
                            </item>
                          </channel>
                        </rss>
                        """);
                }

                var encodedPremium = Uri.EscapeDataString(sameHostPremiumUrl);
                var encodedUnrelated = Uri.EscapeDataString("https://93.184.216.36/markets-today");
                return XmlResponse($"""
                    <?xml version="1.0" encoding="utf-8" ?>
                    <rss version="2.0" xmlns:News="http://www.bing.com:80/news/search/">
                      <channel>
                        <item>
                          <title>New Taipei-Auckland flights via Sydney as Starlux Airlines expands</title>
                          <link>https://www.bing.com/news/apiclick.aspx?url={encodedPremium}</link>
                          <description>NZ Herald subscriber article with expanded headline details.</description>
                          <pubDate>{pubDate}</pubDate>
                          <News:Source>NZ Herald</News:Source>
                        </item>
                        <item>
                          <title>Quarterly market roundup for local bonds</title>
                          <link>https://www.bing.com/news/apiclick.aspx?url={encodedUnrelated}</link>
                          <description>Unrelated financial brief.</description>
                          <pubDate>{pubDate}</pubDate>
                          <News:Source>Finance Wire</News:Source>
                        </item>
                      </channel>
                    </rss>
                    """);
            }

            if (uri.Host.Equals("news.google.com", StringComparison.OrdinalIgnoreCase))
            {
                var q = HttpUtility.ParseQueryString(uri.Query)["q"] ?? "";
                if (q.Contains("Starlux", StringComparison.OrdinalIgnoreCase))
                {
                    return XmlResponse($"""
                        <?xml version="1.0" encoding="UTF-8"?>
                        <rss version="2.0">
                          <channel>
                            <item>
                              <title>Starlux Airlines Taipei Auckland schedule details</title>
                              <link>{paywalledCandidateUrl}</link>
                              <description>Subscriber briefing on trans-Tasman extension.</description>
                              <pubDate>{pubDate}</pubDate>
                              <source url="https://93.184.216.37">Paywall Wire</source>
                            </item>
                          </channel>
                        </rss>
                        """);
                }

                return XmlResponse("""<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel></channel></rss>""");
            }

            if (uri.AbsoluteUri == openArticleUrl)
            {
                return HtmlResponse("""
                    <!doctype html>
                    <html>
                    <head>
                      <title>Starlux Plans Sydney / Auckland late-March 2027 Debut</title>
                      <meta property="og:site_name" content="AeroRoutes" />
                      <meta property="article:published_time" content="2026-11-11T04:30:00Z" />
                    </head>
                    <body>
                      <article>
                        <p>Starlux Airlines in its latest schedule filing has outlined plans to extend its Taipei Taoyuan service via Sydney onward to Auckland starting in late March 2027 using widebody aircraft.</p>
                        <p>According to timetable filings reviewed this week, the Taiwanese carrier intends to operate four weekly round-trip flights connecting Taipei, Sydney, and Auckland with full traffic rights pending final regulatory clearances.</p>
                        <p>Industry observers noted that the one-stop Taipei-Sydney-Auckland routing adds new capacity ahead of the mid-year travel season and introduces fresh competition on links between East Asia and New Zealand.</p>
                      </article>
                    </body>
                    </html>
                    """);
            }

            if (uri.AbsoluteUri == paywalledCandidateUrl)
            {
                return HtmlResponse("""
                    <!doctype html>
                    <html>
                    <head>
                      <title>Starlux Airlines Taipei Auckland schedule details</title>
                      <script type="application/ld+json">
                      {"@type":"NewsArticle","isAccessibleForFree":false}
                      </script>
                    </head>
                    <body><article><p>Subscriber login required.</p></article></body>
                    </html>
                    """);
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        using var http = new HttpClient(handler);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var news = new NewsService(http);
        var reader = new ArticleReaderService(http, cache, NullLogger<ArticleReaderService>.Instance);
        var openCoverage = new OpenCoverageService(news, reader, cache, NullLogger<OpenCoverageService>.Instance);

        var response = await openCoverage.FindOpenCoverageAsync(
            "user-1",
            new OpenCoverageRequest(originalUrl, "New Taipei-Auckland flights confirmed", "NZ Herald"),
            CancellationToken.None);

        Assert(response.Available, "Expected verified open coverage to be found.");
        Assert(
            response.QueryUsed.Contains("Starlux", StringComparison.OrdinalIgnoreCase),
            $"Expected refined query to contain Starlux, got '{response.QueryUsed}'.");
        AssertEqual(1, response.Articles.Length, "Expected exactly 1 readable open article");
        AssertEqual(openArticleUrl, response.Articles[0].Url, "Verified open article URL");
        Assert(response.Articles[0].ReaderArticle.Paragraphs.Count >= 2, "Expected extracted paragraphs on open article.");
        Assert(response.Articles[0].Snippet.Contains("Starlux Airlines", StringComparison.OrdinalIgnoreCase), "Expected meaningful snippet.");
        Assert(!requestsSeen.Contains(sameHostPremiumUrl), "Same-host /premium/ link should be filtered before probing.");

        var countAfterFirstCall = requestsSeen.Count;
        var cachedResponse = await openCoverage.FindOpenCoverageAsync(
            "user-1",
            new OpenCoverageRequest(originalUrl, "New Taipei-Auckland flights confirmed", "NZ Herald"),
            CancellationToken.None);
        AssertEqual(countAfterFirstCall, requestsSeen.Count, "Second lookup should be served from memory cache");
        AssertEqual(1, cachedResponse.Articles.Length, "Cached open article count");
    }

    private static async Task OpenCoverageValidationAndControllerResponsesWorkAsync()
    {
        using var handler = new RoutingHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        using var http = new HttpClient(handler);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var news = new NewsService(http);
        var reader = new ArticleReaderService(http, cache, NullLogger<ArticleReaderService>.Instance);
        var openCoverage = new OpenCoverageService(news, reader, cache, NullLogger<OpenCoverageService>.Instance);

        var threwOnLocalhost = false;
        try
        {
            await openCoverage.FindOpenCoverageAsync(
                "user-1",
                new OpenCoverageRequest("https://localhost/story", "Valid headline"),
                CancellationToken.None);
        }
        catch (ArgumentException)
        {
            threwOnLocalhost = true;
        }
        Assert(threwOnLocalhost, "Private/localhost article URL must fail validation.");

        var controller = new ArticleReaderController(reader, NullLogger<ArticleReaderController>.Instance, openCoverage)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        [new Claim(ClaimTypes.NameIdentifier, "user-1")],
                        "Test"))
                }
            }
        };

        var badResult = await controller.FindOpenCoverage(
            new OpenCoverageRequest("https://93.184.216.34/story", "ab"),
            CancellationToken.None);
        Assert(badResult is BadRequestObjectResult, "Short headline should return HTTP 400 BadRequest.");

        var noResult = await controller.FindOpenCoverage(
            new OpenCoverageRequest("https://93.184.216.34/story", "Taipei Auckland flights confirmed"),
            CancellationToken.None);
        var ok = noResult as OkObjectResult ?? throw new InvalidOperationException("Expected 200 OkObjectResult.");
        var payload = ok.Value as OpenCoverageResponse ?? throw new InvalidOperationException("Expected OpenCoverageResponse payload.");
        Assert(!payload.Available, "Expected Available = false when no feeds returned candidates.");
        AssertEqual(0, payload.Articles.Length, "Expected empty open articles array");
    }

    private static HttpResponseMessage HtmlResponse(string html) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(html, Encoding.UTF8, "text/html")
    };

    private static HttpResponseMessage XmlResponse(string xml) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(xml, Encoding.UTF8, "application/rss+xml")
    };

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void AssertEqual<T>(T expected, T actual, string label)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{label}: expected '{expected}', got '{actual}'.");
        }
    }

    private sealed class RoutingHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(responder(request));
    }
}
