using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
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


        await search.FindCoverageAsync("Chip supply", "New capacity", DateTimeOffset.UtcNow, default);
        using (var coverageBody = JsonDocument.Parse(transport.Body!))
        {
            var root = coverageBody.RootElement;
            Require(root.GetProperty("search").GetString() == "Chip supply", "Coverage keeps the headline as its keyword query.");
            Require(root.GetProperty("top").GetInt32() == 15, "Coverage should fetch extra candidates before excluding publishers.");
            Require(root.GetProperty("filter").GetString()!.Contains("and publishedAt le "), "Coverage should have an upper publication bound.");
        }
        var reader = new ArticleReaderController(null!, NullLogger<ArticleReaderController>.Instance, cortexNews: search);
        var coverage = (OkObjectResult)await reader.FindMoreCoverage(
            new("https://example.com/news?utm_source=copy", "Chip supply", null, DateTimeOffset.UtcNow), default);
        var coverageResult = JsonSerializer.SerializeToElement(coverage.Value);
        Require(coverageResult.GetProperty("articles").GetArrayLength() == 0,
            "Coverage should exclude the anchor URL and unsafe results.");
        Require(await reader.FindMoreCoverage(new("javascript:alert(1)", "Chip supply", null, null), default)
            is BadRequestObjectResult, "Coverage should reject unsafe article seeds.");

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


        var day = now.UtcDateTime;
        (string Title, string Url, DateTime PublishedAt, string Summary, string? ThreadId)[] leads =
        [
            ("Reserve Bank cuts OCR to 4.25% after Wellington policy meeting", "https://example.com/lead", day, "Reserve Bank Governor Adrian Orr warned mortgage borrowers about wholesale costs.", null),
            ("Wellington policy meeting: RBNZ lowers official cash rate to 4.25%", "https://example.com/copy", day, "Central bank officials lowered rates on Wednesday.", null),
            ("Mortgage borrowers face longer wait for relief", "https://example.com/summary-followup", day.AddHours(6), "Reserve Bank Governor Adrian Orr signaled wholesale costs remain high for mortgage borrowers.", null),
            ("Brussels prepares countermeasures on US vehicles", "https://example.com/semantic-a", day, "Trade ministers met to plan retaliatory tariffs.", "t:auto"),
            ("White House announces sweeping auto import levies", "https://example.com/semantic-b", day.AddHours(4), "New 25% duties hit European automakers.", "t:auto"),
            ("台積電擴建美國晶片廠進度曝光", "https://example.com/zh-a", day, "", null),
            ("美晶片廠關稅影響 台積電最新回應", "https://example.com/zh-b", day, "", null),
            ("台北捷運新線週末通車測試", "https://example.com/zh-c", day, "", null),
            ("Reserve Bank signals caution on inflation at later review", "https://example.com/later", day.AddDays(4), "Fresh quarterly outlook from Wellington.", null),
        ];
        var distinct = NarratedNews.DistinctStories(
            leads,
            story => story.Title,
            story => story.Url,
            story => story.PublishedAt,
            story => story.Summary,
            story => story.ThreadId);
        Require(distinct.Select(story => story.Url).SequenceEqual(new[]
            {
                leads[0].Url,
                leads[3].Url,
                leads[5].Url,
                leads[7].Url,
                leads[8].Url,
            }),
            "Scheduled audio should filter broader ongoing threads across lexical, summary, CJK and semantic thread signals.");

        await RunAudioThreadServiceChecksAsync(day);
        await RunReadBatchChecksAsync(day);

        if (modelRoot is not null)
        {
            using var model = new CortexNewsEmbeddings(new TestEnvironment { ContentRootPath = modelRoot });
            var question = await model.EmbedAsync("query: Why are shipping costs rising?", default);
            var related = await model.EmbedAsync("passage: Red Sea rerouting raises freight and insurance premiums.", default);
            var unrelated = await model.EmbedAsync("passage: The All Blacks named the team for Saturday's rugby match.", default);
            Require(question.Length == CortexNewsEmbeddings.Dimensions && Math.Abs(Dot(question, question) - 1) < 0.001f,
                "The real ONNX model should return a normalized vector.");
            Require(Dot(question, related) > Dot(question, unrelated), "The real model should rank related news higher.");
            await RunRealModelThreadCalibrationAsync(model, day);
            Console.WriteLine("Cortex ONNX model verified on CPU with a semantic relevance example.");
        }

        Console.WriteLine("Cortex Azure Search checks passed for hybrid requests, key scope, retention, indexing and fallback.");
    }

    private static async Task RunAudioThreadServiceChecksAsync(DateTime day)
    {
        var mockEmbeddings = new ThreadTestEmbeddings();
        var service = new AudioTopicThreadService(mockEmbeddings, NullLogger<AudioTopicThreadService>.Instance);

        var items = new (string Url, string Title, string Summary, DateTime Date)[]
        {
            ("https://example.com/tariffs-1", "White House announces sweeping tariffs on European cars", "25% duties hit EU automakers.", day),
            ("https://example.com/tariffs-2", "Brussels prepares retaliatory levies after US auto duties", "Trade ministers met to draft countermeasures.", day.AddHours(5)),
            ("https://example.com/bridge-only", "EU ministers debate broader trade pact beyond autos", "Follow-up discussions on industrial subsidies.", day.AddHours(8)),
            ("https://example.com/rugby", "All Blacks announce squad for weekend test match", "Three uncapped players named.", day.AddHours(2)),
            ("https://example.com/zh", "台積電擴建美國晶片廠進度曝光", "相關供應鏈持續推進。", day.AddHours(1)),
            ("https://example.com/tariffs-old", "White House announces sweeping tariffs on European cars", "25% duties hit EU automakers.", day.AddDays(4)),
        };

        var threads = await service.AssignThreadIdsAsync(
            items,
            item => item.Url,
            item => item.Title,
            item => item.Summary,
            item => item.Date,
            TimeSpan.FromSeconds(5),
            default);

        Require(threads.ContainsKey(items[0].Url) && threads.TryGetValue(items[1].Url, out var t1) && threads[items[0].Url] == t1,
            "Semantic matches within 60h should share an audio thread ID.");
        Require(!threads.ContainsKey(items[2].Url),
            "Anchor-only matching should prevent transitive chaining across distinct follow-up angles.");
        Require(!threads.ContainsKey(items[3].Url),
            "Unrelated stories should not be assigned to an audio thread.");
        Require(!threads.ContainsKey(items[4].Url),
            "Non-Latin headlines should skip the English embedding model.");
        Require(!threads.ContainsKey(items[5].Url),
            "Stories more than 60 hours apart should not join the same audio thread.");

        var cachedCallsBefore = mockEmbeddings.CallCount;
        var cachedThreads = await service.AssignThreadIdsAsync(
            items,
            item => item.Url,
            item => item.Title,
            item => item.Summary,
            item => item.Date,
            TimeSpan.FromSeconds(5),
            default);
        Require(mockEmbeddings.CallCount == cachedCallsBefore && cachedThreads.Count == threads.Count,
            "AudioTopicThreadService should reuse cached embeddings across calls.");

        var unavailable = new AudioTopicThreadService(
            new UnavailableEmbeddings(),
            NullLogger<AudioTopicThreadService>.Instance);
        var fallback = await unavailable.AssignThreadIdsAsync(
            items,
            item => item.Url,
            item => item.Title,
            item => item.Summary,
            item => item.Date,
            TimeSpan.FromSeconds(5),
            default);
        Require(fallback.Count == 0, "Missing ONNX model should fall back cleanly with empty thread IDs.");
    }

    private static async Task RunRealModelThreadCalibrationAsync(CortexNewsEmbeddings model, DateTime day)
    {
        var positives = new ((string Title, string Summary) Anchor, (string Title, string Summary) FollowUp, string Label)[]
        {
            (
                ("Trump unveils sweeping tariffs on European auto imports", "The White House announced 25% duties on EU vehicles starting next month."),
                ("Brussels prepares retaliatory levies after US car import duties", "European trade ministers met urgently to draft countermeasures on American goods."),
                "US/EU auto tariffs"
            ),
            (
                ("Auckland port workers strike blocks freight shipments", "Unionized dockworkers walked off the job at Waitemata terminals."),
                ("Exporters scramble to reroute cargo amid waterfront industrial dispute", "Shipping delays hit Auckland businesses as port picket enters second day."),
                "Auckland port strike"
            ),
            (
                ("Reserve Bank cuts OCR to 4.25% as inflation slows", "Monetary policy committee lowers the official cash rate by 50 basis points."),
                ("Major retail banks trim floating mortgage rates after central bank move", "Homeowners get immediate relief following Wednesday's rate decision."),
                "RBNZ OCR / mortgages"
            ),
        };

        var negatives = new ((string Title, string Summary) Left, (string Title, string Summary) Right, string Label)[]
        {
            (
                ("Reserve Bank cuts OCR to 4.25% as inflation slows", "Monetary policy committee lowers the official cash rate by 50 basis points."),
                ("ANZ reports higher annual profit despite commercial property provisioning", "Bank chief executive cited steady lending growth across business units."),
                "OCR vs ANZ earnings"
            ),
            (
                ("Apple unveils new MacBook Pro with M5 chip", "Faster unified memory and longer battery life arrive next week."),
                ("Microsoft expands Azure data centres in Auckland", "New cloud regions aim to serve public sector and enterprise workloads."),
                "Apple MacBook vs Microsoft Azure"
            ),
            (
                ("Auckland port workers strike blocks freight shipments", "Unionized dockworkers walked off the job at Waitemata terminals."),
                ("Auckland Council approves annual rates increase for transport", "Mayor says infrastructure budget prioritizes road maintenance and rail."),
                "Port strike vs Auckland Council rates"
            ),
        };

        var minPos = 1f;
        foreach (var (anchor, followUp, label) in positives)
        {
            var va = await model.EmbedAsync($"passage: {anchor.Title}. {anchor.Summary}", default);
            var vb = await model.EmbedAsync($"passage: {followUp.Title}. {followUp.Summary}", default);
            var sim = Dot(va, vb);
            if (sim < minPos) minPos = sim;
            Console.WriteLine($"[ONNX Thread +] {label}: {sim:F4}");
        }

        var maxNeg = -1f;
        foreach (var (left, right, label) in negatives)
        {
            var va = await model.EmbedAsync($"passage: {left.Title}. {left.Summary}", default);
            var vb = await model.EmbedAsync($"passage: {right.Title}. {right.Summary}", default);
            var sim = Dot(va, vb);
            if (sim > maxNeg) maxNeg = sim;
            Console.WriteLine($"[ONNX Thread -] {label}: {sim:F4}");
        }

        Require(minPos > maxNeg, $"Real ONNX model positive thread scores (min {minPos:F4}) must exceed unrelated pairs (max {maxNeg:F4}).");

        var threadService = new AudioTopicThreadService(model, NullLogger<AudioTopicThreadService>.Instance);
        var feed = new (string Url, string Title, string Summary, DateTime Date)[]
        {
            ("https://example.com/pos-1", positives[0].Anchor.Title, positives[0].Anchor.Summary, day),
            ("https://example.com/pos-2", positives[0].FollowUp.Title, positives[0].FollowUp.Summary, day.AddHours(3)),
            ("https://example.com/neg-1", negatives[1].Left.Title, negatives[1].Left.Summary, day.AddHours(1)),
            ("https://example.com/neg-2", negatives[1].Right.Title, negatives[1].Right.Summary, day.AddHours(2)),
        };
        var assigned = await threadService.AssignThreadIdsAsync(
            feed, x => x.Url, x => x.Title, x => x.Summary, x => x.Date, TimeSpan.FromSeconds(10), default);
        Require(assigned.ContainsKey(feed[0].Url) && assigned.TryGetValue(feed[1].Url, out var p2) && assigned[feed[0].Url] == p2,
            "Real ONNX AudioTopicThreadService should group paraphrased same-thread stories.");
        Require(!assigned.ContainsKey(feed[2].Url) && !assigned.ContainsKey(feed[3].Url),
            "Real ONNX AudioTopicThreadService should keep unrelated same-domain stories separate.");
    }

    private static async Task RunReadBatchChecksAsync(DateTime day)
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var dbOptions = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options;
        await using var db = new SignalDbContext(dbOptions);
        await db.Database.EnsureCreatedAsync();

        db.Users.Add(new ApplicationUser
        {
            Id = "batch-user",
            UserName = "batch@example.com",
            NormalizedUserName = "BATCH@EXAMPLE.COM",
            Email = "batch@example.com",
            NormalizedEmail = "BATCH@EXAMPLE.COM",
        });
        db.StoredNewsArticles.AddRange(
            new StoredNewsArticle
            {
                UserId = "batch-user",
                Url = "https://example.com/thread-a",
                Title = "Auckland port workers strike blocks freight shipments",
                Source = "RNZ",
                PublishedAtUtc = day,
                FirstSeenAtUtc = day,
                LastSeenAtUtc = day,
            },
            new StoredNewsArticle
            {
                UserId = "batch-user",
                Url = "https://example.com/thread-b",
                Title = "Auckland port strike freight rerouting affects exporters",
                Source = "Stuff",
                PublishedAtUtc = day.AddHours(2),
                FirstSeenAtUtc = day.AddHours(2),
                LastSeenAtUtc = day.AddHours(2),
            },
            new StoredNewsArticle
            {
                UserId = "batch-user",
                Url = "https://example.com/unrelated",
                Title = "Wellington approves new airport terminal",
                Source = "RNZ",
                PublishedAtUtc = day,
                FirstSeenAtUtc = day,
                LastSeenAtUtc = day,
            });
        await db.SaveChangesAsync();

        var services = new ServiceCollection().AddLogging().AddSingleton(db);
        services.AddIdentityCore<ApplicationUser>().AddEntityFrameworkStores<SignalDbContext>();
        using var provider = services.BuildServiceProvider();
        var controller = new ArticlesController(db, provider.GetRequiredService<UserManager<ApplicationUser>>())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "batch-user")], "test")),
                },
            },
        };

        var response = (OkObjectResult)await controller.MarkReadBatch(
            new ReadBatchRequest(["https://example.com/thread-a", "https://example.com/thread-b"]),
            default);
        var payload = (ReadBatchResponse)response.Value!;
        Require(payload.MarkedUrls.Length == 2, "Batch read should mark every URL in the played thread.");
        var rows = await db.StoredNewsArticles.AsNoTracking().OrderBy(x => x.Url).ToListAsync();
        Require(rows.Single(x => x.Url == "https://example.com/thread-a").IsRead
            && rows.Single(x => x.Url == "https://example.com/thread-b").IsRead
            && !rows.Single(x => x.Url == "https://example.com/unrelated").IsRead,
            "Batch read should mark only the played thread stories read.");
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

    private sealed class UnavailableEmbeddings : ICortexNewsEmbeddings
    {
        public bool IsAvailable => false;
        public ValueTask<float[]> EmbedAsync(string text, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Model is unavailable.");
    }

    private sealed class ThreadTestEmbeddings : ICortexNewsEmbeddings
    {
        public int CallCount { get; private set; }

        public ValueTask<float[]> EmbedAsync(string text, CancellationToken cancellationToken)
        {
            CallCount++;
            var vector = new float[CortexNewsEmbeddings.Dimensions];
            if (text.Contains("tariffs", StringComparison.OrdinalIgnoreCase)
                || text.Contains("retaliatory levies", StringComparison.OrdinalIgnoreCase))
            {
                vector[0] = 0.99f;
                vector[1] = text.Contains("tariffs", StringComparison.OrdinalIgnoreCase) ? 0.14f : -0.14f;
            }
            else if (text.Contains("trade pact", StringComparison.OrdinalIgnoreCase))
            {
                vector[0] = 0.70f;
                vector[1] = 0.714f;
            }
            else
            {
                vector[2] = 1f;
            }
            var norm = MathF.Sqrt(vector.Sum(v => v * v));
            for (var i = 0; i < vector.Length; i++) vector[i] /= norm;
            return ValueTask.FromResult(vector);
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
