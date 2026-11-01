using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class DailyBriefingBackendChecks
{
    public static async Task RunAsync()
    {
        await RunMarketWatchlistChecksAsync();
        await RunMultilingualSpeechVoiceChecksAsync();
        await RunBriefingQaChecksAsync();
    }

    private static async Task RunMarketWatchlistChecksAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        using var http = new HttpClient(new FakeMarketWatchlistHandler())
        {
            BaseAddress = new Uri("https://api.twelvedata.com/")
        };

        // 1. Unconfigured returns Configured=false, Quotes=[]
        var unconfiguredService = new MarketDataService(http, cache, Options.Create(new MarketDataOptions()));
        var unconfiguredController = new MarketController(unconfiguredService, NullLogger<MarketController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
        var unconfiguredResult = await unconfiguredController.Watchlist(
            new MarketController.MarketWatchlistRequest([new("NVIDIA"), new("Apple")], 5),
            CancellationToken.None) as OkObjectResult;
        Assert(unconfiguredResult?.Value is MarketController.MarketWatchlistResponse { Configured: false, Quotes.Length: 0 },
            "Unconfigured watchlist should return 200 OK with Configured=false and empty quotes.");

        // 2. Configured resolves known tickers + overrides, skips plan-restricted NZX symbol, deduplicates, sorts by |PercentChange| desc
        var configuredService = new MarketDataService(
            http,
            cache,
            Options.Create(new MarketDataOptions { ApiKey = "fake-twelve-data-api-key" }));
        var configuredController = new MarketController(configuredService, NullLogger<MarketController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };

        var watchlistOk = await configuredController.Watchlist(
            new MarketController.MarketWatchlistRequest([
                new("Apple"),
                new("Air New Zealand"), // Plan-restricted NZX symbol -> skipped gracefully
                new("NVIDIA"),
                new("Custom Chip Topic", "AVGO"),
                new("S&P 500"),
                new("SP500"), // Duplicate SPY symbol -> deduplicated
            ], 5),
            CancellationToken.None) as OkObjectResult;

        var payload = watchlistOk?.Value as MarketController.MarketWatchlistResponse;
        Assert(payload is { Configured: true, Quotes.Length: 4 },
            $"Expected 4 deduplicated healthy watchlist quotes, got {payload?.Quotes.Length}.");
        Assert(payload!.Quotes[0].Symbol == "NVDA" && payload.Quotes[0].PercentChange == 4.25m,
            "Highest magnitude mover (NVDA +4.25%) must rank first.");
        Assert(payload.Quotes[1].Symbol == "AVGO" && payload.Quotes[1].PercentChange == -2.80m,
            "Second highest magnitude mover (AVGO -2.80%) must rank second.");
        Assert(payload.Quotes[2].Symbol == "SPY" && payload.Quotes[3].Symbol == "AAPL",
            "Remaining quotes must stay ordered by |PercentChange| descending.");
    }

    private static async Task RunMultilingualSpeechVoiceChecksAsync()
    {
        Assert(AzureSpeechAudioRenderer.ResolveMultilingualLanguage("en") is null
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("en-NZ") is null
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("ja") == "ja"
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("ja-JP") == "ja"
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("es-ES") == "es"
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("zh-Hans") == "zh-Hans"
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("zh-CN") == "zh-Hans"
            && AzureSpeechAudioRenderer.ResolveMultilingualLanguage("zh-Hant") == "zh-Hant",
            "Multilingual speech locale mapping did not resolve expected language codes.");

        var tempDir = Path.Combine(Path.GetTempPath(), "SignalMultiVoiceTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var settings = new AzureSpeechOptions
            {
                Provider = "Azure",
                Key = "test-key-that-is-not-a-real-credential",
                Region = "australiaeast"
            };
            using var client = new HttpClient(new MultilingualVoiceListHandler());
            var renderer = new AzureSpeechAudioRenderer(Options.Create(settings), client, new NoOpSynthesizer(), tempDir);

            var jaClips = await renderer.SelectVoiceClipsAsync(
                new HeadlineAudioRequest(["おはようございます。今日のエグゼクティブブリーフィングです。"], 3, Language: "ja"),
                ["おはようございます。今日のエグゼクティブブリーフィングです。"],
                CancellationToken.None);
            Assert(jaClips.Length == 1 && jaClips[0].Voice == "ja-JP-NanamiNeural",
                $"Expected ja-JP-NanamiNeural for Japanese briefing, got {jaClips.FirstOrDefault()?.Voice}.");

            var esClips = await renderer.SelectVoiceClipsAsync(
                new HeadlineAudioRequest(["Buenos días. Aquí está su resumen ejecutivo."], 3, Language: "es-ES"),
                ["Buenos días. Aquí está su resumen ejecutivo."],
                CancellationToken.None);
            Assert(esClips.Length == 1 && esClips[0].Voice == "es-ES-ElviraNeural",
                $"Expected es-ES-ElviraNeural for Spanish briefing, got {esClips.FirstOrDefault()?.Voice}.");

            var zhClips = await renderer.SelectVoiceClipsAsync(
                new HeadlineAudioRequest(["早上好，这是您的每日简报。"], 3, Language: "zh-Hans"),
                ["早上好，这是您的每日简报。"],
                CancellationToken.None);
            Assert(zhClips.Length == 1 && zhClips[0].Voice == "zh-CN-XiaoxiaoNeural",
                $"Expected zh-CN-XiaoxiaoNeural for Simplified Chinese briefing, got {zhClips.FirstOrDefault()?.Voice}.");
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                foreach (var file in Directory.GetFiles(tempDir)) File.Delete(file);
                Directory.Delete(tempDir);
            }
        }
    }

    private static async Task RunBriefingQaChecksAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        using var readerHttp = new HttpClient(new NotFoundHandler());
        var reader = new ArticleReaderService(readerHttp, cache, NullLogger<ArticleReaderService>.Instance);

        var summaryHandler = new QaSummaryHandler("fake-qa-language-key-1234567890");
        using var summaryHttp = new HttpClient(summaryHandler);
        var translatorHandler = new QaTranslatorHandler("fake-qa-translator-key-1234567890");
        using var translatorHttp = new HttpClient(translatorHandler);

        var disabledSummaries = new AzureLanguageSummaryService(
            Options.Create(new AzureLanguageOptions()),
            new NamedClientFactory(summaryHttp, translatorHttp),
            cache);
        var disabledTranslator = new AzureTranslatorService(
            Options.Create(new AzureTranslatorOptions()),
            new NamedClientFactory(summaryHttp, translatorHttp),
            cache);

        var extractiveController = new BriefingQaController(
            reader,
            disabledSummaries,
            disabledTranslator,
            NullLogger<BriefingQaController>.Instance);

        // 1. Blank question -> 400 BadRequest
        var badRes = await extractiveController.Ask(
            new BriefingQaController.BriefingQaRequest(" ", null, null, null, []),
            CancellationToken.None);
        Assert(badRes is BadRequestObjectResult, "Blank briefing Q&A question must return 400 BadRequest.");

        var sampleArticles = new BriefingQaController.BriefingQaArticleInput[]
        {
            new(
                "https://example.com/ai-chips",
                "NVIDIA unveils next-generation Blackwell Ultra rack servers",
                "Reuters",
                "Data center demand pushed chip shipments above quarterly expectations across hyperscale cloud providers.",
                ["NVIDIA", "AI"]),
            new(
                "https://example.com/rbnz-ocr",
                "Reserve Bank cuts Official Cash Rate by 50 basis points to 4.25%",
                "RNZ",
                "Retail banks trimmed floating mortgage rates within minutes of the Monetary Policy Committee announcement.",
                ["New Zealand economy", "Interest rates"]),
        };

        // 2. Extractive fallback matches OCR story + cites RNZ
        var ocrOk = await extractiveController.Ask(
            new BriefingQaController.BriefingQaRequest(
                "What happened with the Reserve Bank interest rates?",
                "19°C and Partly cloudy in Auckland",
                "NVDA is up 4.25% at 138.60 USD",
                "Steady coverage led by New Zealand economy",
                sampleArticles),
            CancellationToken.None) as OkObjectResult;
        var ocrPayload = ocrOk?.Value as BriefingQaController.BriefingQaResponse;
        Assert(ocrPayload is { Available: true, Mode: "extractive" }
            && ocrPayload.Citations.Length >= 1
            && ocrPayload.Citations[0].Source == "RNZ"
            && ocrPayload.Answer.Contains("Reserve Bank", StringComparison.OrdinalIgnoreCase),
            "Extractive briefing Q&A did not rank and cite the Reserve Bank story.");

        // 3. Weather question includes weather context
        var weatherOk = await extractiveController.Ask(
            new BriefingQaController.BriefingQaRequest(
                "What is the weather forecast today?",
                "19°C and Partly cloudy in Auckland with high UV",
                null,
                null,
                sampleArticles),
            CancellationToken.None) as OkObjectResult;
        var weatherPayload = weatherOk?.Value as BriefingQaController.BriefingQaResponse;
        Assert(weatherPayload is { Available: true }
            && weatherPayload.Answer.Contains("19°C", StringComparison.OrdinalIgnoreCase),
            "Weather briefing Q&A must include local weather context.");

        // 4. Enabled Azure Language + Azure Translator produces 3-sentence AI answer translated to Spanish
        var enabledSummaries = new AzureLanguageSummaryService(
            Options.Create(new AzureLanguageOptions
            {
                Endpoint = "https://signal-language.cognitiveservices.azure.com/",
                Key = "fake-qa-language-key-1234567890"
            }),
            new NamedClientFactory(summaryHttp, translatorHttp),
            cache);
        var enabledTranslator = new AzureTranslatorService(
            Options.Create(new AzureTranslatorOptions
            {
                Endpoint = "https://api.cognitive.microsofttranslator.com/",
                Key = "fake-qa-translator-key-1234567890",
                Region = "australiaeast"
            }),
            new NamedClientFactory(summaryHttp, translatorHttp),
            cache);
        var aiController = new BriefingQaController(
            reader,
            enabledSummaries,
            enabledTranslator,
            NullLogger<BriefingQaController>.Instance);

        var aiEsOk = await aiController.Ask(
            new BriefingQaController.BriefingQaRequest(
                "What is the latest on NVIDIA stocks and AI?",
                "19°C in Auckland",
                "NVDA is up 4.25% at 138.60 USD",
                "Focused momentum on AI",
                sampleArticles,
                "es-ES"),
            CancellationToken.None) as OkObjectResult;
        var aiEsPayload = aiEsOk?.Value as BriefingQaController.BriefingQaResponse;
        Assert(aiEsPayload is { Available: true, Mode: "azure-ai", Language: "es" }
            && aiEsPayload.Answer.StartsWith("[ES] ", StringComparison.Ordinal)
            && summaryHandler.LastSentenceCount == 3
            && translatorHandler.Calls == 1,
            "AI + Multilingual Briefing Q&A did not synthesize 3-sentence answer and translate to Spanish.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class NoOpSynthesizer : IAzureSpeechSynthesizer
    {
        public Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken token) =>
            Task.FromResult(new AzureSpeechBatch([], new Dictionary<string, ulong>()));
    }

    private sealed class NotFoundHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }

    private sealed class NamedClientFactory(HttpClient languageClient, HttpClient translatorClient) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            name == AzureTranslatorService.HttpClientName ? translatorClient : languageClient;
    }

    private sealed class FakeMarketWatchlistHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var query = request.RequestUri?.PathAndQuery ?? "";
            string json;
            if (query.Contains("symbol=AIR", StringComparison.OrdinalIgnoreCase))
            {
                json = """{"status":"error","message":"AIR is available starting with the Pro or Venture plan."}""";
            }
            else if (query.Contains("symbol=NVDA", StringComparison.OrdinalIgnoreCase))
            {
                json = """{"symbol":"NVDA","name":"NVIDIA Corp","exchange":"NASDAQ","currency":"USD","close":"138.60","change":"5.65","percent_change":"4.25","datetime":"2026-11-01","is_market_open":true}""";
            }
            else if (query.Contains("symbol=AVGO", StringComparison.OrdinalIgnoreCase))
            {
                json = """{"symbol":"AVGO","name":"Broadcom Inc","exchange":"NASDAQ","currency":"USD","close":"172.10","change":"-4.95","percent_change":"-2.80","datetime":"2026-11-01","is_market_open":true}""";
            }
            else if (query.Contains("symbol=SPY", StringComparison.OrdinalIgnoreCase))
            {
                json = """{"symbol":"SPY","name":"SPDR S&P 500 ETF","exchange":"NYSE","currency":"USD","close":"582.40","change":"6.35","percent_change":"1.10","datetime":"2026-11-01","is_market_open":true}""";
            }
            else
            {
                json = """{"symbol":"AAPL","name":"Apple Inc","exchange":"NASDAQ","currency":"USD","close":"228.50","change":"0.91","percent_change":"0.40","datetime":"2026-11-01","is_market_open":true}""";
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json")
            });
        }
    }

    private sealed class MultilingualVoiceListHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const string voicesJson = """
                [
                  {"ShortName":"en-NZ-MollyNeural","DisplayName":"Molly","Locale":"en-NZ","Gender":"Female","VoiceType":"Neural","Status":"GA"},
                  {"ShortName":"zh-CN-XiaoxiaoNeural","DisplayName":"Xiaoxiao","Locale":"zh-CN","Gender":"Female","VoiceType":"Neural","Status":"GA"},
                  {"ShortName":"zh-TW-HsiaoChenNeural","DisplayName":"HsiaoChen","Locale":"zh-TW","Gender":"Female","VoiceType":"Neural","Status":"GA"},
                  {"ShortName":"ja-JP-NanamiNeural","DisplayName":"Nanami","Locale":"ja-JP","Gender":"Female","VoiceType":"Neural","Status":"GA"},
                  {"ShortName":"es-ES-ElviraNeural","DisplayName":"Elvira","Locale":"es-ES","Gender":"Female","VoiceType":"Neural","Status":"GA"}
                ]
                """;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(voicesJson, Encoding.UTF8, "application/json")
            });
        }
    }

    private sealed class QaSummaryHandler(string expectedKey) : HttpMessageHandler
    {
        public int LastSentenceCount { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert(request.Headers.GetValues("Ocp-Apim-Subscription-Key").Single() == expectedKey, "Missing Language key.");
            if (request.Method == HttpMethod.Post)
            {
                using var doc = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
                LastSentenceCount = doc.RootElement
                    .GetProperty("tasks")[0]
                    .GetProperty("parameters")
                    .GetProperty("sentenceCount")
                    .GetInt32();

                var accepted = new HttpResponseMessage(HttpStatusCode.Accepted);
                accepted.Headers.Add(
                    "operation-location",
                    "https://signal-language.cognitiveservices.azure.com/language/analyze-text/jobs/qa-1?api-version=2023-04-01");
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
                                  "text": "NVIDIA unveiled Blackwell Ultra rack servers amid surging cloud demand, while NVDA rose 4.25% to 138.60 USD."
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

    private sealed class QaTranslatorHandler(string expectedKey) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Assert(request.Headers.GetValues("Ocp-Apim-Subscription-Key").Single() == expectedKey, "Missing Translator key.");
            using var input = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            var items = input.RootElement.EnumerateArray()
                .Select(el => new
                {
                    translations = new[]
                    {
                        new { text = "[ES] " + el.GetProperty("text").GetString(), to = "es" }
                    }
                })
                .ToArray();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(items), Encoding.UTF8, "application/json")
            };
        }
    }
}
