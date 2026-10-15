using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Signal.Server.Services;

internal static class StuffArticleChecks
{
    private static readonly Uri ArticleUri = new("https://www.stuff.co.nz/business/361045844/example-story");
    private const string Paragraph = "The local company has published a detailed report for its community. The report explains its trading conditions, describes changes during the year, and sets out the next steps for staff and customers.";
    private static string Body => string.Join("", Enumerable.Range(1, 5).Select(i => $"<p>Section {i}. {Paragraph}</p>"));

    public static async Task RunAsync()
    {
        Require(ArticleReaderService.StuffArticleApiUri(ArticleUri)?.AbsoluteUri
            == "https://www.stuff.co.nz/api/v1.0/stuff/story/361045844", "Stuff URLs must use the fixed public story endpoint.");
        foreach (var url in new[] {
            "https://stuff.co.nz.evil.example/business/361045844/story", "https://api.stuff.co.nz/business/361045844/story",
            "http://www.stuff.co.nz/business/361045844/story", "https://user:pass@www.stuff.co.nz/business/361045844/story",
            "https://www.stuff.co.nz:8443/business/361045844/story", "https://www.stuff.co.nz/business",
            "https://www.stuff.co.nz/api/v1.0/stuff/story/361045844", "https://www.stuff.co.nz/business/361045844/361045845"
        }) Require(ArticleReaderService.StuffArticleApiUri(new Uri(url)) is null, "Other hosts, unsafe URLs and ambiguous article paths must not select the Stuff endpoint.");

        using (var handler = new FixtureHandler(Story("open")))
        using (var client = new HttpClient(handler))
        using (var cache = new MemoryCache(new MemoryCacheOptions()))
        {
            var renderer = new FixtureRenderer();
            var reader = new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance, renderer);
            var result = await reader.ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(result.Available && result.Article!.Paragraphs.Count == 5, "Open Stuff stories must extract all paragraph boundaries from the public response.");
            Require(result.Article!.FinalUrl == ArticleUri.AbsoluteUri && result.Article.SiteName == "Stuff"
                && result.Article.Byline == "Example Author" && result.Article.PublishedAt == "2026-10-12T22:51:23Z", "Stuff extraction must retain the original URL and byline metadata.");
            await reader.ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(handler.Requests == 2 && renderer.Calls == 0, "Public response extraction must avoid Chromium and reuse the reader cache.");
        }

        foreach (var access in new[] { "premium", "registered" })
        {
            using var handler = new FixtureHandler(Story(access));
            using var client = new HttpClient(handler);
            using var cache = new MemoryCache(new MemoryCacheOptions());
            var renderer = new FixtureRenderer();
            var result = await new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance, renderer)
                .ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(!result.Available && result.Reason.Contains("subscription") && result.Article is null
                && renderer.Calls == 0, "Restricted Stuff responses must not expose their body or launch the browser.");
        }

        foreach (var page in new[] { $"<article>{Body}</article>", "<article>Subscribe to continue</article>",
            "<script type='application/ld+json'>{\"@type\":\"NewsArticle\",\"isAccessibleForFree\":false}</script>" })
        {
            using var handler = new FixtureHandler(Story("open"), page);
            using var client = new HttpClient(handler);
            using var cache = new MemoryCache(new MemoryCacheOptions());
            await new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance)
                .ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(handler.Requests == 1, "Usable HTML and explicit page paywalls must not fetch the Stuff API.");
        }

        foreach (var response in new[] { "invalid JSON", Story("open", 361045845), Story(""), "[]", "{}" })
        {
            using var handler = new FixtureHandler(response);
            using var client = new HttpClient(handler);
            using var cache = new MemoryCache(new MemoryCacheOptions());
            var renderer = new FixtureRenderer();
            var result = await new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance, renderer)
                .ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(result.Available && renderer.Calls == 1, "Malformed, mismatched and unclassified responses must retain the existing browser fallback.");
        }

        using (var handler = new FixtureHandler("", status: HttpStatusCode.Redirect))
        using (var client = new HttpClient(handler))
        using (var cache = new MemoryCache(new MemoryCacheOptions()))
        {
            var result = await new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance)
                .ReadAsync(ArticleUri.AbsoluteUri, CancellationToken.None);
            Require(!result.Available && handler.Requests == 2, "Stuff API redirects must not be followed to an unchecked destination.");
        }
        Console.WriteLine("Stuff reader passed public story extraction, metadata, caching, access controls and fallback checks.");
    }

    private static string Story(string access, int id = 361045844) => JsonSerializer.Serialize(new {
        id, type = "ARTICLE", contentAccess = access,
        content = new { contentBody = new { body = Body } },
        author = new[] { new { name = "Example Author" } },
        mainPublicationName = "Stuff", publishedDate = "2026-10-12T22:51:23Z"
    });

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class FixtureRenderer : IArticlePageRenderer
    {
        public int Calls;
        public Task<RenderedArticlePage?> RenderAsync(Uri uri, string html, CancellationToken token)
        {
            Calls++;
            return Task.FromResult<RenderedArticlePage?>(new(uri, $"<article>{Body}</article>"));
        }
    }

    private sealed class FixtureHandler(string json, string page = "<div id='root'></div>", HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public int Requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Requests++;
            Require(request.Method == HttpMethod.Get, "Stuff extraction must only issue GET requests.");
            if (request.RequestUri == ArticleUri)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(page, System.Text.Encoding.UTF8, "text/html") });
            Require(request.RequestUri?.AbsoluteUri == "https://www.stuff.co.nz/api/v1.0/stuff/story/361045844", "The article fixture must not contact other destinations.");
            var response = new HttpResponseMessage(status) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
            if (status == HttpStatusCode.Redirect) response.Headers.Location = new Uri("https://127.0.0.1/private");
            return Task.FromResult(response);
        }
    }
}
