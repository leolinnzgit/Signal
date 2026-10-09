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
        Console.WriteLine("Article reader passed metadata, DOM parsing, paywall, browser fallback, cache and URL checks.");
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
