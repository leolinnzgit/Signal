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

internal static class RssFeedLimitChecks
{
    public static async Task RunAsync()
    {
        Check(PreferencesController.MaxRssFeeds == 100,
            $"Expected MaxRssFeeds to be 100, got {PreferencesController.MaxRssFeeds}.");

        var feeds110 = Enumerable.Range(1, 110)
            .Select(i => $"https://93.184.216.34/feed-{i}.xml")
            .ToArray();
        var normalized50 = PreferencesController.NormalizeRssFeeds(feeds110.Take(50));
        Check(normalized50.Length == 50,
            $"Expected NormalizeRssFeeds to keep all 50 feeds above the previous 30 cap, got {normalized50.Length}.");

        var normalizedOverCap = PreferencesController.NormalizeRssFeeds(
            feeds110.Concat(["https://93.184.216.34/feed-1.xml?utm_source=test"]));
        Check(normalizedOverCap.Length == 100
            && normalizedOverCap[^1] == "https://93.184.216.34/feed-100.xml",
            $"Expected NormalizeRssFeeds to deduplicate and cap at 100 feeds, got {normalizedOverCap.Length}.");

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
            .AddApplicationPart(typeof(PreferencesController).Assembly);
        builder.Services.AddMemoryCache();
        var fakeFeedHandler = new FakePublisherFeedHandler();
        builder.Services.AddHttpClient<NewsService>()
            .ConfigurePrimaryHttpMessageHandler(() => fakeFeedHandler);

        await using var app = builder.Build();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();
        app.MapGet("/test/login", async (HttpContext context) =>
        {
            await context.SignInAsync("test", new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(ClaimTypes.NameIdentifier, "rss-limit-user")], "test")));
            return Results.Ok();
        });
        app.MapGet("/test/csrf", (HttpContext context, IAntiforgery csrf) =>
            Results.Json(new { token = csrf.GetAndStoreTokens(context).RequestToken }));

        await using (var scope = app.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
            await db.Database.EnsureCreatedAsync();
            db.Users.Add(new ApplicationUser { Id = "rss-limit-user", UserName = "rss-limit-test" });
            await db.SaveChangesAsync();
        }

        await app.StartAsync();
        try
        {
            var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            using var client = new HttpClient(new HttpClientHandler { CookieContainer = new(), AllowAutoRedirect = false })
            {
                BaseAddress = new(origin),
            };
            await client.GetAsync("/test/login");
            var csrf = await client.GetFromJsonAsync<JsonElement>("/test/csrf");
            client.DefaultRequestHeaders.Add("X-XSRF-TOKEN", csrf.GetProperty("token").GetString());

            // 1. Resolving a 36th feed (above previous 30 cap) succeeds
            using var resolve36 = await client.PostAsJsonAsync("/api/preferences/rss-feed", new
            {
                feed = "https://93.184.216.34/feed-36.xml",
                existingFeeds = feeds110.Take(35).ToArray(),
            });
            Check(resolve36.IsSuccessStatusCode,
                $"Adding a 36th publisher feed should succeed, got {(int)resolve36.StatusCode}.");
            var resolvedBody = await resolve36.Content.ReadFromJsonAsync<JsonElement>();
            Check(resolvedBody.GetProperty("added").GetBoolean()
                && resolvedBody.GetProperty("feeds").GetArrayLength() == 36,
                "Expected 36 feeds returned after resolving the 36th publisher feed.");

            // 2. Resolving a 101st feed hits the new 100 cap
            using var resolve101 = await client.PostAsJsonAsync("/api/preferences/rss-feed", new
            {
                feed = "https://93.184.216.34/feed-101.xml",
                existingFeeds = feeds110.Take(100).ToArray(),
            });
            Check(resolve101.StatusCode == HttpStatusCode.BadRequest,
                $"Adding a 101st publisher feed should return 400 BadRequest, got {(int)resolve101.StatusCode}.");
            var rejectBody = await resolve101.Content.ReadFromJsonAsync<JsonElement>();
            Check(rejectBody.GetProperty("error").GetString() == "You can add up to 100 publisher feeds.",
                $"Unexpected limit error message: {rejectBody}");

            // 3. Saving and reading preferences preserves > 30 feeds cleanly
            var saveRequest = new
            {
                topics = new[] { "AI" },
                limit = 20,
                storyTitleSize = "large",
                topicHeaderSize = "large",
                showTopicFiltersWhenPinned = true,
                showSourceFiltersWhenPinned = true,
                refreshMinutes = 15,
                emailSummaryEnabled = false,
                pushNewsTitlesEnabled = true,
                articleRetentionDays = 30,
                tickerOverrides = new Dictionary<string, string>(),
                trendRegions = new[] { "US" },
                trendsPerRegion = 5,
                sources = new
                {
                    google = true,
                    gdelt = true,
                    rssFeeds = feeds110.Take(45).ToArray(),
                },
            };
            using var saveRes = await client.PostAsJsonAsync("/api/preferences", saveRequest);
            Check(saveRes.IsSuccessStatusCode, $"Saving 45 feeds failed with {(int)saveRes.StatusCode}.");
            var savedPrefs = await client.GetFromJsonAsync<JsonElement>("/api/preferences");
            Check(savedPrefs.GetProperty("preferences").GetProperty("sources").GetProperty("rssFeeds").GetArrayLength() == 45,
                "Preferences GET did not retain all 45 saved publisher feeds.");

            // 4. OPML import adds beyond 30 up to 100 and skips overflow cleanly
            var opmlOutlines = string.Join("\n",
                Enumerable.Range(46, 70)
                    .Select(i => $@"    <outline type=""rss"" text=""Feed {i}"" xmlUrl=""https://93.184.216.34/feed-{i}.xml"" />"));
            var opmlXml = $"""
                <?xml version="1.0" encoding="utf-8"?>
                <opml version="2.0">
                  <body>
                {opmlOutlines}
                  </body>
                </opml>
                """;
            using var importRes = await client.PostAsJsonAsync("/api/preferences/opml/import", new { opmlXml });
            Check(importRes.IsSuccessStatusCode, $"OPML import failed with {(int)importRes.StatusCode}.");
            var importBody = await importRes.Content.ReadFromJsonAsync<JsonElement>();
            Check(importBody.GetProperty("imported").GetInt32() == 55
                && importBody.GetProperty("totalFeeds").GetInt32() == 100
                && importBody.GetProperty("feeds").GetArrayLength() == 100
                && importBody.GetProperty("skipped").GetArrayLength() == 15,
                $"OPML import did not fill up to 100 and skip the excess 15 feeds: {importBody}");

            // 5. Diagnostics endpoints process > 30 feeds concurrently in order and cap at 100
            var diagRequest = new { feeds = feeds110 };
            foreach (var endpoint in new[] { "/api/news/sources/diagnostics", "/api/preferences/sources/diagnostics" })
            {
                using var diagRes = await client.PostAsJsonAsync(endpoint, diagRequest);
                Check(diagRes.IsSuccessStatusCode, $"{endpoint} failed with {(int)diagRes.StatusCode}.");
                var diagBody = await diagRes.Content.ReadFromJsonAsync<JsonElement>();
                var results = diagBody.GetProperty("results");
                Check(results.GetArrayLength() == 100,
                    $"Expected 100 diagnostic results from {endpoint}, got {results.GetArrayLength()}.");
                Check(results[0].GetProperty("url").GetString() == feeds110[0]
                    && results[99].GetProperty("url").GetString() == feeds110[99]
                    && results[0].GetProperty("status").GetString() == "Healthy"
                    && results[99].GetProperty("status").GetString() == "Healthy",
                    $"{endpoint} did not preserve diagnostic result order or health status across 100 feeds.");
            }
        }
        finally
        {
            await app.StopAsync();
        }

        Console.WriteLine("Publisher RSS feed limit checks passed: normalization, resolve limit (100), preferences persistence, OPML overflow, and concurrent diagnostics.");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class FakePublisherFeedHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            await Task.Delay(5, cancellationToken);
            const string xml = """
                <?xml version="1.0" encoding="utf-8"?>
                <rss version="2.0">
                  <channel>
                    <title>Example Feed</title>
                    <item>
                      <title>Example Story</title>
                      <link>https://93.184.216.34/story-1</link>
                      <pubDate>Wed, 11 Nov 2026 00:00:00 GMT</pubDate>
                    </item>
                  </channel>
                </rss>
                """;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(xml, Encoding.UTF8, "application/rss+xml"),
            };
        }
    }
}
