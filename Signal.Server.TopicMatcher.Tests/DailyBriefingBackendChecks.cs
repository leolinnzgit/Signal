using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class DailyBriefingBackendChecks
{
    public static async Task RunAsync()
    {
        await RunMarketWatchlistChecksAsync();
        await RunMarketSparklineChecksAsync();
        await RunMarketPortfolioAndAlertChecksAsync();
        await RunMultilingualSpeechVoiceChecksAsync();
        await RunBriefingQaChecksAsync();
        await RunExecutiveBriefingDeliveryChecksAsync();
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

    private static async Task RunMarketSparklineChecksAsync()
    {
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var handler = new FakeMarketWatchlistHandler();
        using var http = new HttpClient(handler)
        {
            BaseAddress = new Uri("https://api.twelvedata.com/")
        };

        var service = new MarketDataService(
            http,
            cache,
            Options.Create(new MarketDataOptions { ApiKey = "fake-twelve-data-api-key" }));

        // 1. Default GetForTopicAsync does NOT fetch time_series unless includeSparkline: true
        var withoutSparkline = await service.GetForTopicAsync("NVIDIA", null, CancellationToken.None);
        Assert(withoutSparkline is { Symbol: "NVDA", Sparkline: null } && handler.TimeSeriesCalls == 0,
            "Default GetForTopicAsync must not call time_series when includeSparkline is false.");

        // 2. Opt-in GetForTopicAsync(includeSparkline: true) reverses Twelve Data newest->oldest into oldest->newest
        var withSparkline = await service.GetForTopicAsync("NVIDIA", null, CancellationToken.None, includeSparkline: true);
        Assert(withSparkline is { Symbol: "NVDA", Sparkline.Length: 5 }
            && withSparkline.Sparkline[0] == 129.10m
            && withSparkline.Sparkline[4] == 138.60m
            && handler.TimeSeriesCalls == 1,
            "Opt-in GetForTopicAsync(includeSparkline: true) must reverse 14-day series oldest -> newest.");

        // 3. Watchlist with includeSparklines: true reuses cached NVDA sparkline and fetches up to 3 uncached symbols
        var watchlist = await service.GetWatchlistAsync(
            [new("NVIDIA"), new("Broadcom", "AVGO"), new("Apple")],
            maxQuotes: 5,
            CancellationToken.None,
            includeSparklines: true);
        Assert(watchlist.Length == 3
            && watchlist.All(item => item.Sparkline is { Length: >= 4 })
            && handler.TimeSeriesCalls == 3,
            $"Watchlist sparklines must reuse cached series (expected 3 total time_series calls, got {handler.TimeSeriesCalls}).");
    }

    private static async Task RunMarketPortfolioAndAlertChecksAsync()
    {
        // 1. Crypto ticker parsing
        Assert(MarketTickerParser.TryParse("BTC/USD", out var btc) && btc!.QualifiedSymbol == "BTC/USD",
            "MarketTickerParser must support crypto pairs like BTC/USD.");
        Assert(MarketTickerParser.TryParse("ETH/USD", out var eth) && eth!.QualifiedSymbol == "ETH/USD",
            "MarketTickerParser must support crypto pairs like ETH/USD.");
        Assert(MarketTickerParser.TryParse("SOL/USD", out var sol) && sol!.QualifiedSymbol == "SOL/USD",
            "MarketTickerParser must support crypto pairs like SOL/USD.");
        Assert(MarketTickerParser.TryParse("AAPL", out var aapl) && aapl!.QualifiedSymbol == "AAPL",
            "MarketTickerParser must continue supporting standard equities.");

        // 2. Normalization & bounds clamping
        var normalized = PreferencesController.NormalizeMarketPortfolio([
            new("BTC/USD", "Bitcoin Core", 3.5m, true),
            new("btc/usd", "Duplicate Bitcoin", 5.0m, false), // Deduplicated
            new("NVDA", "Nvidia Corporation", 75.0m, true), // Clamped to 50.0m
            new("INVALID $$$ TICKER", "Garbage", 2.0m, true), // Skipped
            new("AVGO", "", 0.05m, true), // Clamped to 0.1m, default display name to symbol
        ]);
        Assert(normalized.Length == 3, $"Expected 3 normalized portfolio items, got {normalized.Length}.");
        Assert(normalized[0].Symbol == "BTC/USD" && normalized[0].DisplayName == "Bitcoin Core" && normalized[0].AlertThresholdPercent == 3.5m,
            "Normalized BTC/USD did not retain custom threshold and display name.");
        Assert(normalized[1].Symbol == "NVDA" && normalized[1].AlertThresholdPercent == 50.0m,
            "Threshold > 50% must be clamped to 50.0m.");
        Assert(normalized[2].Symbol == "AVGO" && normalized[2].DisplayName == "AVGO" && normalized[2].AlertThresholdPercent == 0.1m,
            "Threshold < 0.1% must be clamped to 0.1m and empty display name defaults to symbol.");

        // 3. Quotes matching and alert threshold triggers
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var handler = new FakeMarketWatchlistHandler();
        using var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.twelvedata.com/") };
        var service = new MarketDataService(http, cache, Options.Create(new MarketDataOptions { ApiKey = "fake-key" }));

        var quotes = await service.GetWatchlistAsync([
            new("Nvidia Corporation", "NVDA"),
            new("Broadcom", "AVGO"),
        ], 5, CancellationToken.None);

        var nvdaQuote = quotes.First(q => q.Symbol == "NVDA");
        var avgoQuote = quotes.First(q => q.Symbol == "AVGO");

        // NVDA has +4.25% in fake handler:
        // Alert threshold 2.0% -> triggered!
        var nvdaTriggered = Math.Abs(nvdaQuote.PercentChange) >= 2.0m;
        Assert(nvdaTriggered, "NVDA (+4.25%) should trigger alert with 2.0% threshold.");

        // AVGO has -2.80% in fake handler:
        // Alert threshold 5.0% -> NOT triggered.
        var avgoNotTriggered = Math.Abs(avgoQuote.PercentChange) >= 5.0m;
        Assert(!avgoNotTriggered, "AVGO (-2.80%) should not trigger alert with 5.0% threshold.");

        // AVGO with threshold 2.5% -> triggered down!
        var avgoTriggered = Math.Abs(avgoQuote.PercentChange) >= 2.5m;
        Assert(avgoTriggered, "AVGO (-2.80%) should trigger alert with 2.5% threshold.");

        await Task.CompletedTask;
    }

    private static async Task RunExecutiveBriefingDeliveryChecksAsync()
    {
        // 1. MergePatch & IsDueAt timezone schedule logic
        var fixedMorningUtc = new DateTimeOffset(2026, 11, 2, 18, 15, 0, TimeSpan.Zero); // 07:15 NZDT (+13:00 on 2026-11-03)
        var (_, resolvedUtcId) = ExecutiveBriefingDeliveryService.ResolveTimeZone("UTC");
        Assert(resolvedUtcId == "UTC", "UTC timezone must resolve cleanly.");

        var utcMorning = new DateTimeOffset(2026, 11, 2, 7, 15, 0, TimeSpan.Zero);
        var enabledAfterTime = ExecutiveBriefingDeliveryService.MergePatch(
            ExecutiveBriefingPreferencesDto.Default,
            new ExecutiveBriefingPreferencesPatch(
                PriorityTopics: ["AI", "NVIDIA"],
                Language: "es-ES",
                ScheduleEnabled: true,
                ScheduleTime: "07:00",
                TimeZone: "UTC",
                NotifyPush: true,
                DeliverEmail: true),
            weatherTimeZone: null,
            requestOrigin: "https://signal.example.test",
            utcNow: utcMorning);
        Assert(enabledAfterTime.LastServerDeliveredDate == "2026-11-02"
            && enabledAfterTime.Language == "es"
            && !ExecutiveBriefingDeliveryService.IsDueAt(enabledAfterTime, utcMorning),
            "Enabling schedule after today's scheduled minute must mark today delivered so it waits until tomorrow.");

        // Moving schedule forward to 07:30 later today clears today's lock so it fires at 07:30!
        var movedLaterToday = ExecutiveBriefingDeliveryService.MergePatch(
            enabledAfterTime,
            new ExecutiveBriefingPreferencesPatch(ScheduleTime: "07:30"),
            weatherTimeZone: null,
            requestOrigin: "https://signal.example.test",
            utcNow: utcMorning);
        Assert(movedLaterToday.LastServerDeliveredDate == ""
            && !ExecutiveBriefingDeliveryService.IsDueAt(movedLaterToday, utcMorning)
            && ExecutiveBriefingDeliveryService.IsDueAt(movedLaterToday, new DateTimeOffset(2026, 11, 2, 7, 31, 0, TimeSpan.Zero)),
            "Moving schedule to an upcoming time today must allow firing once that time arrives.");

        // 2. End-to-end DeliverAsync & ProcessDueScheduledBriefingsAsync with SQLite, Push, Email, Translator & Hosted Share
        var tempRoot = Path.Combine(Path.GetTempPath(), "SignalBriefingDeliveryTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempRoot);
        try
        {
            await using var connection = new SqliteConnection("Data Source=:memory:");
            await connection.OpenAsync();
            await using var database = new SignalDbContext(
                new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options);
            await database.Database.EnsureCreatedAsync();

            var user = new ApplicationUser
            {
                Id = "exec-user-1",
                UserName = "exec@example.com",
                Email = "exec@example.com",
                EmailConfirmed = true
            };
            database.Users.Add(user);
            database.StoredNewsArticles.AddRange(
                new StoredNewsArticle
                {
                    UserId = user.Id,
                    Url = "https://example.com/nvda-earnings",
                    Title = "NVIDIA data center revenue surges 94% on Blackwell demand",
                    Source = "Reuters",
                    Summary = "Hyperscale AI clusters drove record quarterly shipments.",
                    TopicsJson = JsonSerializer.Serialize(new[] { "NVIDIA", "AI" }),
                    PublishedAtUtc = DateTime.UtcNow.AddHours(-2),
                    FirstSeenAtUtc = DateTime.UtcNow.AddHours(-2),
                    LastSeenAtUtc = DateTime.UtcNow
                },
                new StoredNewsArticle
                {
                    UserId = user.Id,
                    Url = "https://example.com/grid-storage",
                    Title = "Grid-scale battery installations double across Asia-Pacific",
                    Source = "Bloomberg",
                    Summary = "Falling cell costs accelerated utility storage deployments.",
                    TopicsJson = JsonSerializer.Serialize(new[] { "Clean energy" }),
                    PublishedAtUtc = DateTime.UtcNow.AddHours(-4),
                    FirstSeenAtUtc = DateTime.UtcNow.AddHours(-4),
                    LastSeenAtUtc = DateTime.UtcNow
                });

            var duePrefs = new ExecutiveBriefingPreferencesDto(
                PriorityTopics: ["NVIDIA"],
                Language: "es",
                ScheduleEnabled: true,
                ScheduleTime: "07:30",
                TimeZone: "UTC",
                NotifyPush: true,
                DeliverEmail: true,
                PrewarmOfflinePack: true,
                AutoContinueStories: true,
                LastServerDeliveredDate: "",
                PublicOrigin: "https://signal.example.test");

            database.UserNewsPreferences.Add(new UserNewsPreferences
            {
                UserId = user.Id,
                TopicsJson = JsonSerializer.Serialize(new[] { "NVIDIA", "Clean energy" }),
                BriefingPreferencesJson = JsonSerializer.Serialize(duePrefs),
                UpdatedAtUtc = DateTimeOffset.UtcNow
            });
            database.UserPushSubscriptions.Add(new UserPushSubscription
            {
                UserId = user.Id,
                Endpoint = "https://push.invalid/exec-phone",
                P256Dh = "key",
                Auth = "auth"
            });
            await database.SaveChangesAsync();

            var receipts = new NativeDeliveryReceipts();
            var nativeSender = new FakeBriefingNativeSender(receipts, user.Id, "exec-phone-1");
            var nativeNotifications = new NativeNotificationService(database, nativeSender, receipts);
            await nativeNotifications.RegisterAsync(
                user.Id,
                new NativeNotificationDevice
                {
                    Id = "exec-phone-1",
                    Kind = "phone",
                    Token = "fcm-exec-1",
                    BrowserEndpoint = "https://push.invalid/exec-phone"
                },
                CancellationToken.None);

            var vapidStore = new VapidKeyStore(new TempHostEnv(tempRoot), NullLogger<VapidKeyStore>.Instance);
            var pushService = new PushNotificationService(
                database,
                vapidStore,
                NullLogger<PushNotificationService>.Instance,
                nativeNotifications);

            var emailRecorder = new RecordingBriefingEmailSender();
            using var cache = new MemoryCache(new MemoryCacheOptions());
            using var marketHttp = new HttpClient(new FakeMarketWatchlistHandler())
            {
                BaseAddress = new Uri("https://api.twelvedata.com/")
            };
            var marketService = new MarketDataService(
                marketHttp,
                cache,
                Options.Create(new MarketDataOptions { ApiKey = "fake-twelve-data-api-key" }));

            var translatorHandler = new QaTranslatorHandler("fake-qa-translator-key-1234567890");
            using var translatorHttp = new HttpClient(translatorHandler);
            var translator = new AzureTranslatorService(
                Options.Create(new AzureTranslatorOptions
                {
                    Endpoint = "https://api.cognitive.microsofttranslator.com/",
                    Key = "fake-qa-translator-key-1234567890",
                    Region = "australiaeast"
                }),
                new NamedClientFactory(translatorHttp, translatorHttp),
                cache);

            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["PublicOrigin"] = "https://signal.example.test"
                })
                .Build();

            var deliveryService = new ExecutiveBriefingDeliveryService(
                database,
                pushService,
                emailRecorder,
                marketService,
                translator,
                config,
                NullLogger<ExecutiveBriefingDeliveryService>.Instance);

            var fireTimeUtc = new DateTimeOffset(2026, 11, 2, 7, 32, 0, TimeSpan.Zero);
            var deliveredCount = await deliveryService.ProcessDueScheduledBriefingsAsync(CancellationToken.None, fireTimeUtc);
            Assert(deliveredCount == 1, $"Expected 1 scheduled briefing delivery, got {deliveredCount}.");
            Assert(nativeSender.Sends == 1, $"Expected 1 native push send, got {nativeSender.Sends}.");
            Assert(emailRecorder.LastDigest is not null
                && emailRecorder.LastRecipient == "exec@example.com"
                && emailRecorder.LastDigest.LeadStories.Count == 2
                && emailRecorder.LastDigest.LeadStories[0].PriorityTopic == "NVIDIA"
                && emailRecorder.LastDigest.LeadStories[0].Title.StartsWith("[ES] ", StringComparison.Ordinal)
                && emailRecorder.LastDigest.HostedAudioShareUrl is not null
                && emailRecorder.LastDigest.HostedAudioShareUrl.StartsWith("https://signal.example.test/shared/", StringComparison.Ordinal),
                "Scheduled briefing email digest did not contain priority-ranked translated stories and hosted /shared/ listen link.");

            var sharedSnapshotCount = await database.SharedNewsArticles.CountAsync(item => item.UserId == user.Id);
            Assert(sharedSnapshotCount == 1, "Executive briefing delivery must create a hosted SharedNewsArticle audio snapshot.");

            // Duplicate tick on the same local day must be skipped!
            var duplicateCount = await deliveryService.ProcessDueScheduledBriefingsAsync(
                CancellationToken.None,
                fireTimeUtc.AddMinutes(5));
            Assert(duplicateCount == 0, "Second scheduler tick on the same local date must not re-deliver.");
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, recursive: true);
            }
        }
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
        public int TimeSeriesCalls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var query = request.RequestUri?.PathAndQuery ?? "";
            if (query.Contains("time_series?", StringComparison.OrdinalIgnoreCase))
            {
                TimeSeriesCalls++;
                const string seriesJson = """
                    {
                      "values": [
                        {"datetime":"2026-11-01","close":"138.60"},
                        {"datetime":"2026-10-31","close":"135.40"},
                        {"datetime":"2026-10-30","close":"133.20"},
                        {"datetime":"2026-10-29","close":"131.80"},
                        {"datetime":"2026-10-28","close":"129.10"}
                      ]
                    }
                    """;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(seriesJson, Encoding.UTF8, "application/json")
                });
            }

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

    private sealed class FakeBriefingNativeSender(NativeDeliveryReceipts receipts, string accountId, string deviceId) : INativePushSender
    {
        public bool Ready => true;
        public int Sends { get; private set; }

        public Task<NativePushResult> SendAsync(string token, IReadOnlyDictionary<string, string> data, CancellationToken ct)
        {
            Sends++;
            receipts.Receive(data["id"], accountId, deviceId, true);
            return Task.FromResult(NativePushResult.Delivered);
        }
    }

    private sealed class RecordingBriefingEmailSender : IAccountEmailSender
    {
        public string? LastRecipient { get; private set; }
        public ExecutiveBriefingEmailDigest? LastDigest { get; private set; }

        public Task SendConfirmationAsync(string toEmail, string confirmationLink, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendPasswordResetAsync(string toEmail, string resetLink, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendNewsSummaryAsync(string toEmail, NewsSummaryDigest digest, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task SendSharedArticleAsync(string toEmail, SharedArticleEmail article, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task SendExecutiveBriefingEmailAsync(
            string email,
            ExecutiveBriefingEmailDigest digest,
            CancellationToken cancellationToken)
        {
            LastRecipient = email;
            LastDigest = digest;
            return Task.CompletedTask;
        }
    }

    private sealed class TempHostEnv(string contentRoot) : IWebHostEnvironment
    {
        public string WebRootPath { get; set; } = contentRoot;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ApplicationName { get; set; } = "Signal.Server.Tests";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = contentRoot;
        public string EnvironmentName { get; set; } = "Development";
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
