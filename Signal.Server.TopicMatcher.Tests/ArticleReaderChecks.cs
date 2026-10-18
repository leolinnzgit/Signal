using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;
using Signal.Server.Services;

internal static class ArticleReaderChecks
{
    private static readonly Uri ArticleUri = new("https://93.184.216.34/story");
    private const string Paragraph = "Researchers have published a detailed report about the changes in their community. The report explains the evidence, discusses what the findings mean, and describes the next steps for people who live in the region.";
    private static string Body => string.Join("", Enumerable.Range(1, 5).Select(i => $"<p>Section {i}. {Paragraph}</p>"));

    public static async Task RunAsync()
    {
        using var client = new HttpClient(new FixtureHandler(""));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var reader = new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance);
        var metadata = JsonSerializer.Serialize(new Dictionary<string, object> { ["@type"] = "NewsArticle", ["articleBody"] = "This is only a short publisher excerpt about the report.", ["author"] = new { name = "Example Author" } });
        var article = reader.ExtractArticle($"<script type='application/ld+json'>{metadata}</script><article>{Body}</article>", ArticleUri);
        Require(article.Available && article.Article!.Paragraphs.Sum(p => p.Length) > 900, "Short JSON-LD must not hide the HTML article.");
        Require(article.Article!.Byline == "Example Author", "JSON-LD byline must survive the HTML fallback.");

        var divArticle = reader.ExtractArticle($"<html><body><nav><a href='/other'>{Paragraph}</a></nav><div class='story-content'>{Body.Replace("<p>", "<div>").Replace("</p>", "</div>")}</div></body></html>", ArticleUri);
        Require(divArticle.Available, "Readability must extract article text in div elements.");

        var nestedArticle = reader.ExtractArticle($"<article><p>Short related story.</p></article><main><article>{Body}</article></main>", ArticleUri);
        Require(nestedArticle.Available, "A small related article must not mask the main story.");
        var malformedMetadata = reader.ExtractArticle($"<script type='application/ld+json'>invalid json</script><article>{Body}</article>", ArticleUri);
        Require(malformedMetadata.Available, "Malformed metadata must allow HTML extraction.");

        var structured = JsonSerializer.Serialize(new Dictionary<string, object> { ["@type"] = "NewsArticle", ["articleBody"] = string.Join("\n\n", Enumerable.Range(1, 5).Select(i => $"Section {i}. {Paragraph}")) });
        var structuredArticle = reader.ExtractArticle($"<script type='application/ld+json'>{structured}</script>", ArticleUri);
        Require(structuredArticle.Available && structuredArticle.Article!.Paragraphs.Count == 5, "Structured article paragraph boundaries must survive.");
        var paid = reader.ExtractArticle($"<script type='application/ld+json'>{{\"@type\":\"NewsArticle\",\"isAccessibleForFree\":false}}</script><article>{Body}</article>", ArticleUri);
        Require(!paid.Available && paid.Reason.Contains("subscription"), "Paid metadata must block extraction of hidden text.");
        var shortArticle = reader.ExtractArticle("<article><p>Not enough text for a complete article.</p></article>", ArticleUri);
        Require(!shortArticle.Available && shortArticle.Reason == ArticleReaderService.InsufficientTextReason, "Missing text must not claim a publisher block.");
        foreach (var challenge in new[] {
            $"<title>Attention Required! | Cloudflare</title><article>{Body}</article>",
            $"<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/example.js'></script><article>{Body}</article>"
        })
        {
            var blocked = reader.ExtractArticle(challenge, ArticleUri);
            Require(!blocked.Available && blocked.Article is null && blocked.Reason == ArticleReaderService.BotProtectionReason,
                "Bot verification prose must not become a readable article.");
        }
        Require(reader.ExtractArticle($"<title>Cloudflare explains bot protection</title><article>{Body}</article>", ArticleUri).Available,
            "News about bot protection must remain readable.");

        foreach (var status in new[] { HttpStatusCode.Forbidden, HttpStatusCode.Unauthorized, HttpStatusCode.PaymentRequired })
        {
            using var deniedClient = new HttpClient(new FixtureHandler("", status));
            using var deniedCache = new MemoryCache(new MemoryCacheOptions());
            var deniedRenderer = new FixtureRenderer(null);
            var denied = await new ArticleReaderService(deniedClient, deniedCache, NullLogger<ArticleReaderService>.Instance, deniedRenderer)
                .ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(!denied.Available && denied.Article is null && deniedRenderer.Calls == 0
                && (status == HttpStatusCode.Forbidden ? denied.Reason == ArticleReaderService.PublisherBlockedReason : denied.Reason.Contains("subscription")),
                "HTTP access blocks must be distinguished from login and subscription requirements without rendering.");
        }
        foreach (var status in new[] { HttpStatusCode.OK, HttpStatusCode.Forbidden, HttpStatusCode.ServiceUnavailable })
        {
            using var challengeClient = new HttpClient(new ChallengeHandler(status));
            using var challengeCache = new MemoryCache(new MemoryCacheOptions());
            var challengeRenderer = new FixtureRenderer(null);
            var challenge = await new ArticleReaderService(challengeClient, challengeCache, NullLogger<ArticleReaderService>.Instance, challengeRenderer)
                .ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(!challenge.Available && challenge.Article is null && challenge.Reason == ArticleReaderService.BotProtectionReason
                && challengeRenderer.Calls == 0, "Explicit bot challenges must stop before extraction or browser rendering, regardless of HTTP status.");
        }
        var hugeBody = JsonSerializer.Serialize(new Dictionary<string, object> { ["@type"] = "Article", ["articleBody"] = new string('a', 35_000) });
        var hugeArticle = reader.ExtractArticle($"<script type='application/ld+json'>{hugeBody}</script>", ArticleUri);
        Require(hugeArticle.Available && hugeArticle.Article!.Paragraphs.Sum(p => p.Length) == 30_000, "Article text must remain bounded.");

        var renderer = new FixtureRenderer(new RenderedArticlePage(ArticleUri, $"<article>{Body}</article>"));
        using var dynamicClient = new HttpClient(new FixtureHandler("<main>Loading article...</main>"));
        using var dynamicCache = new MemoryCache(new MemoryCacheOptions());
        var dynamicReader = new ArticleReaderService(dynamicClient, dynamicCache, NullLogger<ArticleReaderService>.Instance, renderer);
        Require((await dynamicReader.ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None)).Available, "Insufficient static text must try the browser.");
        await dynamicReader.ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
        Require(renderer.Calls == 1, "Rendered articles must reuse the reader cache.");

        foreach (var fixture in new[] { ("<article>Subscribe to continue</article>", HttpStatusCode.OK), ($"<article>{Body}</article>", HttpStatusCode.OK), ("", HttpStatusCode.Forbidden) })
        {
            var unusedRenderer = new FixtureRenderer(null);
            using var fixtureClient = new HttpClient(new FixtureHandler(fixture.Item1, fixture.Item2));
            using var fixtureCache = new MemoryCache(new MemoryCacheOptions());
            var fixtureReader = new ArticleReaderService(fixtureClient, fixtureCache, NullLogger<ArticleReaderService>.Instance, unusedRenderer);
            await fixtureReader.ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(unusedRenderer.Calls == 0, "Usable articles, paywalls and access denials must not launch a browser.");
        }
        foreach (var url in new[] { "https://127.0.0.1/", "https://[::ffff:127.0.0.1]/", "https://100.100.100.100/", "https://localhost/", "http://example.com/" })
        {
            try
            {
                await ArticleReaderService.ValidatePublicArticleUriAsync(url, CancellationToken.None);
                throw new InvalidOperationException($"Reader accepted an internal URL: {url}");
            }
            catch (ArgumentException) { }
        }
        await StuffArticleChecks.RunAsync();
        await RunGoogleNewsAsync();
        Console.WriteLine("Article reader passed metadata, DOM parsing, paywall, browser fallback, cache and URL checks.");
    }

    private static async Task RunGoogleNewsAsync()
    {
        const string googleUrl = "https://news.google.com/rss/articles/test123?oc=5";
        foreach (var path in new[] { "/rss/articles/test123", "/articles/test123", "/read/test123" })
            Require(GoogleNewsArticleUrl.IsRedirectPage(new Uri("https://news.google.com" + path)), "Google News article path must be recognized.");
        Require(!GoogleNewsArticleUrl.IsRedirectPage(new Uri("https://news.google.com.evil.example/articles/test123"))
            && !GoogleNewsArticleUrl.IsRedirectPage(new Uri("https://news.google.com/search")), "Only exact Google News article pages may use the resolver.");

        var handler = new GoogleFixtureHandler(ArticleUri.AbsoluteUri);
        using var client = new HttpClient(handler);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var renderer = new FixtureRenderer(null);
        var reader = new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance, renderer);
        var article = await reader.ReadAsync(googleUrl, CancellationToken.None);
        Require(article.Available && article.Article!.FinalUrl == ArticleUri.AbsoluteUri, "Google News stories must extract the publisher page, not the Google wrapper.");
        await reader.ReadAsync(googleUrl, CancellationToken.None);
        Require(await reader.ResolveUrlAsync(googleUrl, CancellationToken.None) == ArticleUri.AbsoluteUri, "Open original must reuse the resolved publisher link.");
        Require(handler.PageRequests == 1 && handler.ResolutionRequests == 1 && handler.PublisherRequests == 1 && renderer.Calls == 0, "Successful Google links must be cached and avoid browser rendering.");

        using var freshCache = new MemoryCache(new MemoryCacheOptions());
        var freshReader = new ArticleReaderService(client, freshCache, NullLogger<ArticleReaderService>.Instance);
        Require(await freshReader.ResolveUrlAsync(googleUrl, CancellationToken.None) == ArticleUri.AbsoluteUri, "Original-link resolution must work before opening the reader.");
        Require((await freshReader.ReadAsync(googleUrl, CancellationToken.None)).Available && handler.ResolutionRequests == 2, "Reader extraction must reuse the original-link resolution cache.");

        foreach (var missingMetadata in new[] { false, true })
        {
            var unavailable = new GoogleFixtureHandler(null, missingMetadata: missingMetadata);
            using var unavailableClient = new HttpClient(unavailable);
            using var unavailableCache = new MemoryCache(new MemoryCacheOptions());
            var unavailableRenderer = new FixtureRenderer(null);
            var unavailableReader = new ArticleReaderService(unavailableClient, unavailableCache, NullLogger<ArticleReaderService>.Instance, unavailableRenderer);
            var failure = await unavailableReader.ReadAsync(googleUrl, CancellationToken.None);
            Require(!failure.Available && failure.Reason == ArticleReaderService.GoogleNewsResolutionReason, "Missing Google links must explain resolution failure.");
            Require(unavailableRenderer.Calls == 0 && unavailable.PublisherRequests == 0, "Unresolved Google wrappers must not be rendered or mistaken for article text.");
        }
        var denied = new GoogleFixtureHandler(ArticleUri.AbsoluteUri, resolutionStatus: HttpStatusCode.Redirect);
        using var deniedClient = new HttpClient(denied);
        Require(await GoogleNewsArticleUrl.ResolveAsync(deniedClient, new Uri(googleUrl), GoogleFixtureHandler.Page, CancellationToken.None) is null,
            "Resolution endpoint redirects must not be followed.");
        Require(denied.ResolutionRequests == 1 && denied.PublisherRequests == 0, "Redirected resolution must remain bounded to the fixed endpoint.");

        foreach (var target in new[] { "https://127.0.0.1/private", "http://93.184.216.34/story", "https://user:pass@93.184.216.34/story", "https://93.184.216.34:8443/story" })
        {
            var unsafeHandler = new GoogleFixtureHandler(target);
            using var unsafeClient = new HttpClient(unsafeHandler);
            try
            {
                await GoogleNewsArticleUrl.ResolveAsync(unsafeClient, new Uri(googleUrl), GoogleFixtureHandler.Page, CancellationToken.None);
                throw new InvalidOperationException("An unsafe decoded publisher URL was accepted.");
            }
            catch (ArgumentException) { }
            Require(unsafeHandler.PublisherRequests == 0, "Decoded URLs must be validated before contacting the destination.");
        }
        Require(GoogleNewsArticleUrl.ReadResolvedUrl(")]}'\n\n25\n[[\"wrb.fr\",\"other\",\"ignored\"]]\n\n" + GoogleFixtureHandler.Response(ArticleUri.AbsoluteUri)) == ArticleUri.AbsoluteUri,
            "Length-framed resolution must ignore unrelated RPC results and parse the signed article response.");
        Require(GoogleNewsArticleUrl.ReadResolvedUrl("not JSON\n[[\"wrb.fr\",\"Fbv4je\",\"invalid\"]]") is null, "Malformed resolution responses must fail gracefully.");
        Console.WriteLine("Google News reader passed publisher resolution, original links, cache, unsupported responses and unsafe-destination checks.");
    }

    public static async Task RunBrowserAsync()
    {
        var script = $"setTimeout(() => document.querySelector('main').innerHTML = {JsonSerializer.Serialize(Body)}, 100); fetch('https://127.0.0.1/private').catch(() => {{}});";
        var handler = new BrowserFixtureHandler(script);
        using var logs = LoggerFactory.Create(builder => builder.AddConsole().SetMinimumLevel(LogLevel.Debug));
        using var renderer = new ArticlePageRenderer(new FixtureClientFactory(handler), logs.CreateLogger<ArticlePageRenderer>());
        var rendered = await renderer.RenderAsync(ArticleUri, "<html><body><main>Loading...</main><script src='/article.js'></script><script src='/redirect.js'></script></body></html>", CancellationToken.None);
        Require(rendered is not null && rendered.Html.Contains("Section 5."), $"A real browser must render the JavaScript article (scripts: {handler.ScriptRequests}, redirects: {handler.RedirectRequests}).");
        Require(handler.ScriptRequests == 1 && handler.RedirectRequests == 1 && handler.PrivateRequests == 0, "Browser resource fetching must validate both direct requests and redirect targets.");
        using var client = new HttpClient(new FixtureHandler(""));
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var reader = new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance);
        Require(reader.ExtractArticle(rendered!.Html, rendered.Url).Available, "Rendered HTML must be readable.");
        Console.WriteLine("Real browser passed JavaScript rendering and internal-address redirect protection checks.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class FixtureHandler(string html, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(html, System.Text.Encoding.UTF8, "text/html") });
    }

    private sealed class ChallengeHandler(HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = new HttpResponseMessage(status) { Content = new StringContent($"<article>{Body}</article>", System.Text.Encoding.UTF8, "text/html") };
            response.Headers.Add("cf-mitigated", "challenge");
            return Task.FromResult(response);
        }
    }

    private sealed class GoogleFixtureHandler(string? target, bool missingMetadata = false, HttpStatusCode resolutionStatus = HttpStatusCode.OK) : HttpMessageHandler
    {
        public const string Page = "<html><body><div data-n-a-id='test123' data-n-a-ts='1791925721' data-n-a-sg='public-signature'></div></body></html>";
        public int PageRequests;
        public int ResolutionRequests;
        public int PublisherRequests;
        public static string Response(string? url) => ")]}'\n\n" + JsonSerializer.Serialize(new[] { new object?[] { "wrb.fr", "Fbv4je", url is null ? null : JsonSerializer.Serialize(new[] { "garturlres", url }), null } });

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Post)
            {
                Require(request.RequestUri!.AbsoluteUri == "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", "Signed link resolution must use a fixed Google endpoint.");
                var form = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(await request.Content!.ReadAsStringAsync(cancellationToken));
                using var payload = JsonDocument.Parse(form["f.req"].ToString());
                var rpc = payload.RootElement[0][0];
                Require(rpc[0].GetString() == "Fbv4je", "Only the article link RPC may be called.");
                using var query = JsonDocument.Parse(rpc[1].GetString()!);
                Require(query.RootElement[0].GetString() == "garturlreq" && query.RootElement[2].GetString() == "test123"
                    && query.RootElement[3].GetInt64() == 1791925721 && query.RootElement[4].GetString() == "public-signature", "Resolution must preserve the page's article ID, numeric timestamp and signature.");
                ResolutionRequests++;
                var response = new HttpResponseMessage(resolutionStatus) { Content = new StringContent(Response(target)) };
                if (resolutionStatus == HttpStatusCode.Redirect) response.Headers.Location = new Uri("https://127.0.0.1/private");
                return response;
            }
            if (request.RequestUri!.Host == "news.google.com")
            {
                PageRequests++;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(missingMetadata ? "<main>Loading...</main>" : Page, System.Text.Encoding.UTF8, "text/html") };
            }
            Require(request.RequestUri == ArticleUri, "The fixture must not contact unexpected destinations.");
            PublisherRequests++;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent($"<article>{Body}</article>", System.Text.Encoding.UTF8, "text/html") };
        }
    }

    private sealed class FixtureRenderer(RenderedArticlePage? result) : IArticlePageRenderer
    {
        public int Calls { get; private set; }
        public Task<RenderedArticlePage?> RenderAsync(Uri uri, string html, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(result);
        }
    }

    private sealed class FixtureClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class BrowserFixtureHandler(string script) : HttpMessageHandler
    {
        public int ScriptRequests;
        public int RedirectRequests;
        public int PrivateRequests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath == "/article.js")
            {
                ScriptRequests++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(script, System.Text.Encoding.UTF8, "application/javascript") });
            }
            if (request.RequestUri.AbsolutePath == "/redirect.js")
            {
                RedirectRequests++;
                var redirect = new HttpResponseMessage(HttpStatusCode.Redirect);
                redirect.Headers.Location = new Uri("https://127.0.0.1/private");
                return Task.FromResult(redirect);
            }
            PrivateRequests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
        }
    }
}
