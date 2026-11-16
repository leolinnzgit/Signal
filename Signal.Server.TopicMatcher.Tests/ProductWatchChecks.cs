using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class ProductWatchChecks
{
    public static async Task RunAsync()
    {
        RunScheduleAndNormalizationChecks();
        await RunControllerPersistenceIsolationAndAiCheckAsync();
        await RunScheduledBackgroundDueCheckAsync();
        Console.WriteLine("Product Watch passed schedule interval calculations (daily/weekly/monthly/6h/12h/fortnightly/manual), gpt-6.1-sol reasoning payload & price parsing, SQLite tenant isolation, and background due-check execution.");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void RunScheduleAndNormalizationChecks()
    {
        var baseUtc = new DateTime(2026, 11, 17, 0, 0, 0, DateTimeKind.Utc);

        Assert(ProductWatchService.NormalizeFrequency("daily") == "daily", "Daily frequency normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("WEEKLY") == "weekly", "Weekly frequency normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("biweekly") == "fortnightly", "Biweekly -> fortnightly normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("monthly") == "monthly", "Monthly frequency normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("6h") == "6h", "6h frequency normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("12h") == "12h", "12h frequency normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("manual") == "manual", "Manual frequency normalization failed.");
        Assert(ProductWatchService.NormalizeFrequency("invalid") == "daily", "Unknown frequency should default to daily.");

        Assert(ProductWatchService.ComputeNextCheckUtc("6h", baseUtc) == baseUtc.AddHours(6), "6h next check mismatch.");
        Assert(ProductWatchService.ComputeNextCheckUtc("12h", baseUtc) == baseUtc.AddHours(12), "12h next check mismatch.");
        Assert(ProductWatchService.ComputeNextCheckUtc("daily", baseUtc) == baseUtc.AddDays(1), "Daily next check mismatch.");
        Assert(ProductWatchService.ComputeNextCheckUtc("weekly", baseUtc) == baseUtc.AddDays(7), "Weekly next check mismatch.");
        Assert(ProductWatchService.ComputeNextCheckUtc("fortnightly", baseUtc) == baseUtc.AddDays(14), "Fortnightly next check mismatch.");
        Assert(ProductWatchService.ComputeNextCheckUtc("monthly", baseUtc) == baseUtc.AddDays(30), "Monthly next check mismatch.");
        Assert(ProductWatchService.ComputeNextCheckUtc("manual", baseUtc) is null, "Manual next check should be null.");

        Assert(MicrosoftFoundryService.IsReasoningDeployment("gpt-6.1-sol"),
            "gpt-6.1-sol must be classified as a reasoning deployment (max_completion_tokens).");
    }

    private static async Task RunControllerPersistenceIsolationAndAiCheckAsync()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var dbOptions = new DbContextOptionsBuilder<SignalDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var db = new SignalDbContext(dbOptions);
        await db.Database.EnsureCreatedAsync();

        db.Users.AddRange(
            new ApplicationUser { Id = "pw-user-a", UserName = "a@example.com", NormalizedUserName = "A@EXAMPLE.COM" },
            new ApplicationUser { Id = "pw-user-b", UserName = "b@example.com", NormalizedUserName = "B@EXAMPLE.COM" });
        await db.SaveChangesAsync();

        var foundryOptions = new MicrosoftFoundryOptions
        {
            Endpoint = "https://llnz-2162-resource.services.ai.azure.com",
            Key = "foundry-test-key-for-product-watch-12345",
            Deployment = "gpt-4.1-mini",
        };
        Assert(foundryOptions.GetSelectableDeployments().Contains("gpt-6.1-sol"),
            "MicrosoftFoundryOptions must include gpt-6.1-sol as a selectable deployment.");

        var foundryHandler = new FakeProductFoundryHandler(foundryOptions.Key);
        using var foundryHttp = new HttpClient(foundryHandler);
        var foundry = new MicrosoftFoundryService(
            Options.Create(foundryOptions),
            new SingleHttpClientFactory(foundryHttp),
            NullLogger<MicrosoftFoundryService>.Instance);

        using var newsHttp = new HttpClient(new FakeDealRssHandler());
        var newsService = new NewsService(newsHttp);

        var watchService = new ProductWatchService(
            foundry,
            db,
            newsService,
            null,
            NullLogger<ProductWatchService>.Instance);

        var controllerA = CreateController("pw-user-a", db, foundry, watchService);
        var controllerB = CreateController("pw-user-b", db, foundry, watchService);

        // 1. Upsert a watched product with weekly frequency
        var upsertAction = await controllerA.Upsert(
            new ProductWatchController.ProductWatchUpsertRequest(
                Id: null,
                ProductName: "Sony WH-1000XM5 Headphones",
                ModelOrSku: "WH-1000XM5",
                Frequency: "weekly",
                Currency: "NZD",
                TargetPrice: 480m,
                Enabled: true,
                NotifyOnPriceDrop: true,
                CheckNow: false),
            CancellationToken.None) as OkObjectResult;

        Assert(upsertAction?.Value is ProductWatchItemDto, "Upsert did not return ProductWatchItemDto.");
        var created = (ProductWatchItemDto)upsertAction!.Value!;
        Assert(created.ModelOrSku == "WH-1000XM5" && created.Frequency == "weekly" && created.NextCheckAtUtc.HasValue,
            "Created product watch did not persist SKU, weekly frequency, and NextCheckAtUtc.");

        // 2. Tenant isolation: user B cannot see, check, or delete user A's product watch
        var stateB = (await controllerB.Get(CancellationToken.None) as OkObjectResult)?.Value as ProductWatchController.ProductWatchStateResponse;
        Assert(stateB is { Authenticated: true } && stateB.Items.Length == 0,
            "Product Watch leaked user A's watched items to user B.");
        var deleteByB = await controllerB.Delete(created.Id, CancellationToken.None);
        Assert(deleteByB is NotFoundResult, "Cross-user delete must return 404 NotFound.");
        var checkByB = await controllerB.CheckNow(created.Id, CancellationToken.None);
        Assert(checkByB is NotFoundObjectResult, "Cross-user check must return 404 NotFound.");

        // 3. CheckNow executes gpt-6.1-sol deployment with reasoning parameters and updates price history
        var checkAction = await controllerA.CheckNow(created.Id, CancellationToken.None) as OkObjectResult;
        Assert(checkAction?.Value is ProductWatchItemDto, "CheckNow did not return updated ProductWatchItemDto.");
        var checkedDto = (ProductWatchItemDto)checkAction!.Value!;

        Assert(foundryHandler.LastRequestUri?.AbsolutePath == "/openai/deployments/gpt-6.1-sol/chat/completions",
            $"Expected gpt-6.1-sol deployment endpoint, got {foundryHandler.LastRequestUri?.AbsolutePath}");
        using (var reqDoc = JsonDocument.Parse(foundryHandler.LastRequestBody))
        {
            Assert(reqDoc.RootElement.TryGetProperty("max_completion_tokens", out _),
                "gpt-6.1-sol request must send max_completion_tokens.");
            Assert(!reqDoc.RootElement.TryGetProperty("max_tokens", out _),
                "gpt-6.1-sol request must not send unsupported max_tokens.");
        }

        Assert(checkedDto.BestPrice == 449.00m && checkedDto.RegularPrice == 649.00m,
            $"Unexpected best/regular price: {checkedDto.BestPrice} / {checkedDto.RegularPrice}");
        Assert(checkedDto.BestRetailer == "PB Tech" && checkedDto.IsTargetMet,
            "BestRetailer or IsTargetMet flag was not computed properly.");
        Assert(checkedDto.LowestPriceEver == 449.00m && checkedDto.CheckCount == 1 && checkedDto.PriceHistory.Length == 1,
            "LowestPriceEver, CheckCount, or PriceHistory was not updated.");
        Assert(checkedDto.ModelUsed == "gpt-6.1-sol-2026-09-29",
            $"Unexpected ModelUsed: {checkedDto.ModelUsed}");
        Assert(checkedDto.Offers.All(o => !o.Url.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)),
            "Unsafe offer URL was not stripped.");

        // 4. Changing frequency to monthly updates NextCheckAtUtc
        var updateMonthlyAction = await controllerA.Upsert(
            new ProductWatchController.ProductWatchUpsertRequest(
                Id: created.Id,
                ProductName: checkedDto.ProductName,
                ModelOrSku: checkedDto.ModelOrSku,
                Frequency: "monthly",
                Currency: "NZD",
                TargetPrice: 480m,
                Enabled: true,
                NotifyOnPriceDrop: true,
                CheckNow: false),
            CancellationToken.None) as OkObjectResult;
        var monthlyDto = (ProductWatchItemDto)updateMonthlyAction!.Value!;
        Assert(monthlyDto.Frequency == "monthly" && monthlyDto.FrequencyLabel == "Monthly",
            "Frequency update to monthly failed.");
        Assert(monthlyDto.NextCheckAtUtc.HasValue && (monthlyDto.NextCheckAtUtc.Value - DateTime.UtcNow).TotalDays >= 28,
            "Monthly NextCheckAtUtc was not scheduled ~30 days ahead.");
    }

    private static async Task RunScheduledBackgroundDueCheckAsync()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var dbOptions = new DbContextOptionsBuilder<SignalDbContext>()
            .UseSqlite(connection)
            .Options;

        await using var db = new SignalDbContext(dbOptions);
        await db.Database.EnsureCreatedAsync();

        db.Users.Add(new ApplicationUser
        {
            Id = "sched-user",
            UserName = "sched@example.com",
            NormalizedUserName = "SCHED@EXAMPLE.COM",
        });

        var pastDue = DateTime.UtcNow.AddMinutes(-10);
        db.ProductWatches.Add(new ProductWatchItem
        {
            Id = "pw-due-1",
            UserId = "sched-user",
            ProductName = "MC8K4X/A",
            ModelOrSku = "MC8K4X/A",
            Frequency = "daily",
            Currency = "NZD",
            Enabled = true,
            NextCheckAtUtc = pastDue,
            CreatedAtUtc = DateTime.UtcNow.AddDays(-1),
            UpdatedAtUtc = DateTime.UtcNow.AddDays(-1),
        });
        await db.SaveChangesAsync();

        var foundryOptions = new MicrosoftFoundryOptions
        {
            Endpoint = "https://llnz-2162-resource.services.ai.azure.com",
            Key = "foundry-test-key-for-product-watch-12345",
            Deployment = "gpt-6.1-sol",
        };
        var handler = new FakeProductFoundryHandler(foundryOptions.Key);
        using var foundryHttp = new HttpClient(handler);
        var foundry = new MicrosoftFoundryService(
            Options.Create(foundryOptions),
            new SingleHttpClientFactory(foundryHttp),
            NullLogger<MicrosoftFoundryService>.Instance);

        using var newsHttp = new HttpClient(new FakeDealRssHandler());
        var newsService = new NewsService(newsHttp);

        var watchService = new ProductWatchService(
            foundry,
            db,
            newsService,
            null,
            NullLogger<ProductWatchService>.Instance);

        var processed = await watchService.ProcessDueWatchesAsync(CancellationToken.None);
        Assert(processed == 1, $"Expected 1 due product watch to be processed, got {processed}.");

        var updated = await db.ProductWatches.AsNoTracking().SingleAsync(w => w.Id == "pw-due-1");
        Assert(updated.BestPrice == 449.00m && updated.CheckCount == 1 && updated.NextCheckAtUtc > DateTime.UtcNow,
            "Scheduled due check did not update BestPrice, CheckCount, and NextCheckAtUtc.");
    }

    private static ProductWatchController CreateController(
        string userId,
        SignalDbContext db,
        MicrosoftFoundryService foundry,
        ProductWatchService service) =>
        new(db, foundry, service, NullLogger<ProductWatchController>.Instance)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        [new Claim(ClaimTypes.NameIdentifier, userId)],
                        "Test")),
                },
            },
        };

    private sealed class SingleHttpClientFactory(HttpClient client) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => client;
    }

    private sealed class FakeProductFoundryHandler(string expectedKey) : HttpMessageHandler
    {
        public Uri? LastRequestUri { get; private set; }
        public string LastRequestBody { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequestUri = request.RequestUri;
            var actualKey = request.Headers.GetValues("api-key").Single();
            if (actualKey != expectedKey)
            {
                throw new InvalidOperationException("Unexpected api-key header.");
            }

            LastRequestBody = await request.Content!.ReadAsStringAsync(cancellationToken);

            var contentJson = JsonSerializer.Serialize(new
            {
                productName = "Sony WH-1000XM5 Wireless Noise-Canceling Headphones",
                modelOrSku = "WH-1000XM5",
                currency = "NZD",
                bestPrice = 449.00m,
                regularPrice = 649.00m,
                bestRetailer = "PB Tech",
                bestOfferUrl = "https://example.com/pbtech-xm5",
                priceVerdict = "great-deal",
                summary = "PB Tech is offering the WH-1000XM5 for NZD $449.00, saving $200 off the regular $649.00 retail price.",
                buyingTip = "Verify black or silver colour SKU availability before checkout.",
                offers = new object[]
                {
                    new
                    {
                        retailer = "PB Tech",
                        price = 449.00m,
                        currency = "NZD",
                        availability = "Deal",
                        note = "Lowest current NZD price",
                        url = "https://example.com/pbtech-xm5",
                    },
                    new
                    {
                        retailer = "Noel Leeming",
                        price = 499.00m,
                        currency = "NZD",
                        availability = "In Stock",
                        note = "Price match eligible",
                        url = "javascript:alert(1)",
                    },
                },
            });

            var responsePayload = JsonSerializer.Serialize(new
            {
                model = "gpt-6.1-sol-2026-09-29",
                choices = new[]
                {
                    new
                    {
                        message = new { role = "assistant", content = contentJson },
                    },
                },
                usage = new { prompt_tokens = 150, completion_tokens = 110, total_tokens = 260 },
            });

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(responsePayload, Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class FakeDealRssHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            const string xml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <rss>
                  <channel>
                    <item>
                      <title>Sony WH-1000XM5 drops to $449 at PB Tech - TechNews</title>
                      <source>TechNews</source>
                      <link>https://example.com/pbtech-xm5</link>
                      <description>Sony WH-1000XM5 headphones are on sale for $449 down from $649.</description>
                      <pubDate>Tue, 17 Nov 2026 01:00:00 GMT</pubDate>
                    </item>
                  </channel>
                </rss>
                """;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(xml, Encoding.UTF8, "text/xml"),
            });
        }
    }
}
