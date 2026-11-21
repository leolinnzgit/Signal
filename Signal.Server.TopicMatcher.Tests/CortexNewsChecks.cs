using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class CortexNewsChecks
{
    public static async Task RunAsync(string? modelRoot = null)
    {
        var settings = new CortexNewsOptions
        {
            Enabled = true,
            Endpoint = "https://test.search.windows.net",
            QueryKey = "test-query-key",
            AdminKey = "test-admin-key",
        };
        var transport = new SearchTransport();
        using var http = new HttpClient(transport, disposeHandler: false);
        var search = new CortexNewsSearch(new ClientFactory(transport), Options.Create(settings),
            new TestEmbeddings(), NullLogger<CortexNewsSearch>.Instance);
        var query = "supply (NVDA)";
        var controller = new SignalCortexController(publicNews: search);
        var request = new SignalCortexController.CortexSearchRequest(query, []);
        var response = (SignalCortexController.CortexSearchResponse)
            ((OkObjectResult)await controller.Search(request, default)).Value!;
        Require(response.PublicNews is [{ Title: "Chip supply", Publisher: "RNZ", Excerpt: "New capacity" }],
            "Cortex should return the ranked results and discard unsafe URLs.");
        Require(transport.Key == settings.QueryKey, "Search should use only the query key.");
        using (var body = JsonDocument.Parse(transport.Body!))
        {
            var root = body.RootElement;
            Require(root.GetProperty("search").GetString() == @"supply \(NVDA\)", "The keyword query should escape operators.");
            Require(root.GetProperty("vectorQueries")[0].GetProperty("vector").GetArrayLength() == CortexNewsEmbeddings.Dimensions,
                "The query should also include the local embedding.");
            Require(root.GetProperty("filter").GetString()!.StartsWith("publishedAt ge "), "Search should filter expired news.");
        }

        transport.Status = HttpStatusCode.ServiceUnavailable;
        var fallbackRequest = new SignalCortexController.CortexSearchRequest("NVDA",
            [new("NVDA breaks ground", "Local feed", "https://local.example/news")]);
        var fallback = (SignalCortexController.CortexSearchResponse)
            ((OkObjectResult)await controller.Search(fallbackRequest, default)).Value!;
        Require(fallback.PublicNews is null
            && fallback.CrossDomainHits.Any(hit => hit.Title == "NVDA breaks ground"),
            "An Azure failure should preserve the existing search results.");
        settings.Enabled = false;
        var requests = transport.RequestCount;
        Require(await search.SearchAsync(query, default) is null && transport.RequestCount == requests,
            "Disabled search should avoid Azure and local model requests.");
        settings.Enabled = true;

        transport.Status = HttpStatusCode.OK;
        var index = new AzureCortexNewsIndex(http, settings);
        await index.EnsureIndexAsync(default);
        Require(transport.Key == settings.AdminKey && transport.IndexCreated, "The worker should create the index with its admin key.");
        var now = DateTimeOffset.UtcNow;
        var article = new NewsArticle(Title: "Chip supply", Source: "RNZ", Url: "https://example.com/story?utm_source=foo", PublishedAt: now, Summary: "New capacity");
        var item = CortexNewsIndexWorker.ToIndexArticle(article)!;
        var sameStory = CortexNewsIndexWorker.ToIndexArticle(article with { Url = "https://example.com/story" })!;
        Require(item.Id == sameStory.Id && item.Fingerprint != sameStory.Fingerprint,
            "Feed updates should overwrite by canonical URL without ignoring changed fields.");
        var retained = CortexNewsIndexWorker.SelectRetainedIds(
            [new(item.Id, now.AddDays(-10), "old"), new("expired", now.AddDays(-31), "old"), new("older", now.AddDays(-1), "old")],
            [item], now.AddDays(-30), 1);
        Require(retained.SetEquals([item.Id]), "Retention should keep the newest unique item within the configured cap.");
        await index.UpsertAsync([(item, new float[CortexNewsEmbeddings.Dimensions])], default);
        using (var body = JsonDocument.Parse(transport.Body!))
        {
            var document = body.RootElement.GetProperty("value")[0];
            Require(document.GetProperty("@search.action").GetString() == "upload"
                && document.GetProperty("embedding").GetArrayLength() == CortexNewsEmbeddings.Dimensions,
                "A complete document should be uploaded with its vector.");
        }
        transport.WriteSucceeded = false;
        try
        {
            await index.DeleteAsync([item.Id], default);
            throw new Exception("Partial index failures should be retried by the worker.");
        }
        catch (InvalidOperationException) { }

        if (modelRoot is not null)
        {
            using var model = new CortexNewsEmbeddings(new TestEnvironment { ContentRootPath = modelRoot });
            var question = await model.EmbedAsync("query: Why are shipping costs rising?", default);
            var related = await model.EmbedAsync("passage: Red Sea rerouting raises freight and insurance premiums.", default);
            var unrelated = await model.EmbedAsync("passage: The All Blacks named the team for Saturday's rugby match.", default);
            Require(question.Length == CortexNewsEmbeddings.Dimensions && Math.Abs(Dot(question, question) - 1) < 0.001f,
                "The real ONNX model should return a normalized vector.");
            Require(Dot(question, related) > Dot(question, unrelated), "The real model should rank related news higher.");
            Console.WriteLine("Cortex ONNX model verified on CPU with a semantic relevance example.");
        }

        Console.WriteLine("Cortex Azure Search checks passed for hybrid requests, key scope, retention, indexing and fallback.");
    }

    private static float Dot(float[] left, float[] right) => left.Zip(right, (a, b) => a * b).Sum();

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private sealed class TestEmbeddings : ICortexNewsEmbeddings
    {
        public ValueTask<float[]> EmbedAsync(string text, CancellationToken cancellationToken)
        {
            Require(text.StartsWith("query: "), "Cortex queries should use E5's query prefix.");
            return ValueTask.FromResult(new float[CortexNewsEmbeddings.Dimensions]);
        }
    }

    private sealed class ClientFactory(HttpMessageHandler transport) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(transport, disposeHandler: false);
    }

    private sealed class SearchTransport : HttpMessageHandler
    {
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public string? Key { get; private set; }
        public string? Body { get; private set; }
        public int RequestCount { get; private set; }
        public bool IndexCreated { get; private set; }
        public bool WriteSucceeded { get; set; } = true;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestCount++;
            Key = request.Headers.GetValues("api-key").Single();
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Get)
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            if (path == "/indexes")
            {
                IndexCreated = Body!.Contains("exhaustiveKnn");
                return new HttpResponseMessage(HttpStatusCode.Created);
            }
            if (path.EndsWith("/docs/index", StringComparison.Ordinal))
                return Reply(WriteSucceeded ? HttpStatusCode.OK : HttpStatusCode.MultiStatus,
                    WriteSucceeded ? """{"value":[{"status":true}]}""" : """{"value":[{"status":false}]}""");
            return Reply(Status, """
                {"value":[
                {"id":"1","title":"Chip supply","publisher":"RNZ","publishedAt":"2026-11-22T00:00:00Z","excerpt":"New capacity","url":"https://example.com/news"},
                {"id":"2","title":"Unsafe link","publisher":"RNZ","publishedAt":"2026-11-22T00:00:00Z","excerpt":"New capacity","url":"javascript:alert(1)"}
                ]}
                """);
        }

        private static HttpResponseMessage Reply(HttpStatusCode status, string content) =>
            new(status) { Content = new StringContent(content, Encoding.UTF8, "application/json") };
    }

    private sealed class TestEnvironment : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "Signal.Tests";
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = "";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    }
}
