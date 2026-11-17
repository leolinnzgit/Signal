using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class MarketEndpointChecks
{
    public static async Task RunAsync()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        builder.Services.AddDbContext<SignalDbContext>(options => options.UseSqlite(connection));
        builder.Services.AddIdentityCore<ApplicationUser>().AddEntityFrameworkStores<SignalDbContext>().AddSignInManager();
        builder.Services.AddAuthentication("test").AddCookie("test", options =>
            options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; });
        builder.Services.AddAuthorization();
        builder.Services.AddAntiforgery(options => options.HeaderName = "X-XSRF-TOKEN");
        builder.Services.AddControllersWithViews(options => options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute()))
            .AddApplicationPart(typeof(MarketController).Assembly);
        builder.Services.AddMemoryCache();
        builder.Services.AddRateLimiter(SignalRateLimiting.Configure);
        builder.Services.AddScoped<IAccountEmailSender, NoEmail>();
        builder.Services.Configure<AzureLanguageOptions>(_ => { });
        builder.Services.AddHttpClient();
        builder.Services.AddHttpClient<ArticleReaderService>();
        builder.Services.AddSingleton<AzureLanguageSentimentService>();
        builder.Services.AddSingleton<AzureLanguageKeyPhraseService>();
        builder.Services.Configure<MarketDataOptions>(options => options.ApiKey = "test-only");
        builder.Services.AddHttpClient<MarketDataService>(client => client.BaseAddress = new("https://api.twelvedata.com/"))
            .ConfigurePrimaryHttpMessageHandler(() => new MarketHandler());
        await using var app = builder.Build();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseRateLimiter();
        app.MapControllers();
        app.MapGet("/test/login", async (HttpContext context) =>
        {
            await context.SignInAsync("test", new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(ClaimTypes.NameIdentifier, "market-user")], "test")));
            return Results.Ok();
        });
        app.MapGet("/test/csrf", (HttpContext context, IAntiforgery csrf) =>
            Results.Json(new { token = csrf.GetAndStoreTokens(context).RequestToken }));
        app.MapGet("/test/activity", () => Results.Ok()).RequireAuthorization().RequireRateLimiting("account");
        app.MapPost("/test/activity", () => Results.Ok()).RequireAuthorization().RequireRateLimiting("account");
        app.MapGet("/test/credential", () => Results.Ok()).RequireRateLimiting("authentication");
        app.MapGet("/test/other-user", async (HttpContext context) => {
            await context.SignInAsync("test", new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "second-user")], "test")));
            return Results.Ok();
        });
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
            await db.Database.EnsureCreatedAsync();
            db.Users.Add(new ApplicationUser { Id = "market-user", UserName = "market-test" });
            await db.SaveChangesAsync();
        }
        await app.StartAsync();
        try
        {
            var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            using var client = new HttpClient(new HttpClientHandler { CookieContainer = new(), AllowAutoRedirect = false }) { BaseAddress = new(origin) };
            foreach (var path in new[] { "/api/market?topic=nvidia", "/api/market/portfolio", "/api/market/news-graph?topic=nvidia" })
                Check((await client.GetAsync(path)).StatusCode == HttpStatusCode.Unauthorized, "Market data requires sign-in.");
            await client.GetAsync("/test/login");

            // Exercise MVC's actual controller factory: direct new MarketController tests missed
            // the competing constructors that made every authenticated market request return 500.
            using var quoteResponse = await client.GetAsync("/api/market?topic=nvidia&sparkline=true");
            Check(quoteResponse.IsSuccessStatusCode, "MVC must activate the market controller for topic quotes.");
            var quote = await quoteResponse.Content.ReadFromJsonAsync<JsonElement>();
            Check(quote.GetProperty("matched").GetBoolean() && quote.GetProperty("quote").GetProperty("symbol").GetString() == "NVDA",
                "Topic lookup must return the matching quote.");
            foreach (var topic in new[] { "usa", "vegetarian" })
            {
                var unmatched = await client.GetFromJsonAsync<JsonElement>("/api/market?topic=" + topic);
                Check(!unmatched.GetProperty("matched").GetBoolean(), "Non-stock topics must return a normal unmatched response.");
            }
            var portfolio = await client.GetFromJsonAsync<JsonElement>("/api/market/portfolio");
            Check(portfolio.GetProperty("items").GetArrayLength() == 0, "Portfolio reads must activate MVC and the database dependencies.");
            var watchlist = new { items = new[] { new { topic = "NVIDIA" } }, includeSparklines = true };
            Check((await client.PostAsJsonAsync("/api/market/watchlist", watchlist)).StatusCode == HttpStatusCode.BadRequest,
                "Watchlist requests must retain CSRF protection.");
            var csrf = await client.GetFromJsonAsync<JsonElement>("/test/csrf");
            client.DefaultRequestHeaders.Add("X-XSRF-TOKEN", csrf.GetProperty("token").GetString());
            using var watchlistResponse = await client.PostAsJsonAsync("/api/market/watchlist", watchlist);
            Check(watchlistResponse.IsSuccessStatusCode, "MVC must activate the market controller for watchlists.");
            var result = await watchlistResponse.Content.ReadFromJsonAsync<JsonElement>();
            Check(result.GetProperty("quotes").GetArrayLength() == 1, "Watchlists must contain a resolved quote.");
            using var saved = await client.PostAsJsonAsync("/api/market/portfolio", new[] {
                new { symbol = "NVDA", displayName = "NVIDIA", alertThresholdPercent = 1, alertEnabled = true }
            });
            Check(saved.IsSuccessStatusCode, "Portfolio writes must resolve all controller dependencies.");
            var savedPortfolio = await saved.Content.ReadFromJsonAsync<JsonElement>();
            Check(savedPortfolio.GetProperty("items").GetArrayLength() == 1 && savedPortfolio.GetProperty("hasAlerts").GetBoolean(),
                "Saved portfolio and price alerts must remain functional.");
            await CheckStockNewsRecordingAndGraphAsync(client);
            await CheckDesktopRequestsAsync(client);
        }
        finally { await app.StopAsync(); }
        Console.WriteLine("Market HTTP endpoints passed MVC activation, topic matches, unmatched topics, portfolio reads/writes, alerts, authentication and CSRF checks.");
    }

    private static async Task CheckStockNewsRecordingAndGraphAsync(HttpClient client)
    {
        var initialPublished = DateTimeOffset.UtcNow.AddHours(-4);
        var initialQuote = new
        {
            topic = "NVIDIA",
            symbol = "NVDA",
            name = "NVIDIA",
            exchange = "NASDAQ",
            currency = "USD",
            price = 175.50m,
            change = 3.25m,
            percentChange = 1.89m,
            quoteTime = "2026-11-17 12:00:00",
            isMarketOpen = true,
            recordedAtUtc = initialPublished.UtcDateTime,
        };

        using var firstSync = await client.PostAsJsonAsync("/api/articles/sync", new
        {
            articles = new object[]
            {
                new
                {
                    title = "NVIDIA unveils Blackwell server milestone",
                    url = "https://example.com/nvda-story-1",
                    source = "Reuters",
                    publishedAt = initialPublished,
                    summary = "New GPU clusters ship ahead of schedule.",
                    topics = new[] { "NVIDIA" },
                    providers = new[] { "Google News" },
                    marketQuotes = new[] { initialQuote },
                },
                new
                {
                    title = "NVIDIA cloud demand remains strong",
                    url = "https://example.com/nvda-story-2",
                    source = "Bloomberg",
                    publishedAt = DateTimeOffset.UtcNow.AddHours(-1),
                    summary = "Data center bookings beat expectations.",
                    topics = new[] { "NVIDIA" },
                    providers = new[] { "Google News" },
                },
            },
        });
        Check(firstSync.IsSuccessStatusCode, "Article sync with stock price recording must succeed.");
        var syncedHistory = await firstSync.Content.ReadFromJsonAsync<JsonElement>();
        var syncedArticles = syncedHistory.GetProperty("articles");
        Check(syncedArticles.GetArrayLength() == 2, "Both NVIDIA stories must be stored in article history.");

        // Re-sync the first story with a different quote price and verify its original first-seen price ($175.50) is preserved.
        using var secondSync = await client.PostAsJsonAsync("/api/articles/sync", new
        {
            articles = new object[]
            {
                new
                {
                    title = "NVIDIA unveils Blackwell server milestone",
                    url = "https://example.com/nvda-story-1",
                    source = "Reuters",
                    publishedAt = initialPublished,
                    summary = "New GPU clusters ship ahead of schedule.",
                    topics = new[] { "NVIDIA" },
                    providers = new[] { "Google News" },
                    marketQuotes = new[]
                    {
                        new
                        {
                            topic = "NVIDIA",
                            symbol = "NVDA",
                            name = "NVIDIA",
                            exchange = "NASDAQ",
                            currency = "USD",
                            price = 210.00m,
                            change = 20.00m,
                            percentChange = 10.50m,
                            quoteTime = "2026-11-17 16:00:00",
                            isMarketOpen = false,
                            recordedAtUtc = DateTime.UtcNow,
                        },
                    },
                },
            },
        });
        Check(secondSync.IsSuccessStatusCode, "Re-syncing an existing story must succeed.");

        var graph = await client.GetFromJsonAsync<JsonElement>("/api/market/news-graph?topic=NVIDIA&days=30");
        Check(graph.GetProperty("activeSymbol").GetString() == "NVDA", "News graph must resolve active NVDA series.");
        Check(graph.GetProperty("availableSeries").GetArrayLength() >= 1, "News graph must list NVDA in availableSeries.");
        var graphEvents = graph.GetProperty("events");
        Check(graphEvents.GetArrayLength() == 2, "News graph must include both recorded NVIDIA stories.");
        Check(graphEvents[0].GetProperty("url").GetString() == "https://example.com/nvda-story-1",
            "News graph events must be sorted chronologically.");
        Check(graphEvents[0].GetProperty("price").GetDecimal() == 175.50m,
            "Re-syncing an existing article must preserve its original first-seen stock price snapshot.");
        Check(graphEvents[1].GetProperty("price").GetDecimal() == 190m && graphEvents[1].GetProperty("isRecordedSnapshot").GetBoolean(),
            "Articles synced without client quotes must automatically record server-resolved stock prices.");
        Check(graph.GetProperty("pricePoints").GetArrayLength() >= 4,
            "News graph must combine dated historical closes with recorded news snapshots.");
    }

    private static async Task CheckDesktopRequestsAsync(HttpClient client)
    {
        for (var i = 0; i < 45; i++)
        {
            Check((await client.GetAsync("/test/activity")).IsSuccessStatusCode, "Routine signed-in reads must exceed the old shared 30-request ceiling.");
            Check((await client.GetAsync("/api/auth/csrf")).IsSuccessStatusCode, "Token issuance must have an independent budget.");
        }
        client.DefaultRequestHeaders.Remove("X-XSRF-TOKEN");
        var article = new { url = "https://example.com/story", title = "Story", paragraphs = new[] { "A full paragraph for analysis, without calling any cloud services in this test." } };
        foreach (var endpoint in new[] { "/api/article-sentiment", "/api/article-keyphrases" })
            Check((await client.PostAsJsonAsync(endpoint, article)).StatusCode == HttpStatusCode.BadRequest, "Article analysis must require a CSRF token.");
        var token = (await client.GetFromJsonAsync<JsonElement>("/api/auth/csrf")).GetProperty("token").GetString();
        client.DefaultRequestHeaders.Add("X-XSRF-TOKEN", token);
        foreach (var endpoint in new[] { "/api/article-sentiment", "/api/article-keyphrases" })
            Check((await client.PostAsJsonAsync(endpoint, article)).IsSuccessStatusCode, "Signed-in article analysis with CSRF must succeed through MVC.");

        HttpResponseMessage? rejected = null;
        for (var i = 0; i < 250; i++)
        {
            var response = await client.GetAsync("/test/activity");
            if (response.StatusCode == HttpStatusCode.TooManyRequests) { rejected = response; break; }
            Check(response.IsSuccessStatusCode, "Routine reads must return success until the bounded limit is reached.");
            response.Dispose();
        }
        using (rejected)
            Check(rejected?.Headers.RetryAfter?.Delta is { TotalSeconds: > 0 }, "Actual throttling must return Retry-After.");
        Check((await client.GetAsync("/api/auth/csrf")).IsSuccessStatusCode, "Throttled reads must not prevent obtaining security tokens.");
        Check((await client.PostAsync("/test/activity", null)).IsSuccessStatusCode, "Background reads must not block app writes.");
        for (var i = 0; i < 30; i++) Check((await client.GetAsync("/test/credential")).IsSuccessStatusCode, "Credential requests retain their existing bounded allowance.");
        Check((await client.GetAsync("/test/credential")).StatusCode == HttpStatusCode.TooManyRequests, "Credential attempts must still be throttled.");
        Check((await client.PostAsJsonAsync("/api/auth/login", new { email = "missing@example.com", password = "invalid" })).StatusCode == HttpStatusCode.TooManyRequests,
            "The actual login endpoint must use the stricter credential policy.");
        Check((await client.GetAsync("/api/auth/csrf")).IsSuccessStatusCode, "Credential throttling must not cascade into token failures.");
        await client.GetAsync("/test/other-user");
        Check((await client.GetAsync("/test/activity")).IsSuccessStatusCode, "Two accounts behind one proxy/IP must have separate app budgets.");
        Console.WriteLine("Desktop requests passed real CSRF-protected analysis, routine polling bursts, separate token/read/write/sign-in budgets, per-user isolation and Retry-After checks.");
    }

    private sealed class NoEmail : IAccountEmailSender
    {
        public Task SendConfirmationAsync(string email, string url, CancellationToken token) => throw new NotSupportedException();
        public Task SendPasswordResetAsync(string email, string url, CancellationToken token) => throw new NotSupportedException();
        public Task SendNewsSummaryAsync(string email, NewsSummaryDigest digest, CancellationToken token) => throw new NotSupportedException();
        public Task SendSharedArticleAsync(string email, SharedArticleEmail article, CancellationToken token) => throw new NotSupportedException();
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class MarketHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            var json = path.EndsWith("symbol_search") ? "{\"data\":[]}" : path.EndsWith("time_series")
                ? "{\"values\":[{\"datetime\":\"2026-11-16\",\"close\":\"190\"},{\"datetime\":\"2026-11-15\",\"close\":\"189\"}]}"
                : "{\"symbol\":\"NVDA\",\"name\":\"NVIDIA\",\"close\":\"190\",\"percent_change\":\"2\"}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        }
    }
}
