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

        // 4. Dossier compilation produces structured binder with perspectives, risks, and milestones
        var dossierRes = disabledController.Dossier(new StoryClusterController.ClusterDossierRequest(
            "Monetary Policy Easing",
            [
                new("https://example.com/rnz-ocr", "Reserve Bank cuts OCR to 4.25%", "RNZ", "The central bank delivered a 50 basis point reduction."),
                new("https://example.com/stuff-ocr", "Mortgage rates adjust", "Stuff", "Banks trim floating rates.")
            ])) as OkObjectResult;
        var dossierData = dossierRes?.Value as StoryClusterController.ClusterDossierResponse;
        Assert(dossierData is { Available: true, Perspectives.Length: 2, Risks.Length: >= 3, Milestones.Length: >= 3 },
            "Dossier compilation must produce executive binder sections.");
        Assert(dossierData!.ExecutiveSummary.Contains("RNZ"), "Executive summary should cite contributing publishers.");
        Assert(dossierData.Perspectives[0].Publisher == "RNZ", "First perspective should be RNZ.");

        // 5. Dossier digest dispatch and watch glance verification
        var fakeEmailSender = new FakeDossierEmailSender();
        var digestController = new StoryClusterController(
            reader,
            disabledSummaries,
            NullLogger<StoryClusterController>.Instance,
            fakeEmailSender,
            null);

        var badDigest = await digestController.DispatchDigest(null, CancellationToken.None);
        Assert(badDigest is BadRequestObjectResult, "Null dossier digest request must return 400 BadRequest.");

        var digestRes = await digestController.DispatchDigest(new StoryClusterController.ClusterDossierDigestRequest(
            dossierData,
            "email",
            "executive@example.com",
            null), CancellationToken.None) as OkObjectResult;

        var digestPayload = digestRes?.Value as StoryClusterController.ClusterDossierDigestResponse;
        Assert(digestPayload is { Success: true, EmailSent: true }, "Dossier email digest dispatch should report success and EmailSent=true.");
        Assert(fakeEmailSender.SentEmails.Count == 1, "FakeEmailSender must receive exactly 1 email.");
        Assert(fakeEmailSender.SentEmails[0].Email == "executive@example.com", "Recipient email must match request.");
        Assert(fakeEmailSender.SentEmails[0].Digest.Topic == "Monetary Policy Easing", "Digest topic must match compiled dossier.");

        // 6. Watch glance controller verification
        var watchController = new WatchGlanceController(cache, null, NullLogger<WatchGlanceController>.Instance);
        var initialWatchDossier = (watchController.GetDossier() as OkObjectResult)?.Value as WatchGlanceController.WatchDossierGlanceResponse;
        Assert(initialWatchDossier is { Available: true }, "Initial watch dossier must return default glance snapshot.");

        var syncRes = (watchController.SyncDossier(new WatchGlanceController.WatchDossierSyncRequest(
            "Hydrogen Supergrid Expansion",
            "Consortium commits $1.2B to regional green hydrogen and pipeline infrastructure.",
            "Energy Ministry issues priority grid integration consents.",
            [new("Execution", "Elevated", "Electrolyzer delivery delays.")],
            2,
            ["RNZ", "Newsroom"])) as OkObjectResult)?.Value as WatchGlanceController.WatchDossierSyncResponse;

        Assert(syncRes is { Success: true, Topic: "Hydrogen Supergrid Expansion" }, "Watch sync must return success.");

        var syncedWatchDossier = (watchController.GetDossier() as OkObjectResult)?.Value as WatchGlanceController.WatchDossierGlanceResponse;
        Assert(syncedWatchDossier is { Available: true, Topic: "Hydrogen Supergrid Expansion" },
            "Subsequent watch dossier lookup must retrieve the newly synced dossier.");
        Assert(syncedWatchDossier!.Risks.Length == 1 && syncedWatchDossier.Risks[0].Category == "Execution",
            "Synced risks must be preserved for watch display.");

        var marketGlance = (await watchController.GetMarketGlance(CancellationToken.None) as OkObjectResult)?.Value as WatchGlanceController.WatchMarketGlanceResponse;
        Assert(marketGlance is { Configured: true, Assets.Length: >= 4 }, "Watch market glance must return benchmark assets.");
        Assert(marketGlance!.Assets.Any(a => a.Symbol == "NZ50"), "NZ50 must be included in watch market glance.");

        // 7. Red Team counter-perspective stress testing
        var badRedTeam = disabledController.RedTeam(new StoryClusterController.ClusterRedTeamRequest(""));
        Assert(badRedTeam is BadRequestObjectResult, "Empty Red Team request must return 400 BadRequest.");

        var redTeamRes = (disabledController.RedTeam(new StoryClusterController.ClusterRedTeamRequest(
            "Geothermal Energy Infrastructure",
            [new("https://example.com/geo", "Consortium announces $800M drilling expansion", "RNZ", "Planned development across Taupo zone.")],
            "Consortium assumes regulatory approvals and power purchasing agreements remain uninhibited."
        )) as OkObjectResult)?.Value as StoryClusterController.ClusterRedTeamResponse;

        Assert(redTeamRes is { Available: true, Topic: "Geothermal Energy Infrastructure" }, "Red team response must be available with matching topic.");
        Assert(redTeamRes!.BlindSpots.Length >= 3, "Red team critique must identify at least 3 blind spots.");
        Assert(redTeamRes.KeyInflectionTriggers.Length >= 2, "Red team critique must provide inflection triggers.");
        Assert(redTeamRes.ContrarianCounterThesis.Contains("structural capital constraints"), "Counter-thesis should critique capital and regulatory friction.");

        // 8. Executive Radar anomaly velocity scanning
        var radarController = new ExecutiveRadarController(cache, null, NullLogger<ExecutiveRadarController>.Instance);
        var radarScanRes = ((await radarController.Scan(new ExecutiveRadarController.RadarScanRequest(
            [
                new("RBNZ Emergency Cash Rate Announcement", "RNZ", "https://example.com/rbnz-1", DateTimeOffset.UtcNow.AddMinutes(-10)),
                new("RBNZ Emergency Cash Rate Announcement", "NZ Herald", "https://example.com/rbnz-2", DateTimeOffset.UtcNow.AddMinutes(-5)),
                new("Reserve Bank Delivers Unscheduled Cash Rate Cut", "Stuff", "https://example.com/rbnz-3", DateTimeOffset.UtcNow.AddMinutes(-2))
            ],
            [
                new("NZ50", "NZX 50 Index", 1.45m, 12600m),
                new("NZDUSD", "NZD / USD", -0.95m, 0.598m)
            ],
            45
        ))) as OkObjectResult)?.Value as ExecutiveRadarController.RadarScanResponse;

        Assert(radarScanRes is { Active: true, AnomalyCount: >= 2 }, "Radar scan must detect anomalies across velocity and market divergence.");
        Assert(radarScanRes!.Anomalies.Any(a => a.AnomalyType == "velocity_spike"), "Radar must detect multi-publisher velocity spike.");
        Assert(radarScanRes.Anomalies.Any(a => a.AnomalyType == "market_divergence"), "Radar must detect macro market divergence.");

        var latestRadar = ((await radarController.GetLatest()) as OkObjectResult)?.Value as ExecutiveRadarController.RadarScanResponse;
        Assert(latestRadar is { Active: true }, "Radar latest endpoint must retrieve cached scan response.");

        // 9. Meeting Prep flash briefing generation
        var meetingController = new MeetingPrepController(cache, NullLogger<MeetingPrepController>.Instance);
        var badMeeting = meetingController.Generate(new MeetingPrepController.MeetingPrepRequest(""));
        Assert(badMeeting is BadRequestObjectResult, "Empty meeting prep request must return 400 BadRequest.");

        var meetingRes = (meetingController.Generate(new MeetingPrepController.MeetingPrepRequest(
            "Fonterra Co-operative Group",
            [
                new("Fonterra raises farmgate milk price forecast on strong global demand", "RNZ News", "https://example.com/fonterra-1", DateTimeOffset.UtcNow, "Dairy giant increases payout forecast following record export volumes to Southeast Asia.")
            ],
            30
        )) as OkObjectResult)?.Value as MeetingPrepController.MeetingPrepResponse;

        Assert(meetingRes is { Available: true, Entity: "Fonterra Co-operative Group" }, "Meeting prep response must match requested entity.");
        Assert(meetingRes!.StrategicPoints.Length >= 1, "Meeting prep must compile strategic intelligence points.");
        Assert(meetingRes.LeadershipQuotes.Length >= 1, "Meeting prep must extract or synthesize leadership quotes.");
        Assert(meetingRes.TalkingPoints.Length == 3, "Meeting prep must provide 3 tactical talking points.");
        Assert(meetingRes.RapidFireAudioScript.Contains("Fonterra"), "Rapid-fire audio script must reference target entity.");

        // 10. Scenario Simulator multi-order stress testing
        var scenarioController = new ScenarioSimulatorController(cache, NullLogger<ScenarioSimulatorController>.Instance);
        var badScenario = scenarioController.Simulate(new ScenarioSimulatorController.ScenarioSimulationRequest(""));
        Assert(badScenario is BadRequestObjectResult, "Empty scenario prompt must return 400 BadRequest.");

        var scenarioRes = (scenarioController.Simulate(new ScenarioSimulatorController.ScenarioSimulationRequest(
            "RBNZ accelerates cash rate cuts by 50bps amid cooling service inflation",
            [new("NZ50", "NZX 50 Gross Index", 12450m, 1.2m)],
            "Financial Services"
        )) as OkObjectResult)?.Value as ScenarioSimulatorController.ScenarioSimulationResponse;

        Assert(scenarioRes is { Available: true }, "Scenario simulation must succeed.");
        Assert(scenarioRes!.Impacts.Length == 3, "Scenario simulation must project 1st, 2nd, and 3rd order impacts.");
        Assert(scenarioRes.Impacts[0].OrderLevel == 1 && scenarioRes.Impacts[1].OrderLevel == 2 && scenarioRes.Impacts[2].OrderLevel == 3,
            "Impacts must be strictly ordered by transmission cascade.");
        Assert(scenarioRes.MitigationPlan.Length == 3, "Mitigation plan must contain 3 executive actions.");
        Assert(scenarioRes.ResilienceScore is >= 25 and <= 95, "Resilience score must be within valid bounds.");

        // 11. Quote Extractor verbatim soundbite parsing
        var quoteController = new QuoteExtractorController(cache, NullLogger<QuoteExtractorController>.Instance);
        var quoteRes = (quoteController.Extract(new QuoteExtractorController.QuoteExtractionRequest([
            new(
                "Reserve Bank Governor Delivers Monetary Policy Speech",
                "RNZ News",
                "https://example.com/rbnz-speech",
                "Central bank maintains restrictive policy horizon.",
                ["In his address, Governor Adrian Orr stated: \"We will remain committed to bringing inflation sustainably within target.\""])
        ])) as OkObjectResult)?.Value as QuoteExtractorController.QuoteExtractionResponse;

        Assert(quoteRes is { Available: true, TotalExtracted: >= 1 }, "Quote extractor must parse quoted speech.");
        Assert(quoteRes!.Quotes.Any(q => q.QuoteText.Contains("committed to bringing inflation")), "Quote extractor must capture verbatim text.");
        Assert(quoteRes.Quotes.Any(q => q.Stance == "Assertive"), "Assertive stance should be identified.");

        // 12. Quiet Hours Smart Triage & VIP Crisis Threshold
        var quietController = new QuietHoursController(cache, NullLogger<QuietHoursController>.Instance);
        var quietConfig = (quietController.GetConfig() as OkObjectResult)?.Value as QuietHoursController.QuietHoursConfig;
        Assert(quietConfig is { Enabled: true, StartTime: "22:00", EndTime: "06:30" }, "Quiet hours default config must be enabled for night window.");

        // Standard article during quiet hours gets suppressed
        var overnightConfig = quietConfig! with { StartTime = "00:00", EndTime = "23:59" }; // Force active
        var suppressedRes = (quietController.Evaluate(new QuietHoursController.QuietHoursEvaluateRequest(
            "Routine quarterly trade balance report published",
            "Stats NZ",
            "Monthly merchandise trade deficit narrows slightly.",
            0.1m,
            "NZ50",
            overnightConfig
        )) as OkObjectResult)?.Value as QuietHoursController.QuietHoursEvaluateResponse;

        Assert(suppressedRes is { IsQuietHoursActive: true, TriageAction: "suppress_to_morning_briefing", BreakthroughAllowed: false },
            "Non-urgent article must be suppressed to morning briefing during quiet hours.");

        // Crisis market shock breaks through
        var shockRes = (quietController.Evaluate(new QuietHoursController.QuietHoursEvaluateRequest(
            "Global equity shock triggers currency selloff",
            "Bloomberg",
            "Emergency liquidity measures activated.",
            -3.4m,
            "NZ50",
            overnightConfig
        )) as OkObjectResult)?.Value as QuietHoursController.QuietHoursEvaluateResponse;

        Assert(shockRes is { IsQuietHoursActive: true, TriageAction: "break_through_crisis_alert", BreakthroughAllowed: true, CrisisSeverity: "Crisis" },
            "Market shock exceeding threshold must break through quiet hours.");

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

    private sealed class FakeDossierEmailSender : IAccountEmailSender
    {
        public List<(string Email, ExecutiveDossierEmailDigest Digest)> SentEmails { get; } = [];

        public Task SendConfirmationAsync(string email, string confirmationUrl, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendPasswordResetAsync(string email, string resetUrl, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendNewsSummaryAsync(string email, NewsSummaryDigest digest, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendSharedArticleAsync(string email, SharedArticleEmail sharedArticle, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendExecutiveBriefingEmailAsync(string email, ExecutiveBriefingEmailDigest digest, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task SendExecutiveDossierEmailAsync(string email, ExecutiveDossierEmailDigest digest, CancellationToken cancellationToken)
        {
            SentEmails.Add((email, digest));
            return Task.CompletedTask;
        }
    }
}
