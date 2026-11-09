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
        builder.Services.AddIdentityCore<ApplicationUser>().AddEntityFrameworkStores<SignalDbContext>();
        builder.Services.AddAuthentication("test").AddCookie("test", options =>
            options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; });
        builder.Services.AddAuthorization();
        builder.Services.AddAntiforgery(options => options.HeaderName = "X-XSRF-TOKEN");
        builder.Services.AddControllersWithViews(options => options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute()))
            .AddApplicationPart(typeof(MarketController).Assembly);
        builder.Services.AddMemoryCache();
        builder.Services.Configure<MarketDataOptions>(options => options.ApiKey = "test-only");
        builder.Services.AddHttpClient<MarketDataService>(client => client.BaseAddress = new("https://api.twelvedata.com/"))
            .ConfigurePrimaryHttpMessageHandler(() => new MarketHandler());
        await using var app = builder.Build();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();
        app.MapGet("/test/login", async (HttpContext context) =>
        {
            await context.SignInAsync("test", new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(ClaimTypes.NameIdentifier, "market-user")], "test")));
            return Results.Ok();
        });
        app.MapGet("/test/csrf", (HttpContext context, IAntiforgery csrf) =>
            Results.Json(new { token = csrf.GetAndStoreTokens(context).RequestToken }));
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
            foreach (var path in new[] { "/api/market?topic=nvidia", "/api/market/portfolio" })
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
        }
        finally { await app.StopAsync(); }
        Console.WriteLine("Market HTTP endpoints passed MVC activation, topic matches, unmatched topics, portfolio reads/writes, alerts, authentication and CSRF checks.");
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
                ? "{\"values\":[{\"close\":\"190\"},{\"close\":\"189\"}]}"
                : "{\"symbol\":\"NVDA\",\"name\":\"NVIDIA\",\"close\":\"190\",\"percent_change\":\"2\"}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        }
    }
}
