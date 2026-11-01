using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class StoryClusterChecks
{
    public static async Task RunAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        using var readerHttp = new HttpClient(new FailingReaderHandler());
        var reader = new ArticleReaderService(readerHttp, cache, NullLogger<ArticleReaderService>.Instance);

        // 1. Disabled Azure Language state makes zero cloud calls and validates minimum cluster size
        var summaryHandler = new ClusterSummaryHandler("fake-cluster-language-key-12345");
        using var summaryHttp = new HttpClient(summaryHandler);
        var disabledSummaries = new AzureLanguageSummaryService(
            Options.Create(new AzureLanguageOptions()),
            new SingleClientFactory(summaryHttp),
            cache);
        var disabledController = new StoryClusterController(
            reader,
            disabledSummaries,
            NullLogger<StoryClusterController>.Instance);

        var singleResult = await disabledController.Synthesize(
            new StoryClusterController.ClusterSynthesisRequest([
                new("https://example.com/1", "Reserve Bank cuts cash rate", "RNZ", "OCR falls 50bps.")
            ]),
            CancellationToken.None);
        Assert(singleResult is BadRequestObjectResult, "Single-article synthesis request must return 400 BadRequest.");

        var dupUrlResult = await disabledController.Synthesize(
            new StoryClusterController.ClusterSynthesisRequest([
                new("https://example.com/same", "Headline A", "RNZ", "Summary A"),
                new("https://example.com/same", "Headline B", "Stuff", "Summary B"),
                new("http://localhost/internal", "Localhost", "Local", "Blocked")
            ]),
            CancellationToken.None);
        Assert(dupUrlResult is BadRequestObjectResult, "Duplicate or loopback URLs must not satisfy the 2-article threshold.");

        var disabledOk = await disabledController.Synthesize(
            new StoryClusterController.ClusterSynthesisRequest([
                new("https://example.com/rnz-ocr", "Reserve Bank cuts OCR to 4.25%", "RNZ", "The central bank delivered a 50 basis point reduction as inflation eased."),
                new("https://example.com/stuff-ocr", "RBNZ slashes official cash rate by 50bps", "Stuff", "Mortgage holders welcome lower borrowing rates following Wednesday's decision.")
            ]),
            CancellationToken.None) as OkObjectResult;
        Assert(disabledOk?.Value is StoryClusterController.ClusterSynthesisResponse { Available: false, SourceCount: 2 },
            "Disabled synthesis should return Available=false with distinct SourceCount=2.");
        Assert(summaryHandler.Posts == 0, "Disabled synthesis must not issue Azure HTTP calls.");

        // 3. Timeline extraction returns past, present, and forward milestones
        var timelineRes = disabledController.Timeline(new StoryClusterController.ClusterTimelineRequest(
            "Monetary Policy Easing",
            [
                new("https://example.com/rnz-ocr", "Reserve Bank cuts OCR to 4.25%", "RNZ", "The central bank delivered a 50 basis point reduction."),
                new("https://example.com/stuff-ocr", "Mortgage rates adjust", "Stuff", "Banks trim floating rates.")
            ])) as OkObjectResult;
        var timelineData = timelineRes?.Value as StoryClusterController.ClusterTimelineResponse;
        Assert(timelineData is { Available: true, Milestones.Length: >= 3 }, "Timeline extraction must produce at least 3 milestones.");
        Assert(timelineData!.Milestones[0].Phase == "Past Context", "First milestone must be Past Context.");
        Assert(timelineData.Milestones[1].Phase == "Today's Catalyst", "Second milestone must be Today's Catalyst.");

        // 2. Enabled Azure Language synthesizes multi-publisher dossiers with sentenceCount = 4
        var enabledOptions = new AzureLanguageOptions
        {
            Endpoint = "https://signal-language.cognitiveservices.azure.com/",
            Key = "fake-cluster-language-key-12345"
        };
        var enabledSummaries = new AzureLanguageSummaryService(
            Options.Create(enabledOptions),
            new SingleClientFactory(summaryHttp),
            cache);
        var enabledController = new StoryClusterController(
            reader,
            enabledSummaries,
            NullLogger<StoryClusterController>.Instance);

        var clusterInput = new StoryClusterController.ClusterSynthesisRequest([
            new(
                "https://93.184.216.34/rnz-ocr",
                "Reserve Bank cuts OCR by 50 basis points to 4.25%",
                "RNZ",
                "The Reserve Bank Monetary Policy Committee lowered the Official Cash Rate by 50 basis points on Wednesday, citing easing domestic inflation pressures and spare capacity in the economy."),
            new(
                "https://93.184.216.34/stuff-ocr",
                "OCR decision: Banks trim floating home loan rates immediately",
                "Stuff",
                "Major retail banks reduced floating mortgage rates within minutes of the Reserve Bank's 50 basis point cut to 4.25 percent, offering relief to borrowers."),
            new(
                "https://93.184.216.34/herald-ocr",
                "Economists warn labour market headwinds remain despite OCR cut",
                "NZ Herald",
                "While borrowers celebrated the Reserve Bank move to 4.25 percent, economists cautioned unemployment may continue rising into early next year.")
        ]);

        var synthOk = await enabledController.Synthesize(clusterInput, CancellationToken.None) as OkObjectResult;
        var synthPayload = synthOk?.Value as StoryClusterController.ClusterSynthesisResponse;
        Assert(synthPayload is { Available: true, SourceCount: 3 } && synthPayload.Paragraphs.Length == 1,
            "Enabled cluster synthesis did not return synthesized paragraphs and SourceCount=3.");
        Assert(summaryHandler.Posts == 1 && summaryHandler.LastSentenceCount == 4,
            "Cluster synthesis must request 4-sentence abstractive summarization.");
        Assert(summaryHandler.LastSubmittedText.Contains("[RNZ]")
            && summaryHandler.LastSubmittedText.Contains("[Stuff]")
            && summaryHandler.LastSubmittedText.Contains("[NZ Herald]"),
            "Cluster synthesis dossier must attribute each publisher.");

        // 3. Re-requesting identical cluster hits 24-hr cache with zero extra Azure jobs
        _ = await enabledController.Synthesize(clusterInput, CancellationToken.None);
        Assert(summaryHandler.Posts == 1, "Repeated cluster synthesis should be served from memory cache.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class SingleClientFactory(HttpClient client) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => client;
    }

    private sealed class FailingReaderHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }

    private sealed class ClusterSummaryHandler(string expectedKey) : HttpMessageHandler
    {
        public int Posts { get; private set; }
        public int LastSentenceCount { get; private set; }
        public string LastSubmittedText { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert(request.Headers.GetValues("Ocp-Apim-Subscription-Key").Single() == expectedKey, "Missing subscription key.");
            if (request.Method == HttpMethod.Post)
            {
                Posts++;
                using var doc = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
                LastSubmittedText = doc.RootElement
                    .GetProperty("analysisInput")
                    .GetProperty("documents")[0]
                    .GetProperty("text")
                    .GetString() ?? "";
                LastSentenceCount = doc.RootElement
                    .GetProperty("tasks")[0]
                    .GetProperty("parameters")
                    .GetProperty("sentenceCount")
                    .GetInt32();

                var accepted = new HttpResponseMessage(HttpStatusCode.Accepted);
                accepted.Headers.Add(
                    "operation-location",
                    "https://signal-language.cognitiveservices.azure.com/language/analyze-text/jobs/cluster-1?api-version=2023-04-01");
                return accepted;
            }

            const string succeededJson = """
                {
                  "status": "succeeded",
                  "tasks": {
                    "items": [
                      {
                        "status": "succeeded",
                        "results": {
                          "documents": [
                            {
                              "summaries": [
                                {
                                  "text": "The Reserve Bank cut the Official Cash Rate by 50 basis points to 4.25%. Retail banks immediately lowered floating mortgage rates, though economists noted unemployment pressures remain."
                                }
                              ]
                            }
                          ]
                        }
                      }
                    ]
                  }
                }
                """;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(succeededJson, Encoding.UTF8, "application/json")
            };
        }
    }
}
