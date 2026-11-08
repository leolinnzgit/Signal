using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class ExecutiveSuiteIntegrationChecks
{
    public static async Task RunAsync()
    {
        await CheckTripwiresPersistenceCooldownAndIsolationAsync();
        await CheckLiveCortexDailyCastAndTelemetryAsync();
        await CheckDialogueAzureSpeechSynthesisAsync();
        Console.WriteLine("Executive Tripwires, user-scoped live Cortex, Daily Cast Live Wire, and multi-voice neural audio checks passed.");
    }

    private static async Task CheckTripwiresPersistenceCooldownAndIsolationAsync()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SignalDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var db = new SignalDbContext(options);
        await db.Database.EnsureCreatedAsync();

        db.Users.AddRange(
            new ApplicationUser
            {
                Id = "exec-a",
                UserName = "a@example.com",
                NormalizedUserName = "A@EXAMPLE.COM",
                Email = "a@example.com",
                NormalizedEmail = "A@EXAMPLE.COM",
            },
            new ApplicationUser
            {
                Id = "exec-b",
                UserName = "b@example.com",
                NormalizedUserName = "B@EXAMPLE.COM",
                Email = "b@example.com",
                NormalizedEmail = "B@EXAMPLE.COM",
            });

        db.StoredNewsArticles.AddRange(
            new StoredNewsArticle
            {
                UserId = "exec-a",
                Url = "https://example.com/a-red-sea",
                Title = "Red Sea container diversions spike bunker surcharge",
                Source = "Lloyd's List",
                PublishedAtUtc = DateTime.UtcNow,
                Summary = "Bab el-Mandeb transits rerouted via Cape of Good Hope.",
                TopicsJson = "[\"Shipping\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = DateTime.UtcNow,
                LastSeenAtUtc = DateTime.UtcNow,
            },
            new StoredNewsArticle
            {
                UserId = "exec-b",
                Url = "https://example.com/b-secret",
                Title = "Confidential acquisition in Argentina",
                Source = "Private Wire",
                PublishedAtUtc = DateTime.UtcNow,
                Summary = "Secret treasury cepo briefing for user B only.",
                TopicsJson = "[\"Macro\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = DateTime.UtcNow,
                LastSeenAtUtc = DateTime.UtcNow,
            });
        await db.SaveChangesAsync();

        // Word-boundary matching: "ai" matches "AI liability" but not "sail".
        var nonMatch = TripwireEvaluatorService.MatchArticleSet(
            "tw-word",
            "AI Rule",
            ["ai"],
            "High",
            "pre-mortem",
            "ai-cloud-migration",
            [new TripwireEvaluatorService.TripwireCandidateArticle("Sailing vessels detour cape", "https://example.com/1", "Wire")]);
        Assert(nonMatch is null, "Tripwire matcher must honor word boundaries and ignore substrings inside unrelated words.");

        var deepLink = TripwireEvaluatorService.BuildDeepLinkUrl("sovereign-risk", "egypt");
        Assert(deepLink == "/?suite=sovereign-risk&focus=egypt", $"Unexpected tripwire deep link: {deepLink}");

        var pushService = new PushNotificationService(
            db,
            new VapidKeyStore(new TempHostEnv(), NullLogger<VapidKeyStore>.Instance),
            NullLogger<PushNotificationService>.Instance);
        var evaluator = new TripwireEvaluatorService(db, pushService, NullLogger<TripwireEvaluatorService>.Instance);

        var controllerA = CreateControllerForUser("exec-a", db);
        var controllerB = CreateControllerForUser("exec-b", db);

        var upsertOk = await controllerA.Upsert(new TripwiresController.TripwireUpsertRequest(
            Id: null,
            Name: "Red Sea Watch",
            Keywords: ["red sea", "bab el-mandeb"],
            TargetSuiteId: "geopolitical-transit",
            TargetEntityId: "red-sea",
            Severity: "Critical",
            Enabled: true,
            PushOnMatch: true), CancellationToken.None) as OkObjectResult;
        var savedDto = upsertOk?.Value as TripwiresController.TripwireDto;
        Assert(savedDto is not null && savedDto.DeepLinkUrl == "/?suite=geopolitical-transit&focus=red-sea",
            "Tripwire upsert did not return saved DTO with deep link.");

        // User B must not see or delete User A's tripwire.
        var listB = (await controllerB.Get(CancellationToken.None) as OkObjectResult)?.Value as TripwiresController.TripwiresStateResponse;
        Assert(listB is { Authenticated: true } && listB.Tripwires.Length == 0,
            "Tripwires endpoint leaked another user's rule.");
        var deleteOther = await controllerB.Delete(savedDto!.Id, CancellationToken.None);
        Assert(deleteOther is NotFoundResult, "Cross-user delete must return NotFound.");

        // First evaluation triggers match, increments TriggerCount, and sets LastTriggeredAtUtc.
        var newStory = await db.StoredNewsArticles.FirstAsync(a => a.UserId == "exec-a");
        var firstHits = await evaluator.EvaluateAndNotifyAsync("exec-a", [newStory], CancellationToken.None);
        Assert(firstHits.Count == 1 && firstHits[0].TargetSuiteId == "geopolitical-transit",
            "Tripwire evaluator failed to match newly ingested story.");

        var savedEntity = await db.ExecutiveTripwires.AsNoTracking().SingleAsync(t => t.Id == savedDto.Id);
        var firstTriggeredAt = savedEntity.LastTriggeredAtUtc;
        Assert(savedEntity.TriggerCount == 1 && firstTriggeredAt.HasValue && savedEntity.LastMatchedTitle.Contains("Red Sea"),
            "Tripwire evaluator did not persist match metadata and trigger count.");

        // Immediate second hit within 4-hour cooldown increments TriggerCount but preserves LastTriggeredAtUtc (no push spam).
        var secondHits = await evaluator.EvaluateAndNotifyAsync("exec-a", [newStory], CancellationToken.None);
        Assert(secondHits.Count == 1, "Second matching batch should still return match telemetry.");
        var afterCooldownEntity = await db.ExecutiveTripwires.AsNoTracking().SingleAsync(t => t.Id == savedDto.Id);
        Assert(afterCooldownEntity.TriggerCount == 2 && afterCooldownEntity.LastTriggeredAtUtc == firstTriggeredAt,
            "Cooldown should suppress repeated push window updates within 4 hours.");
    }

    private static async Task CheckLiveCortexDailyCastAndTelemetryAsync()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SignalDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var db = new SignalDbContext(options);
        await db.Database.EnsureCreatedAsync();

        db.Users.AddRange(
            new ApplicationUser
            {
                Id = "user-one",
                UserName = "u1@example.com",
                NormalizedUserName = "U1@EXAMPLE.COM",
                Email = "u1@example.com",
                NormalizedEmail = "U1@EXAMPLE.COM",
            },
            new ApplicationUser
            {
                Id = "user-two",
                UserName = "u2@example.com",
                NormalizedUserName = "U2@EXAMPLE.COM",
                Email = "u2@example.com",
                NormalizedEmail = "U2@EXAMPLE.COM",
            });

        db.StoredNewsArticles.AddRange(
            new StoredNewsArticle
            {
                UserId = "user-one",
                Url = "https://example.com/u1-egypt",
                Title = "Egypt pound and Suez transit fees pressure sovereign yield",
                Source = "Reuters",
                PublishedAtUtc = DateTime.UtcNow,
                Summary = "AI cloud regulation and Egypt FX liquidity update.",
                TopicsJson = "[\"Macro\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = DateTime.UtcNow,
                LastSeenAtUtc = DateTime.UtcNow,
            },
            new StoredNewsArticle
            {
                UserId = "user-two",
                Url = "https://example.com/u2-isolated",
                Title = "UserTwoOnlyHeadline sovereign alert",
                Source = "Private",
                PublishedAtUtc = DateTime.UtcNow,
                Summary = "Should never appear for user-one.",
                TopicsJson = "[\"Secret\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = DateTime.UtcNow,
                LastSeenAtUtc = DateTime.UtcNow,
            });
        await db.SaveChangesAsync();

        // 1. Signal Cortex: user-one sees own stored story & 28-suite copy, never user-two's story.
        var cortex = new SignalCortexController(db, null, null, NullLogger<SignalCortexController>.Instance);
        cortex.ControllerContext = AuthContext("user-one");

        var emptyOk = await cortex.Search(new SignalCortexController.CortexSearchRequest("", []), CancellationToken.None) as OkObjectResult;
        var emptyPayload = emptyOk?.Value as SignalCortexController.CortexSearchResponse;
        Assert(emptyPayload is not null && emptyPayload.SynthesizedAnswer.Contains("28 intelligence suites"),
            "Empty Signal Cortex prompt must reference all 28 intelligence suites.");

        var queryOk = await cortex.Search(new SignalCortexController.CortexSearchRequest(
            "UserTwoOnlyHeadline Egypt",
            [new("Live Client TSMC Update", "Bloomberg", "https://example.com/client-tsmc", "Egypt FX update")]),
            CancellationToken.None) as OkObjectResult;
        var queryPayload = queryOk?.Value as SignalCortexController.CortexSearchResponse;
        Assert(queryPayload is not null
            && queryPayload.CrossDomainHits.Any(h => h.Title.Contains("Egypt pound", StringComparison.OrdinalIgnoreCase))
            && queryPayload.CrossDomainHits.All(h => !h.Title.Contains("UserTwoOnlyHeadline", StringComparison.Ordinal)),
            "Signal Cortex must merge user-scoped stored articles without leaking other users' articles.");

        // 2. Daily Cast Live Wire synthesis & audio status
        var dailyCast = new DailyCastController(null, db, null, NullLogger<DailyCastController>.Instance);
        dailyCast.ControllerContext = AuthContext("user-one");

        var castOk = await dailyCast.Synthesize(new DailyCastController.CastSynthesizeRequest(
            "live-wire",
            [new("NZ Reserve Bank holds OCR steady", "RNZ", "Domestic inflation cools modestly.")]),
            CancellationToken.None) as OkObjectResult;
        var castPayload = castOk?.Value as DailyCastController.DailyCastResponse;
        Assert(castPayload is { EpisodeId: "live-wire", LiveArticleCount: >= 2 }
            && castPayload.DialogTurns.Length >= 4
            && castPayload.DialogTurns[0].Text.Contains("NZ Reserve Bank holds OCR steady"),
            "Daily Cast Live Wire must synthesize dialogue grounded in live & user stored articles.");

        var statusOk = dailyCast.GetAudioStatus() as OkObjectResult;
        Assert(statusOk?.Value is not null, "Daily Cast audio-status endpoint must return 200 OK.");

        // 3. Sovereign Risk & Pre-Mortem live DB signal corroboration
        var sovereign = new SovereignRiskController(db, null, NullLogger<SovereignRiskController>.Instance);
        sovereign.ControllerContext = AuthContext("user-one");
        var sovOk = await sovereign.Assess(new SovereignRiskController.SovereignAssessRequest("egypt", 10_000_000), CancellationToken.None) as OkObjectResult;
        var sovPayload = sovOk?.Value as SovereignRiskController.SovereignAssessResponse;
        Assert(sovPayload?.CorrelatedSignals is { Length: >= 1 } && sovPayload.DataSource.Contains("Live News Stream"),
            "Sovereign Risk must surface user-scoped live news corroboration.");

        var preMortem = new PreMortemController(db, NullLogger<PreMortemController>.Instance);
        preMortem.ControllerContext = AuthContext("user-one");
        var pmOk = await preMortem.Simulate(new PreMortemController.PreMortemSimulateRequest("ai-cloud-migration", null, 18), CancellationToken.None) as OkObjectResult;
        var pmPayload = pmOk?.Value as PreMortemController.PreMortemDossier;
        Assert(pmPayload?.LiveRiskSignals is { Length: >= 1 },
            "Pre-Mortem simulator must surface matching live DB EWI headlines.");
    }

    private static async Task CheckDialogueAzureSpeechSynthesisAsync()
    {
        var dir = Path.Combine(Path.GetTempPath(), "SignalDailyCastAudioTest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var settings = new AzureSpeechOptions
            {
                Provider = "Azure",
                Key = "test-key-that-is-not-a-real-credential",
                Region = "australiaeast",
                EnglishVoice = "en-NZ-MollyNeural"
            };
            using var http = new HttpClient(new FakeVoiceListHandler());
            var synth = new FakeDialogueSynthesizer();
            var renderer = new AzureSpeechAudioRenderer(Options.Create(settings), http, synth, dir);

            var audio = await renderer.GenerateDialogueAsync(
                [
                    ("david", "Good morning Sarah, treasury yields are moving."),
                    ("sarah", "Thanks David, watch sovereign credit spreads today."),
                ],
                350,
                CancellationToken.None);

            Assert(audio.Starts.Length == 2 && audio.Starts[0] == 0 && audio.Starts[1] > audio.Starts[0],
                "Dialogue synthesis did not compute sequential turn start offsets.");
            Assert(audio.Wave.Length > 44 && Encoding.ASCII.GetString(audio.Wave, 0, 4) == "RIFF",
                "Dialogue synthesis did not emit a valid RIFF WAV payload.");
            Assert(synth.Voices.Count == 2 && synth.Voices[0] == "en-US-AndrewNeural" && synth.Voices[1] == "en-NZ-MollyNeural",
                $"Dialogue synthesis expected dual host voices (Andrew + Molly), got: {string.Join(", ", synth.Voices)}");

            // Second call with same script must hit the clip cache with zero cloud synthesis calls.
            await renderer.GenerateDialogueAsync(
                [
                    ("david", "Good morning Sarah, treasury yields are moving."),
                    ("sarah", "Thanks David, watch sovereign credit spreads today."),
                ],
                500,
                CancellationToken.None);
            Assert(synth.Calls == 1, "Repeated Daily Cast dialogue did not reuse cached neural audio clips.");
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                foreach (var file in Directory.GetFiles(dir)) File.Delete(file);
                Directory.Delete(dir);
            }
        }
    }

    private static TripwiresController CreateControllerForUser(string userId, SignalDbContext db) =>
        new(db, NullLogger<TripwiresController>.Instance) { ControllerContext = AuthContext(userId) };

    private static ControllerContext AuthContext(string userId) => new()
    {
        HttpContext = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, userId)], "Test"))
        }
    };

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class TempHostEnv : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = "Signal.Tests";
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class FakeVoiceListHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var data = new[]
            {
                new { ShortName = "en-NZ-MollyNeural", Locale = "en-NZ", DisplayName = "Molly", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "en-US-AndrewNeural", Locale = "en-US", DisplayName = "Andrew", Gender = "Male", VoiceType = "Neural", Status = "GA" },
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(data), Encoding.UTF8, "application/json")
            });
        }
    }

    private sealed class FakeDialogueSynthesizer : IAzureSpeechSynthesizer
    {
        public int Calls;
        public readonly List<string> Voices = [];

        public Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken token)
        {
            Calls++;
            XNamespace ns = "http://www.w3.org/2001/10/synthesis";
            var voices = XDocument.Parse(ssml).Root!.Elements(ns + "voice").ToArray();
            var marks = new Dictionary<string, ulong>();
            using var pcm = new MemoryStream();
            foreach (var voice in voices)
            {
                var voiceName = voice.Attribute("name")!.Value;
                Voices.Add(voiceName);
                var text = string.Concat(voice.Nodes().OfType<XText>().Select(node => node.Value));
                marks[voice.Elements(ns + "bookmark").First().Attribute("mark")!.Value] =
                    (ulong)(pcm.Length / 32_000d * TimeSpan.TicksPerSecond);
                var fill = (byte)(SHA256.HashData(Encoding.UTF8.GetBytes(text + voiceName))[0] % 250 + 1);
                pcm.Write(Enumerable.Repeat(fill, 16_000).ToArray());
            }
            return Task.FromResult(new AzureSpeechBatch(pcm.ToArray(), marks));
        }
    }
}
