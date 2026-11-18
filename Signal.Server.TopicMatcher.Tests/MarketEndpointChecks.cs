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
            Check(quote.GetProperty("matched").GetBoolean()
                && quote.GetProperty("quote").GetProperty("symbol").GetString() == "NVDA"
                && quote.GetProperty("quote").GetProperty("extendedPrice").GetDecimal() == 194.25m
                && quote.GetProperty("quote").GetProperty("extendedSession").GetString() == "after-hours",
                "Topic lookup must return the matching quote including extended-hours pricing.");
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
            await CheckExtendedHoursParsingAsync();
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
        Check(graph.GetProperty("availableSeries")[0].GetProperty("extendedPrice").GetDecimal() == 194.25m,
            "News graph series summary must propagate live extended-hours price.");
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

        // Verify historical bars assign distinct historic prices per article publish timestamp
        var bars = new[]
        {
            new HistoricalPriceBar(new DateTimeOffset(2026, 11, 14, 21, 0, 0, TimeSpan.Zero), "2026-11-14", 180m, 182m, 2m, 1.11m),
            new HistoricalPriceBar(new DateTimeOffset(2026, 11, 15, 21, 0, 0, TimeSpan.Zero), "2026-11-15", 185m, 189m, 7m, 3.85m),
            new HistoricalPriceBar(new DateTimeOffset(2026, 11, 16, 21, 0, 0, TimeSpan.Zero), "2026-11-16", 190m, 156.14m, -32.86m, -17.39m),
        };
        var qNov15 = MarketDataService.FindHistoricalQuoteAt(new DateTime(2026, 11, 15, 22, 0, 0, DateTimeKind.Utc), null, bars, "NVIDIA", "NVDA", "NVIDIA", "NASDAQ", "USD");
        var qNov16 = MarketDataService.FindHistoricalQuoteAt(new DateTime(2026, 11, 16, 22, 0, 0, DateTimeKind.Utc), null, bars, "NVIDIA", "NVDA", "NVIDIA", "NASDAQ", "USD");
        Check(qNov15?.Price == 189m && qNov16?.Price == 156.14m,
            "FindHistoricalQuoteAt must assign each story its own historic bar price rather than a single flat price.");
    }

    private static async Task CheckExtendedHoursParsingAsync()
    {
        var handler = new ExtendedHoursHandler();
        using var http = new HttpClient(handler) { BaseAddress = new("https://api.twelvedata.com/") };
        using var cache = new Microsoft.Extensions.Caching.Memory.MemoryCache(
            new Microsoft.Extensions.Caching.Memory.MemoryCacheOptions());
        var service = new MarketDataService(
            http,
            cache,
            Microsoft.Extensions.Options.Options.Create(new MarketDataOptions { ApiKey = "test-only" }));

        var afterHours = await service.GetForTopicAsync("NVIDIA", null, CancellationToken.None);
        Check(afterHours?.ExtendedPrice == 162.8m
            && afterHours.ExtendedSession == "after-hours"
            && afterHours.ExtendedPercentChange == 4.72147m
            && !string.IsNullOrWhiteSpace(afterHours.ExtendedQuoteTime),
            "MarketDataService must parse after-hours pricing, session and timestamp.");

        var preMarket = await service.GetForTopicAsync("Apple", null, CancellationToken.None);
        Check(preMarket?.ExtendedPrice == 355.0m && preMarket.ExtendedSession == "pre-market",
            "MarketDataService must classify morning pre-market quotes.");

        var openMarket = await service.GetForTopicAsync("Microsoft", null, CancellationToken.None);
        Check(openMarket?.ExtendedPrice is null,
            "MarketDataService must suppress stale pre-market quotes while regular market hours are open.");

        var fallback = await service.GetForTopicAsync("Amazon", null, CancellationToken.None);
        Check(fallback?.Price == 210.5m && fallback.ExtendedPrice is null && handler.AmazonRequests == 2,
            "MarketDataService must fall back cleanly without prepost=true when pre/post is unavailable.");

        var quotaHandler = new QuotaExhaustedYahooFallbackHandler();
        using var quotaHttp = new HttpClient(quotaHandler) { BaseAddress = new("https://api.twelvedata.com/") };
        using var quotaCache = new Microsoft.Extensions.Caching.Memory.MemoryCache(
            new Microsoft.Extensions.Caching.Memory.MemoryCacheOptions());
        var quotaService = new MarketDataService(
            quotaHttp,
            quotaCache,
            Microsoft.Extensions.Options.Options.Create(new MarketDataOptions { ApiKey = "test-only" }));

        var yahooQuote = await quotaService.GetForTopicAsync("Apple", null, CancellationToken.None, includeSparkline: true);
        Check(yahooQuote is not null
            && yahooQuote.Symbol == "AAPL"
            && yahooQuote.Price == 352.205m
            && yahooQuote.Provider == "Yahoo Finance"
            && yahooQuote.Sparkline is { Length: >= 2 }
            && quotaHandler.TwelveDataRequests == 1,
            "MarketDataService must cache Twelve Data quota exhaustion and fall back to Yahoo Finance for quotes and sparklines.");

        var secondYahooQuote = await quotaService.GetForTopicAsync("Microsoft", null, CancellationToken.None, includeSparkline: true);
        Check(secondYahooQuote is not null
            && secondYahooQuote.Symbol == "MSFT"
            && secondYahooQuote.Provider == "Yahoo Finance"
            && quotaHandler.TwelveDataRequests == 1,
            "Cached Twelve Data quota cooldown must prevent subsequent topics from hitting Twelve Data again.");
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
                : "{\"symbol\":\"NVDA\",\"name\":\"NVIDIA\",\"close\":\"190\",\"percent_change\":\"2\",\"is_market_open\":false,\"extended_price\":\"194.25\",\"extended_change\":\"4.25\",\"extended_percent_change\":\"2.24\",\"extended_timestamp\":1794963540}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        }
    }

    private sealed class ExtendedHoursHandler : HttpMessageHandler
    {
        public int AmazonRequests;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var query = request.RequestUri!.Query;
            if (query.Contains("symbol=AMZN", StringComparison.Ordinal))
            {
                AmazonRequests++;
                if (query.Contains("prepost=true", StringComparison.Ordinal))
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden)
                    {
                        Content = new StringContent(
                            "{\"code\":403,\"message\":\"Pre-market and post-market data are available on the Pro plan.\",\"status\":\"error\"}",
                            Encoding.UTF8,
                            "application/json"),
                    });
                }
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"symbol\":\"AMZN\",\"name\":\"Amazon\",\"close\":\"210.5\",\"percent_change\":\"1.2\",\"is_market_open\":false}",
                        Encoding.UTF8,
                        "application/json"),
                });
            }

            if (query.Contains("symbol=AAPL", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"symbol\":\"AAPL\",\"name\":\"Apple\",\"close\":\"351.9\",\"percent_change\":\"-0.25\",\"is_market_open\":false,\"extended_price\":\"355.0\",\"extended_change\":\"3.1\",\"extended_percent_change\":\"0.88\",\"extended_timestamp\":1794918600}",
                        Encoding.UTF8,
                        "application/json"),
                });
            }

            if (query.Contains("symbol=MSFT", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"symbol\":\"MSFT\",\"name\":\"Microsoft\",\"close\":\"520.0\",\"percent_change\":\"0.5\",\"is_market_open\":true,\"last_quote_at\":1794931200,\"extended_price\":\"518.0\",\"extended_timestamp\":1794918600}",
                        Encoding.UTF8,
                        "application/json"),
                });
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"symbol\":\"NVDA\",\"name\":\"NVIDIA\",\"close\":\"155.46\",\"percent_change\":\"-0.44\",\"is_market_open\":false,\"last_quote_at\":1794949140,\"extended_price\":\"162.8\",\"extended_change\":\"7.34\",\"extended_percent_change\":\"4.72147\",\"extended_timestamp\":1794963540}",
                    Encoding.UTF8,
                    "application/json"),
            });
        }
    }

    private sealed class QuotaExhaustedYahooFallbackHandler : HttpMessageHandler
    {
        public int TwelveDataRequests;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.Host.Equals("api.twelvedata.com", StringComparison.OrdinalIgnoreCase))
            {
                TwelveDataRequests++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.TooManyRequests)
                {
                    Content = new StringContent(
                        "{\"code\":429,\"message\":\"You have run out of API credits for the day. 2559 API credits were used, with the current limit being 800.\",\"status\":\"error\"}",
                        Encoding.UTF8,
                        "application/json"),
                });
            }

            var path = request.RequestUri.AbsolutePath;
            var symbol = path.EndsWith("/MSFT", StringComparison.OrdinalIgnoreCase) ? "MSFT" : "AAPL";
            var price = symbol == "MSFT" ? "502.83" : "352.205";
            var prev = symbol == "MSFT" ? "500.0" : "343.46";
            var payload = $$"""
                {
                  "chart": {
                    "result": [
                      {
                        "meta": {
                          "currency": "USD",
                          "symbol": "{{symbol}}",
                          "exchangeName": "NMS",
                          "exchangeTimezoneName": "America/New_York",
                          "regularMarketTime": 1795017173,
                          "hasPrePostMarketData": false,
                          "regularMarketPrice": {{price}},
                          "previousClose": {{prev}},
                          "fulldayChange": 8.745,
                          "regularMarketChangePercent": 2.546,
                          "longName": "{{symbol}} Inc.",
                          "currentTradingPeriod": {
                            "regular": { "start": 1795012200, "end": 1795035600 }
                          }
                        },
                        "timestamp": [1794900000, 1794986400, 1795017000],
                        "indicators": {
                          "quote": [
                            { "close": [340.0, {{prev}}, {{price}}] }
                          ]
                        }
                      }
                    ]
                  }
                }
                """;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            });
        }
    }
}
