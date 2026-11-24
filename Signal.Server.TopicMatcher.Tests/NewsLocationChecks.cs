using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

public static class NewsLocationChecks
{
    public static async Task RunAsync()
    {
        // 1. Heuristic extraction: city > country, datelines, CJK, publisher stripping, non-geo null, ambiguous words
        var auckland = NewsLocationService.ExtractHeuristicLocation(
            "Storm warning issued for Auckland across New Zealand",
            "Forecasters expect heavy rain.",
            "RNZ");
        if (auckland != "Auckland, New Zealand")
            throw new InvalidOperationException($"Expected 'Auckland, New Zealand', got '{auckland}'.");

        var wellingtonDateline = NewsLocationService.ExtractHeuristicLocation(
            "Parliament debates infrastructure bill",
            "WELLINGTON (Reuters) — Lawmakers gathered to discuss funding.",
            "Reuters");
        if (wellingtonDateline != "Wellington, New Zealand")
            throw new InvalidOperationException($"Expected dateline 'Wellington, New Zealand', got '{wellingtonDateline}'.");

        var chineseTokyo = NewsLocationService.ExtractHeuristicLocation(
            "东京芯片产业迎新投资",
            "日本多家企业宣布扩大产能。",
            "Signal");
        if (chineseTokyo != "Tokyo, Japan")
            throw new InvalidOperationException($"Expected 'Tokyo, Japan', got '{chineseTokyo}'.");

        var publisherOnly = NewsLocationService.ExtractHeuristicLocation(
            "Federal Reserve keeps benchmark interest rate unchanged - The New York Times",
            "Economists said the decision was widely expected.",
            "The New York Times");
        if (publisherOnly is not null)
            throw new InvalidOperationException($"Publisher attribution leaked location '{publisherOnly}'.");

        var nonGeo = NewsLocationService.ExtractHeuristicLocation(
            "How to write faster unit tests in TypeScript",
            "Tips for organizing test fixtures cleanly.",
            "Tech Blog");
        if (nonGeo is not null)
            throw new InvalidOperationException($"Non-geographic story returned '{nonGeo}'.");

        var ambiguousTurkey = NewsLocationService.ExtractHeuristicLocation(
            "Thanksgiving turkey prices rise across supermarkets",
            "Shoppers see higher grocery bills this season.",
            "Retail News");
        if (ambiguousTurkey is not null)
            throw new InvalidOperationException($"Ambiguous word 'turkey' falsely extracted '{ambiguousTurkey}'.");

        var actualTurkey = NewsLocationService.ExtractHeuristicLocation(
            "Ankara unveils new trade corridor rules",
            "Officials in Turkey announced port updates.",
            "World Wire");
        if (actualTurkey != "Ankara, Türkiye")
            throw new InvalidOperationException($"Expected 'Ankara, Türkiye', got '{actualTurkey}'.");

        // 2. Foundry batch JSON parsing
        var foundryJson = """
            ```json
            {
              "items": [
                { "id": 0, "location": "Kyiv, Ukraine" },
                { "id": 1, "location": null },
                { "id": 2, "location": "Global" },
                { "id": "3", "location": "\"U.S.\"" }
              ]
            }
            ```
            """;
        var parsedBatch = NewsLocationService.ParseFoundryBatchResponse(foundryJson);
        if (parsedBatch.Count != 4
            || parsedBatch["0"] != "Kyiv, Ukraine"
            || parsedBatch["1"] is not null
            || parsedBatch["2"] is not null
            || parsedBatch["3"] != "United States")
            throw new InvalidOperationException("Foundry batch response parsing did not sanitize or preserve expected locations.");

        // 3. Open-Meteo qualifier disambiguation & Azure Maps GeoJSON parsing
        var openMeteoJson = """
            {
              "results": [
                { "name": "Hamilton", "country": "Canada", "country_code": "CA", "admin1": "Ontario", "latitude": 43.2557, "longitude": -79.8711, "population": 536917 },
                { "name": "Hamilton", "country": "New Zealand", "country_code": "NZ", "admin1": "Waikato", "latitude": -37.787, "longitude": 175.2793, "population": 176500 }
              ]
            }
            """;
        var hamiltonNz = NewsLocationService.ParseOpenMeteoGeocodeResponse(openMeteoJson, "Hamilton, New Zealand", "New Zealand");
        if (hamiltonNz is null || Math.Abs(hamiltonNz.Latitude - (-37.787)) > 0.01)
            throw new InvalidOperationException("Open-Meteo parser did not disambiguate Hamilton, New Zealand.");

        var hamiltonCa = NewsLocationService.ParseOpenMeteoGeocodeResponse(openMeteoJson, "Hamilton, Ontario", "Ontario");
        if (hamiltonCa is null || Math.Abs(hamiltonCa.Latitude - 43.2557) > 0.01)
            throw new InvalidOperationException("Open-Meteo parser did not disambiguate Hamilton, Ontario.");

        var azureGeoJson = """
            {
              "features": [
                {
                  "geometry": { "type": "Point", "coordinates": [174.7762, -41.2865] },
                  "properties": { "address": { "formattedAddress": "Wellington, New Zealand" } }
                }
              ]
            }
            """;
        var azureGeo = NewsLocationService.ParseAzureMapsGeocodeResponse(azureGeoJson);
        if (azureGeo is null || Math.Abs(azureGeo.Latitude - (-41.2865)) > 0.001 || Math.Abs(azureGeo.Longitude - 174.7762) > 0.001)
            throw new InvalidOperationException("Azure Maps GeoJSON parser failed to extract [lon, lat] coordinates.");

        // 4. Schema upgrade & SQLite integration
        await using var legacyConn = new SqliteConnection("Data Source=:memory:");
        await legacyConn.OpenAsync();
        var legacyOptions = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(legacyConn).Options;
        await using (var legacyDb = new SignalDbContext(legacyOptions))
        {
            await legacyDb.Database.ExecuteSqlRawAsync("""
                CREATE TABLE "StoredNewsArticles" (
                    "Id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    "UserId" TEXT NOT NULL,
                    "Url" TEXT NOT NULL,
                    "Title" TEXT NOT NULL,
                    "Source" TEXT NOT NULL,
                    "PublishedAtUtc" TEXT NOT NULL,
                    "Summary" TEXT NOT NULL,
                    "FullText" TEXT NOT NULL DEFAULT '',
                    "ImageUrl" TEXT NOT NULL DEFAULT '',
                    "TopicsJson" TEXT NOT NULL,
                    "ProvidersJson" TEXT NOT NULL,
                    "MarketQuotesJson" TEXT NOT NULL DEFAULT '[]',
                    "FirstSeenAtUtc" TEXT NOT NULL,
                    "LastSeenAtUtc" TEXT NOT NULL,
                    "IsBookmarked" INTEGER NOT NULL DEFAULT 0,
                    "BookmarkedAtUtc" TEXT NULL,
                    "IsRead" INTEGER NOT NULL DEFAULT 0,
                    "ReadAtUtc" TEXT NULL
                );
                """);
            await ArticleLocationSchema.UpgradeAsync(legacyDb);
            await ArticleLocationSchema.UpgradeAsync(legacyDb); // idempotent check
        }

        await using var conn = new SqliteConnection("Data Source=:memory:");
        await conn.OpenAsync();
        var dbOptions = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(conn).Options;
        await using var db = new SignalDbContext(dbOptions);
        await db.Database.EnsureCreatedAsync();

        db.Users.Add(new ApplicationUser
        {
            Id = "map-user",
            UserName = "map@example.com",
            NormalizedUserName = "MAP@EXAMPLE.COM",
            Email = "map@example.com",
            NormalizedEmail = "MAP@EXAMPLE.COM",
        });
        var now = DateTime.UtcNow;
        db.StoredNewsArticles.AddRange(
            new StoredNewsArticle
            {
                UserId = "map-user",
                Url = "https://example.com/nz-rates",
                Title = "Reserve Bank announces policy update in Wellington",
                Source = "Business Desk",
                PublishedAtUtc = now.AddMinutes(-10),
                Summary = "Economists watched the capital closely.",
                TopicsJson = "[\"Economy\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = now,
                LastSeenAtUtc = now,
            },
            new StoredNewsArticle
            {
                UserId = "map-user",
                Url = "https://example.com/inbox-tips",
                Title = "Five ways to organize your daily inbox",
                Source = "Productivity Daily",
                PublishedAtUtc = now.AddMinutes(-20),
                Summary = "Use folders and filters to clear clutter.",
                TopicsJson = "[\"Productivity\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = now,
                LastSeenAtUtc = now,
            },
            new StoredNewsArticle
            {
                UserId = "map-user",
                Url = "https://example.com/paris-transit",
                Title = "Transit expansion opens new line in Paris",
                Source = "Euro News",
                PublishedAtUtc = now.AddMinutes(-30),
                Summary = "Commuters welcomed the new stations.",
                TopicsJson = "[\"World\"]",
                ProvidersJson = "[\"RSS\"]",
                FirstSeenAtUtc = now,
                LastSeenAtUtc = now,
            });
        await db.SaveChangesAsync();

        using var httpFactory = new StubHttpClientFactory();
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new NewsLocationService(
            httpFactory,
            cache,
            Options.Create(new AzureMapsOptions()),
            NullLogger<NewsLocationService>.Instance);

        var mapped = await service.GetMappedNewsAsync(
            db,
            "map-user",
            userLat: -36.8485,
            userLon: 174.7633,
            topicFilter: null,
            limit: 60,
            CancellationToken.None);

        if (mapped.TotalChecked != 3 || mapped.PendingCount != 0 || mapped.Articles.Length != 2)
            throw new InvalidOperationException($"Expected 2 mapped of 3 checked (0 pending), got {mapped.Articles.Length}/{mapped.TotalChecked} ({mapped.PendingCount} pending).");

        var wellingtonItem = mapped.Articles.Single(a => a.LocationName == "Wellington, New Zealand");
        if (wellingtonItem.DistanceKm is null or < 400 or > 600)
            throw new InvalidOperationException($"Expected ~490 km from Auckland to Wellington, got {wellingtonItem.DistanceKm}.");

        var nonGeoRow = await db.StoredNewsArticles.AsNoTracking().SingleAsync(a => a.Url == "https://example.com/inbox-tips");
        if (nonGeoRow.LocationExtractedAtUtc is null || nonGeoRow.LocationName != "")
            throw new InvalidOperationException("Non-geographic story was not marked extracted with empty LocationName.");

        var economyOnly = await service.GetMappedNewsAsync(
            db,
            "map-user",
            userLat: null,
            userLon: null,
            topicFilter: "economy",
            limit: 60,
            CancellationToken.None);
        if (economyOnly.Articles.Length != 1 || economyOnly.Articles[0].LocationName != "Wellington, New Zealand")
            throw new InvalidOperationException("Topic filter did not restrict mapped news to the selected topic.");

        Console.WriteLine("News location extraction, geocoding, schema upgrade, and map query checks passed.");
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory, IDisposable
    {
        private readonly HttpClient _client = new(new StubHandler());
        public HttpClient CreateClient(string name) => _client;
        public void Dispose() => _client.Dispose();
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.NotFound));
    }
}
