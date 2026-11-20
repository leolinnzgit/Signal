using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
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
using Microsoft.Extensions.Logging.Abstractions;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class NewsApiKeyChecks
{
    private static void Check(bool value, string message)
    {
        if (!value) throw new Exception(message);
    }

    private sealed class MutableTimeProvider(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now = start;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    public static async Task RunAsync()
    {
        CheckDateRangeParsing();
        await CheckNewsServiceDateRangeAndProvidersAsync();
        await CheckHttpAuthAndExtractionFlowAsync();
        Console.WriteLine("Topic date-range extraction and third-party API key authentication checks passed.");
    }

    private static void CheckDateRangeParsing()
    {
        var anchor = DateTimeOffset.Parse("2026-11-19T12:00:00Z");

        Check(NewsDateRange.TryParse(null, null, out var emptyRange, out var emptyError, anchor)
            && emptyRange is null && emptyError is null,
            "Empty date bounds should succeed with a null range.");

        Check(NewsDateRange.TryParse("2026-10-01", "2026-10-07", out var weekRange, out var weekError, anchor)
            && weekRange is not null && weekError is null,
            "Valid YYYY-MM-DD bounds should parse.");
        Check(weekRange!.From == DateTimeOffset.Parse("2026-10-01T00:00:00Z")
            && weekRange.To == DateTimeOffset.Parse("2026-10-07T00:00:00Z").AddDays(1).AddTicks(-1),
            "Date-only bounds must span the inclusive UTC day range.");
        Check(weekRange.Contains(DateTimeOffset.Parse("2026-10-01T00:00:00Z"))
            && weekRange.Contains(DateTimeOffset.Parse("2026-10-07T23:59:59Z"))
            && !weekRange.Contains(DateTimeOffset.Parse("2026-09-30T23:59:59Z"))
            && !weekRange.Contains(DateTimeOffset.Parse("2026-10-08T00:00:00Z")),
            "DateRange.Contains did not enforce inclusive UTC boundaries.");

        Check(NewsDateRange.TryParse("2026-10-01T13:00:00+13:00", "2026-10-07T12:00:00Z", out var isoRange, out _, anchor)
            && isoRange is not null
            && isoRange.From == DateTimeOffset.Parse("2026-10-01T00:00:00Z")
            && isoRange.To == DateTimeOffset.Parse("2026-10-07T12:00:00Z"),
            "ISO-8601 timestamps with offsets should normalize to UTC.");

        Check(NewsDateRange.TryParse("2026-10-01", null, out var fromOnly, out _, anchor)
            && fromOnly?.From is not null && fromOnly.To is null,
            "from-only range should parse.");

        Check(NewsDateRange.TryParse(null, "2026-10-07", out var toOnly, out _, anchor)
            && toOnly?.From is null && toOnly?.To is not null,
            "to-only range should parse.");

        Check(!NewsDateRange.TryParse("not-a-date", "2026-10-07", out _, out var badFormatError, anchor)
            && !string.IsNullOrWhiteSpace(badFormatError),
            "Invalid date format should fail with an error.");

        Check(!NewsDateRange.TryParse("2026-10-10", "2026-10-01", out _, out var invertedError, anchor)
            && !string.IsNullOrWhiteSpace(invertedError),
            "Inverted date range (from > to) must be rejected.");

        Check(!NewsDateRange.TryParse("1999-12-31", "2026-10-01", out _, out var earlyError, anchor)
            && !string.IsNullOrWhiteSpace(earlyError),
            "Dates before 2000-01-01 must be rejected.");

        Check(!NewsDateRange.TryParse("2026-11-25", null, out _, out var futureError, anchor)
            && !string.IsNullOrWhiteSpace(futureError),
            "Future start dates beyond tolerance must be rejected.");

        Check(NewsDateRange.TryParse("2026-11-20", null, out _, out _, anchor),
            "Today in positive UTC+13 timezone should be accepted.");
    }

    private static async Task CheckNewsServiceDateRangeAndProvidersAsync()
    {
        var handler = new FakeUpstreamNewsHandler();
        using var client = new HttpClient(handler);
        var service = new NewsService(client);

        // 1. Google default uses when:7d
        var defaultGoogle = await service.GetGoogleNewsAsync("AI", 20, CancellationToken.None);
        Check(handler.Requests.Any(u => u.Host == "news.google.com" && Uri.UnescapeDataString(u.Query).Contains("when:7d", StringComparison.Ordinal)),
            "Default Google News query must keep when:7d.");
        Check(defaultGoogle.Articles.Count > 0, "Default Google News should return matching articles.");

        // 2. Google date-ranged uses after:/before: without when:7d and filters accurately
        handler.Requests.Clear();
        NewsDateRange.TryParse("2026-10-01", "2026-10-07", out var range, out _);
        var rangedGoogle = await service.GetGoogleNewsAsync(["AI", "Robots"], 20, range, CancellationToken.None);
        var googleQueries = handler.Requests.Where(u => u.Host == "news.google.com").Select(u => Uri.UnescapeDataString(u.Query)).ToArray();
        Check(googleQueries.Length == 2
            && googleQueries.All(q => q.Contains("after:2026-09-30", StringComparison.Ordinal)
                && q.Contains("before:2026-10-08", StringComparison.Ordinal)
                && !q.Contains("when:7d", StringComparison.Ordinal)),
            "Date-ranged Google News queries must pass widened after:/before: bounds without when:7d.");
        Check(rangedGoogle.Articles.Count == 2
            && rangedGoogle.Articles.All(a => range!.Contains(a.PublishedAt)),
            "Google News date-range extraction must exclude out-of-range stories.");
        var sharedGoogle = rangedGoogle.Articles.Single(a => a.Url == "https://example.com/shared-oct-05");
        Check(sharedGoogle.MatchedTopics is { Count: 2 }
            && sharedGoogle.MatchedTopics.Contains("AI")
            && sharedGoogle.MatchedTopics.Contains("Robots"),
            "Multi-topic Google extraction must deduplicate URLs and union matchedTopics.");

        // 3. GDELT default uses timespan=1week
        handler.Requests.Clear();
        await service.GetGdeltNewsAsync(["AI"], 20, CancellationToken.None);
        var defaultGdeltQuery = Uri.UnescapeDataString(handler.Requests.Single(u => u.Host == "api.gdeltproject.org").Query);
        Check(defaultGdeltQuery.Contains("timespan=1week", StringComparison.Ordinal)
            && !defaultGdeltQuery.Contains("startdatetime", StringComparison.Ordinal),
            "Default GDELT query must keep timespan=1week.");

        // 4. GDELT date-ranged uses startdatetime/enddatetime without timespan and post-filters
        handler.Requests.Clear();
        var rangedGdelt = await service.GetGdeltNewsAsync(["AI", "Robots"], 20, range, CancellationToken.None);
        var rangedGdeltQuery = Uri.UnescapeDataString(handler.Requests.Single(u => u.Host == "api.gdeltproject.org").Query);
        Check(rangedGdeltQuery.Contains("startdatetime=20261001000000", StringComparison.Ordinal)
            && rangedGdeltQuery.Contains("enddatetime=20261007235959", StringComparison.Ordinal)
            && !rangedGdeltQuery.Contains("timespan=", StringComparison.Ordinal),
            $"Date-ranged GDELT query did not send expected timestamps: {rangedGdeltQuery}");
        Check(rangedGdelt.Articles.Count == 2
            && rangedGdelt.Articles.All(a => range!.Contains(a.PublishedAt)),
            "GDELT date-range extraction must exclude out-of-range stories.");

        // 5. Publisher RSS multi-topic + date range
        var rssResult = await service.GetPublisherFeedAsync(
            "https://93.184.216.34/feed.xml",
            ["AI", "Robots"],
            20,
            range,
            CancellationToken.None);
        Check(rssResult.Articles.Count == 1
            && rssResult.Articles[0].Url == "https://93.184.216.34/rss-oct-03"
            && rssResult.Articles[0].MatchedTopics is ["AI", "Robots"],
            "RSS extraction must filter by date range and match across requested topics.");

        // 6. Combined provider merges Google + GDELT
        var combined = await service.GetCombinedNewsAsync(["AI", "Robots"], 20, range, CancellationToken.None);
        Check(combined.Provider == "Google News + GDELT"
            && combined.Articles.Count == 3
            && combined.Articles[0].PublishedAt >= combined.Articles[1].PublishedAt,
            "Combined extraction must merge Google News and GDELT without duplicate URLs.");
        var mergedOverlap = combined.Articles.Single(a => a.Url == "https://example.com/shared-oct-05");
        Check(mergedOverlap.MatchedTopics is { Count: 2 },
            "Combined extraction must preserve matchedTopics across providers.");

        // 7. Combined provider survives single-provider outage (e.g. GDELT rate limit)
        handler.FailGdelt = true;
        var partialCombined = await service.GetCombinedNewsAsync(["AI", "Robots"], 20, range, CancellationToken.None);
        Check(partialCombined.Provider == "Google News" && partialCombined.Articles.Count == 2,
            "Combined extraction must fall back to succeeding provider when GDELT fails.");
    }

    private static async Task CheckHttpAuthAndExtractionFlowAsync()
    {
        var clock = new MutableTimeProvider(DateTimeOffset.Parse("2026-11-19T10:00:00Z"));
        var fakeNewsHandler = new FakeUpstreamNewsHandler();

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();

        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        builder.Services.AddDbContext<SignalDbContext>(options => options.UseSqlite(connection));
        builder.Services.AddIdentity<ApplicationUser, IdentityRole>(options =>
        {
            options.SignIn.RequireConfirmedEmail = true;
            options.Lockout.AllowedForNewUsers = true;
        })
        .AddEntityFrameworkStores<SignalDbContext>()
        .AddDefaultTokenProviders();
        builder.Services.ConfigureApplicationCookie(options =>
        {
            options.Events.OnRedirectToLogin = context =>
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return Task.CompletedTask;
            };
            options.Events.OnRedirectToAccessDenied = context =>
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            };
        });
        builder.Services.AddSingleton<TimeProvider>(clock);
        builder.Services.AddAuthentication()
            .AddScheme<ApiKeyAuthenticationOptions, ApiKeyAuthenticationHandler>(
                ApiKeyAuthenticationDefaults.AuthenticationScheme,
                _ => { });
        builder.Services.AddAuthorization(ApiKeyAuthorization.Configure);
        builder.Services.AddAntiforgery(options => options.HeaderName = "X-XSRF-TOKEN");
        builder.Services.AddControllersWithViews(options =>
            options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute()))
            .AddApplicationPart(typeof(NewsController).Assembly);
        builder.Services.AddMemoryCache();
        builder.Services.AddRateLimiter(SignalRateLimiting.Configure);
        builder.Services.AddScoped<ApiKeyService>();
        builder.Services.AddHttpClient<NewsService>()
            .ConfigurePrimaryHttpMessageHandler(() => fakeNewsHandler);
        builder.Services.AddHttpClient<ArticleReaderService>()
            .ConfigurePrimaryHttpMessageHandler(() => new NewsEnrichmentHandler());
        builder.Services.Configure<MarketDataOptions>(options => options.ApiKey = "test-only");
        builder.Services.AddHttpClient<MarketDataService>(client => client.BaseAddress = new("https://api.twelvedata.com/"))
            .ConfigurePrimaryHttpMessageHandler(() => new NewsEnrichmentHandler());

        await using var app = builder.Build();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseRateLimiter();
        app.MapControllers();
        app.MapGet("/test/login/{userId}", async (string userId, SignInManager<ApplicationUser> signIn, UserManager<ApplicationUser> users) =>
        {
            var user = await users.FindByIdAsync(userId);
            if (user is null) return Results.NotFound();
            await signIn.SignInAsync(user, true);
            return Results.Ok();
        });
        app.MapGet("/test/csrf", (HttpContext context, IAntiforgery csrf) =>
            Results.Json(new { token = csrf.GetAndStoreTokens(context).RequestToken }));

        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
            await db.Database.EnsureCreatedAsync();
            var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var ownerResult = await users.CreateAsync(new ApplicationUser
            {
                Id = "api-owner",
                UserName = "api-owner@example.invalid",
                Email = "api-owner@example.invalid",
                EmailConfirmed = true,
            });
            Check(ownerResult.Succeeded, "Failed creating test owner account.");
            var secondResult = await users.CreateAsync(new ApplicationUser
            {
                Id = "other-owner",
                UserName = "other-owner@example.invalid",
                Email = "other-owner@example.invalid",
                EmailConfirmed = true,
            });
            Check(secondResult.Succeeded, "Failed creating second test account.");
        }

        await app.StartAsync();
        try
        {
            var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            using var browserClient = new HttpClient(new HttpClientHandler
            {
                CookieContainer = new CookieContainer(),
                AllowAutoRedirect = false,
            }) { BaseAddress = new Uri(origin) };
            using var thirdParty = new HttpClient(new HttpClientHandler
            {
                UseCookies = false,
                AllowAutoRedirect = false,
            }) { BaseAddress = new Uri(origin) };

            // 1. Unauthenticated access to /api/news returns 401 with WWW-Authenticate and JSON error
            using var unauthResp = await thirdParty.GetAsync("/api/news?topic=AI&from=2026-10-01&to=2026-10-07");
            Check(unauthResp.StatusCode == HttpStatusCode.Unauthorized,
                $"Expected 401 for unauthenticated /api/news, got {(int)unauthResp.StatusCode}.");
            Check(unauthResp.Headers.WwwAuthenticate.Any(h => h.Scheme == "Bearer"),
                "Unauthenticated challenge must advertise Bearer realm.");
            var unauthJson = await unauthResp.Content.ReadFromJsonAsync<JsonElement>();
            Check(unauthJson.TryGetProperty("error", out _), "401 response must include JSON error payload.");

            // 2. Browser cookie creates API key (with CSRF enforcement)
            await browserClient.GetAsync("/test/login/api-owner");
            using var missingCsrfResp = await browserClient.PostAsJsonAsync("/api/api-keys", new { name = "No CSRF" });
            Check(missingCsrfResp.StatusCode == HttpStatusCode.BadRequest,
                $"Creating API key without CSRF must fail with 400, got {(int)missingCsrfResp.StatusCode}.");

            var csrfData = await browserClient.GetFromJsonAsync<JsonElement>("/test/csrf");
            browserClient.DefaultRequestHeaders.Add("X-XSRF-TOKEN", csrfData.GetProperty("token").GetString());

            using var createResp = await browserClient.PostAsJsonAsync("/api/api-keys", new
            {
                name = "Research pipeline",
                expiresInDays = 1,
                scopes = new[] { "news:read" },
            });
            Check(createResp.StatusCode == HttpStatusCode.Created,
                $"Creating API key should return 201 Created, got {(int)createResp.StatusCode}: {await createResp.Content.ReadAsStringAsync()}");
            var createdPayload = await createResp.Content.ReadFromJsonAsync<JsonElement>();
            var plaintextKey = createdPayload.GetProperty("key").GetString()!;
            var keyId = createdPayload.GetProperty("apiKey").GetProperty("id").GetString()!;
            Check(plaintextKey.StartsWith("sig_", StringComparison.Ordinal)
                && plaintextKey.Length == ApiKeyService.ExpectedKeyLength,
                $"Generated API key has unexpected format/length ({plaintextKey.Length}).");

            // Confirm database stores SHA-256 hash only
            await using (var scope = app.Services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
                var row = await db.ApiKeys.AsNoTracking().SingleAsync(k => k.Id == keyId);
                Check(row.KeyHash == ApiKeyService.ComputeHash(plaintextKey)
                    && !row.KeyHash.Contains(plaintextKey, StringComparison.Ordinal)
                    && row.KeyPrefix == plaintextKey[..12],
                    "Database must store SHA-256 hash and masked prefix only.");
            }

            // 3. Third-party verifies credentials via GET /api/api-keys/verify
            using var verifyReq = new HttpRequestMessage(HttpMethod.Get, "/api/api-keys/verify");
            verifyReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
            using var verifyResp = await thirdParty.SendAsync(verifyReq);
            Check(verifyResp.StatusCode == HttpStatusCode.OK,
                $"Key verification failed: {(int)verifyResp.StatusCode} {await verifyResp.Content.ReadAsStringAsync()}");
            var verifyJson = await verifyResp.Content.ReadFromJsonAsync<JsonElement>();
            Check(verifyJson.GetProperty("authenticated").GetBoolean()
                && verifyJson.GetProperty("keyId").GetString() == keyId
                && verifyJson.GetProperty("name").GetString() == "Research pipeline",
                "Verify endpoint returned unexpected metadata.");

            // Browser cookie alone cannot hit ApiKeyOnly verify endpoint
            using var cookieVerifyResp = await browserClient.GetAsync("/api/api-keys/verify");
            Check(cookieVerifyResp.StatusCode == HttpStatusCode.Unauthorized,
                "Browser cookie without API key must not authenticate ApiKeyOnly verify endpoint.");

            // 4. Third-party extracts multi-topic date-range via Authorization: Bearer
            using var extractBearerReq = new HttpRequestMessage(
                HttpMethod.Get,
                "/api/news?topic=AI&topic=Robots&from=2026-10-01&to=2026-10-07&provider=all");
            extractBearerReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
            using var extractBearerResp = await thirdParty.SendAsync(extractBearerReq);
            Check(extractBearerResp.StatusCode == HttpStatusCode.OK,
                $"Bearer extraction failed: {(int)extractBearerResp.StatusCode} {await extractBearerResp.Content.ReadAsStringAsync()}");
            Check(extractBearerResp.Headers.CacheControl?.NoStore == true,
                "API-key authenticated extraction must return Cache-Control: private, no-store.");
            var extractedJson = await extractBearerResp.Content.ReadFromJsonAsync<JsonElement>();
            Check(extractedJson.GetProperty("provider").GetString() == "Google News + GDELT"
                && extractedJson.GetProperty("topics").GetArrayLength() == 2
                && extractedJson.GetProperty("articles").GetArrayLength() == 3,
                $"Unexpected Bearer extraction response: {extractedJson}");
            Check(extractedJson.GetProperty("articles").EnumerateArray().All(article =>
                !article.TryGetProperty("fullText", out _) && !article.TryGetProperty("marketQuotes", out _)),
                "News requests without enrichment flags must retain the existing response shape.");
            await CheckNewsEnrichmentAsync(thirdParty, plaintextKey);

            // 5. Third-party extracts via X-API-Key header
            using var extractHeaderReq = new HttpRequestMessage(
                HttpMethod.Get,
                "/api/news?topic=AI&from=2026-10-01&to=2026-10-07&provider=google");
            extractHeaderReq.Headers.Add("X-API-Key", plaintextKey);
            using var extractHeaderResp = await thirdParty.SendAsync(extractHeaderReq);
            Check(extractHeaderResp.StatusCode == HttpStatusCode.OK,
                $"X-API-Key extraction failed: {(int)extractHeaderResp.StatusCode}");

            // 6. Query string API key without header is rejected
            using var queryKeyResp = await thirdParty.GetAsync($"/api/news?topic=AI&apiKey={plaintextKey}");
            Check(queryKeyResp.StatusCode == HttpStatusCode.Unauthorized,
                "Query-string API keys must never be accepted.");

            // 7. Conflicting headers are rejected
            using var conflictReq = new HttpRequestMessage(HttpMethod.Get, "/api/news?topic=AI");
            conflictReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
            conflictReq.Headers.Add("X-API-Key", "sig_" + new string('A', 43));
            using var conflictResp = await thirdParty.SendAsync(conflictReq);
            Check(conflictResp.StatusCode == HttpStatusCode.Unauthorized,
                "Conflicting Authorization and X-API-Key headers must be rejected.");
            Check(conflictResp.Headers.WwwAuthenticate.ToString().Contains("invalid_token", StringComparison.Ordinal),
                "Failed API key challenge must include error=\"invalid_token\".");

            // 8. Invalid key rejected
            using var badKeyReq = new HttpRequestMessage(HttpMethod.Get, "/api/news?topic=AI");
            badKeyReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "sig_invalid");
            using var badKeyResp = await thirdParty.SendAsync(badKeyReq);
            Check(badKeyResp.StatusCode == HttpStatusCode.Unauthorized,
                "Malformed API key must return 401.");

            // 9. Invalid date range returns 400 with valid key
            using var badDateReq = new HttpRequestMessage(
                HttpMethod.Get,
                "/api/news?topic=AI&from=2026-10-10&to=2026-10-01");
            badDateReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
            using var badDateResp = await thirdParty.SendAsync(badDateReq);
            Check(badDateResp.StatusCode == HttpStatusCode.BadRequest,
                $"Invalid date range must return 400 BadRequest, got {(int)badDateResp.StatusCode}.");

            // 10. Least privilege: API key rejected on cookie-only endpoints
            foreach (var (method, path) in new[]
            {
                (HttpMethod.Get, "/api/api-keys"),
                (HttpMethod.Post, "/api/api-keys"),
                (HttpMethod.Get, "/api/preferences"),
                (HttpMethod.Get, "/api/market?topic=NVIDIA"),
                (HttpMethod.Get, "/api/article-reader?url=https%3A%2F%2F93.184.216.34%2Fnvidia-oct-05"),
                (HttpMethod.Post, "/api/news/sources/diagnostics"),
            })
            {
                using var privReq = new HttpRequestMessage(method, path);
                privReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
                if (method == HttpMethod.Post)
                    privReq.Content = new StringContent("{}", Encoding.UTF8, "application/json");
                using var privResp = await thirdParty.SendAsync(privReq);
                Check(privResp.StatusCode == HttpStatusCode.Unauthorized || privResp.StatusCode == HttpStatusCode.BadRequest
                    ? privResp.StatusCode == HttpStatusCode.Unauthorized
                    : false,
                    $"API key must not access cookie-only endpoint {method} {path}; got {(int)privResp.StatusCode}.");
            }

            // 11. Browser cookie still accesses GET /api/news
            using var browserNewsResp = await browserClient.GetAsync("/api/news?topic=AI&from=2026-10-01&to=2026-10-07");
            Check(browserNewsResp.StatusCode == HttpStatusCode.OK,
                $"Browser cookie access to /api/news failed: {(int)browserNewsResp.StatusCode}");
            Check(browserNewsResp.Headers.CacheControl?.MaxAge == TimeSpan.FromSeconds(120),
                "Cookie-authenticated /api/news should retain max-age=120 caching.");

            // 12. Locked-out and unconfirmed user checks
            await using (var scope = app.Services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
                var owner = await db.Users.SingleAsync(u => u.Id == "api-owner");
                owner.LockoutEnd = clock.Now.AddMinutes(15);
                await db.SaveChangesAsync();

                using var lockedReq = new HttpRequestMessage(HttpMethod.Get, "/api/news?topic=AI");
                lockedReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
                Check((await thirdParty.SendAsync(lockedReq)).StatusCode == HttpStatusCode.Unauthorized,
                    "Locked-out user's API key must be rejected.");

                owner.LockoutEnd = null;
                owner.EmailConfirmed = false;
                await db.SaveChangesAsync();

                using var unconfirmedReq = new HttpRequestMessage(HttpMethod.Get, "/api/news?topic=AI");
                unconfirmedReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
                Check((await thirdParty.SendAsync(unconfirmedReq)).StatusCode == HttpStatusCode.Unauthorized,
                    "Unconfirmed user's API key must be rejected.");

                owner.EmailConfirmed = true;
                await db.SaveChangesAsync();
            }

            // 13. Expiry check via TimeProvider
            clock.Now = clock.Now.AddDays(2);
            using var expiredReq = new HttpRequestMessage(HttpMethod.Get, "/api/news?topic=AI");
            expiredReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", plaintextKey);
            Check((await thirdParty.SendAsync(expiredReq)).StatusCode == HttpStatusCode.Unauthorized,
                "Expired API key must be rejected.");

            // Create a fresh non-expiring key for revocation + active key cap test
            using var secondCreateResp = await browserClient.PostAsJsonAsync("/api/api-keys", new
            {
                name = "Revoke target",
                expiresInDays = (int?)null,
            });
            Check(secondCreateResp.StatusCode == HttpStatusCode.Created, "Should allow creating a new key after first expired.");
            var secondPayload = await secondCreateResp.Content.ReadFromJsonAsync<JsonElement>();
            var secondPlaintextKey = secondPayload.GetProperty("key").GetString()!;
            var secondKeyId = secondPayload.GetProperty("apiKey").GetProperty("id").GetString()!;

            // Verify second key works
            using (var activeReq = new HttpRequestMessage(HttpMethod.Get, "/api/api-keys/verify"))
            {
                activeReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secondPlaintextKey);
                Check((await thirdParty.SendAsync(activeReq)).StatusCode == HttpStatusCode.OK,
                    "Newly created active key should verify.");
            }

            // 14. Revocation immediately invalidates the key (and another user cannot revoke it)
            using var otherBrowser = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer() })
            {
                BaseAddress = new Uri(origin),
            };
            await otherBrowser.GetAsync("/test/login/other-owner");
            var otherCsrf = await otherBrowser.GetFromJsonAsync<JsonElement>("/test/csrf");
            otherBrowser.DefaultRequestHeaders.Add("X-XSRF-TOKEN", otherCsrf.GetProperty("token").GetString());
            using var crossTenantRevoke = await otherBrowser.DeleteAsync($"/api/api-keys/{secondKeyId}");
            Check(crossTenantRevoke.StatusCode == HttpStatusCode.NotFound,
                "Another user must not be able to revoke someone else's API key.");

            using var revokeResp = await browserClient.DeleteAsync($"/api/api-keys/{secondKeyId}");
            Check(revokeResp.StatusCode == HttpStatusCode.NoContent,
                $"Revoking own API key must return 204 NoContent, got {(int)revokeResp.StatusCode}.");

            using (var revokedReq = new HttpRequestMessage(HttpMethod.Get, "/api/news?topic=AI"))
            {
                revokedReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secondPlaintextKey);
                Check((await thirdParty.SendAsync(revokedReq)).StatusCode == HttpStatusCode.Unauthorized,
                    "Revoked API key must immediately return 401.");
            }

            // 15. Active key cap (10) enforced
            for (var i = 1; i <= ApiKeyService.MaxActiveKeysPerUser; i++)
            {
                using var capResp = await browserClient.PostAsJsonAsync("/api/api-keys", new { name = $"Key {i}" });
                Check(capResp.StatusCode == HttpStatusCode.Created, $"Creating key #{i} should succeed.");
            }
            using var overCapResp = await browserClient.PostAsJsonAsync("/api/api-keys", new { name = "Key 11" });
            Check(overCapResp.StatusCode == HttpStatusCode.BadRequest,
                $"Creating an 11th active API key must be rejected with 400, got {(int)overCapResp.StatusCode}.");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    private static async Task CheckNewsEnrichmentAsync(HttpClient client, string key)
    {
        const string path = "/api/news?topic=NVIDIA&provider=rss&feed=https%3A%2F%2F93.184.216.34%2Ffeed.xml&from=2026-10-01&to=2026-10-07";
        async Task<JsonElement[]> ReadArticlesAsync(string flags)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path + flags);
            request.Headers.Add("X-API-Key", key);
            using var response = await client.SendAsync(request);
            Check(response.IsSuccessStatusCode, $"Enriched news failed with {(int)response.StatusCode}.");
            var payload = await response.Content.ReadFromJsonAsync<JsonElement>();
            return payload.GetProperty("articles").EnumerateArray().ToArray();
        }

        var enriched = await ReadArticlesAsync("&includeText=true&includeMarketQuotes=true");
        Check(enriched.Length == 2 && enriched[0].GetProperty("fullText").GetString()!.Contains("NVIDIA published")
            && enriched[0].GetProperty("fullText").GetString()!.Contains("\n\n"),
            "Published article text should retain paragraph breaks in the enriched response.");
        var quote = enriched[0].GetProperty("marketQuotes").EnumerateArray().Single();
        Check(quote.GetProperty("symbol").GetString() == "NVDA"
            && quote.GetProperty("currency").GetString() == "USD"
            && quote.GetProperty("price").GetDecimal() == 141.50m
            && quote.GetProperty("quoteTime").GetString() == "2026-10-05",
            "News should include the closing price on or before the story, even when a later price is available.");
        Check(!enriched[1].TryGetProperty("fullText", out _)
            && enriched[1].GetProperty("summary").GetString() == "A public preview."
            && enriched[1].GetProperty("marketQuotes").GetArrayLength() == 0,
            "Paywalled and older stories should retain the feed summary and omit unavailable text and prices.");

        var textOnly = await ReadArticlesAsync("&includeText=true");
        var quotesOnly = await ReadArticlesAsync("&includeMarketQuotes=true");
        Check(textOnly[0].TryGetProperty("fullText", out _) && !textOnly[0].TryGetProperty("marketQuotes", out _)
            && quotesOnly[0].TryGetProperty("marketQuotes", out _) && !quotesOnly[0].TryGetProperty("fullText", out _),
            "Article text and market quotes must be independently selectable.");
    }

    private sealed class NewsEnrichmentHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/nvidia-oct-02")
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.PaymentRequired));

            var content = path switch
            {
                "/nvidia-oct-05" => """
                    <html><head><script type="application/ld+json">
                    {"@type":"NewsArticle","articleBody":"NVIDIA published a detailed account of its latest semiconductor research, highlighting the practical work behind the new development. Engineers described how they measured improvements across multiple real-world experiments.\n\nThe report also outlined the team's plans to work with universities and industrial partners. It included detailed examples of how researchers compared the new measurements with their earlier results."}
                    </script></head><body></body></html>
                    """,
                "/quote" => """
                    {"symbol":"NVDA","name":"NVIDIA","exchange":"NASDAQ","currency":"USD","close":"199.00"}
                    """,
                "/time_series" => """
                    {"meta":{"exchange_timezone":"America/New_York"},"values":[
                      {"datetime":"2026-10-06","close":"150.00"},
                      {"datetime":"2026-10-05","close":"141.50"},
                      {"datetime":"2026-10-02","close":"130.00"}
                    ]}
                    """,
                _ => throw new InvalidOperationException($"Unexpected enrichment request to {request.RequestUri}."),
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(content, Encoding.UTF8, path == "/nvidia-oct-05" ? "text/html" : "application/json"),
            });
        }
    }

    private sealed class FakeUpstreamNewsHandler : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];
        public bool FailGdelt { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            Requests.Add(uri);

            if (uri.Host == "news.google.com")
            {
                const string xml = """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <rss>
                      <channel>
                        <item>
                          <title>AI chip outlook - Reuters</title>
                          <source>Reuters</source>
                          <link>https://example.com/ai-oct-02</link>
                          <pubDate>Fri, 02 Oct 2026 08:00:00 GMT</pubDate>
                        </item>
                        <item>
                          <title>AI and Robots factory alliance - Bloomberg</title>
                          <source>Bloomberg</source>
                          <link>https://example.com/shared-oct-05</link>
                          <pubDate>Mon, 05 Oct 2026 14:30:00 GMT</pubDate>
                        </item>
                        <item>
                          <title>AI preview before window - Old News</title>
                          <source>Old News</source>
                          <link>https://example.com/ai-sep-30</link>
                          <pubDate>Wed, 30 Sep 2026 23:59:59 GMT</pubDate>
                        </item>
                        <item>
                          <title>Robots after window - Future News</title>
                          <source>Future News</source>
                          <link>https://example.com/robots-oct-08</link>
                          <pubDate>Thu, 08 Oct 2026 00:00:00 GMT</pubDate>
                        </item>
                      </channel>
                    </rss>
                    """;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(xml, Encoding.UTF8, "application/xml"),
                });
            }

            if (uri.Host == "api.gdeltproject.org")
            {
                if (FailGdelt)
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.TooManyRequests)
                    {
                        Content = new StringContent("Rate limited", Encoding.UTF8, "text/plain"),
                    });
                }

                const string json = """
                    {
                      "articles": [
                        {
                          "title": "AI and Robots factory alliance",
                          "url": "https://example.com/shared-oct-05?utm_source=gdelt",
                          "domain": "www.bloomberg.com",
                          "seendate": "20261005T143000Z",
                          "socialimage": ""
                        },
                        {
                          "title": "Robots export milestone reached",
                          "url": "https://example.com/robots-oct-06",
                          "domain": "ft.com",
                          "seendate": "20261006T091500Z",
                          "socialimage": ""
                        },
                        {
                          "title": "AI note outside range",
                          "url": "https://example.com/ai-oct-08",
                          "domain": "example.org",
                          "seendate": "20261008T010000Z",
                          "socialimage": ""
                        }
                      ]
                    }
                    """;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(json, Encoding.UTF8, "application/json"),
                });
            }

            if (uri.Host == "93.184.216.34")
            {
                const string rss = """
                    <?xml version="1.0" encoding="UTF-8"?>
                    <rss>
                      <channel>
                        <title>Example Wire</title>
                        <item>
                          <title>AI powers next-gen Robots</title>
                          <link>https://93.184.216.34/rss-oct-03</link>
                          <pubDate>Sat, 03 Oct 2026 12:00:00 GMT</pubDate>
                        </item>
                        <item>
                          <title>AI older briefing</title>
                          <link>https://93.184.216.34/rss-sep-25</link>
                          <pubDate>Fri, 25 Sep 2026 12:00:00 GMT</pubDate>
                        </item>
                        <item>
                          <title>NVIDIA semiconductor research</title>
                          <link>https://93.184.216.34/nvidia-oct-05</link>
                          <pubDate>Mon, 05 Oct 2026 22:00:00 GMT</pubDate>
                        </item>
                        <item>
                          <title>NVIDIA research preview</title>
                          <link>https://93.184.216.34/nvidia-oct-02</link>
                          <description>A public preview.</description>
                          <pubDate>Fri, 02 Oct 2026 08:00:00 GMT</pubDate>
                        </item>
                      </channel>
                    </rss>
                    """;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(rss, Encoding.UTF8, "application/rss+xml"),
                });
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }
}
