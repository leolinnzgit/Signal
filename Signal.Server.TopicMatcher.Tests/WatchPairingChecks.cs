using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
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

internal static class WatchPairingChecks
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-10-23T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }
    public static async Task RunAsync()
    {
        var clock = new Clock();
        var service = new WatchPairingService(clock, 2);
        var first = service.Create();
        Check(first.DeviceSecret.Length == 64 && first.UserCode.Length == 9, "Generate independent high-entropy device secrets and readable codes.");
        Check(service.Claim(first.DeviceSecret).Status == "pending", "Unapproved watches must not acquire a session.");
        Check(service.Claim(new string('A', 64)).UserId is null, "Unknown device secrets must not acquire an account.");
        Check(!service.Approve("INVALID", "other"), "Invalid approval codes must fail.");
        Check(service.Approve(first.UserCode.ToLowerInvariant(), "owner"), "Authenticated users can approve their displayed code.");
        Check(!service.Approve(first.UserCode, "other"), "A second approver must not replace the approved identity.");
        var claims = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() => service.Claim(first.DeviceSecret))));
        Check(claims.Count(claim => claim.UserId == "owner") == 1, "Concurrent claim replay must create at most one session.");
        Check(!service.Approve(first.UserCode, "owner"), "A consumed code must be unusable.");
        var expired = service.Create();
        clock.Now = clock.Now.AddMinutes(11);
        Check(!service.Approve(expired.UserCode, "owner") && service.Claim(expired.DeviceSecret).Status == "expired", "Expired codes must neither approve nor claim.");
        var fresh = service.Create();
        service.Create();
        try { service.Create(); throw new Exception("Pairing capacity must be bounded."); }
        catch (InvalidOperationException) { }
        Check(fresh.DeviceSecret != first.DeviceSecret, "Every watch needs a fresh independent device secret.");
        var devices = new WatchPairingService();
        var watchCode = devices.Create();
        Check(!devices.Approve(watchCode.UserCode, "owner", "https://push.invalid/phone"), "A watch approval cannot replace browser notifications.");
        var phoneCode = devices.Create("phone");
        Check(devices.Approve(phoneCode.UserCode, "owner", "https://push.invalid/phone"), "Phone approvals can explicitly bind their browser subscription.");
        Check(devices.Claim(phoneCode.DeviceSecret).BrowserEndpoint == "https://push.invalid/phone", "Only the approved phone can claim the browser binding.");
        await CheckHttpFlowAsync();
        Console.WriteLine("Watch pairing passed expiry, replay, capacity, identity, authorization, CSRF and cookie-session checks.");
    }

    private static async Task CheckHttpFlowAsync()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        builder.Services.AddDbContext<SignalDbContext>(options => options.UseSqlite(connection));
        builder.Services.AddIdentity<ApplicationUser, IdentityRole>(options => options.SignIn.RequireConfirmedEmail = true)
            .AddEntityFrameworkStores<SignalDbContext>().AddDefaultTokenProviders();
        builder.Services.ConfigureApplicationCookie(options => options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; });
        builder.Services.AddAntiforgery(options => options.HeaderName = "X-XSRF-TOKEN");
        builder.Services.AddControllersWithViews(options => options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute()))
            .AddApplicationPart(typeof(WatchPairingController).Assembly);
        builder.Services.AddSingleton<WatchPairingService>();
        builder.Services.AddSingleton<INativePushSender>(new NoNativePush());
        builder.Services.AddSingleton<NativeDeliveryReceipts>();
        builder.Services.AddScoped<NativeNotificationService>();
        builder.Services.AddRateLimiter(options => {
            options.AddFixedWindowLimiter("account", config => { config.PermitLimit = 100; config.Window = TimeSpan.FromMinutes(1); });
            options.AddFixedWindowLimiter("watch-poll", config => { config.PermitLimit = 100; config.Window = TimeSpan.FromMinutes(1); });
        });
        await using var app = builder.Build();
        using (var scope = app.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<SignalDbContext>().Database.EnsureCreatedAsync();
            var result = await scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>()
                .CreateAsync(new ApplicationUser { Id = "watch-owner", UserName = "watch-test@example.invalid", Email = "watch-test@example.invalid", EmailConfirmed = true });
            Check(result.Succeeded, "The isolated test account must be created.");
        }
        app.UseRouting(); app.UseAuthentication(); app.UseAuthorization(); app.UseRateLimiter(); app.MapControllers();
        app.MapGet("/test/login", async (SignInManager<ApplicationUser> signIn, UserManager<ApplicationUser> users) => {
            await signIn.SignInAsync((await users.FindByIdAsync("watch-owner"))!, true); return Results.Ok();
        });
        app.MapGet("/test/csrf", (HttpContext context, IAntiforgery csrf) => Results.Json(new { token = csrf.GetAndStoreTokens(context).RequestToken }));
        app.MapGet("/test/me", (ClaimsPrincipal principal) => Results.Text(principal.FindFirstValue(ClaimTypes.NameIdentifier) ?? "")).RequireAuthorization();
        await app.StartAsync();
        try
        {
            var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            using var watch = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), AllowAutoRedirect = false }) { BaseAddress = new Uri(origin) };
            using var phone = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), AllowAutoRedirect = false }) { BaseAddress = new Uri(origin) };
            using var start = await watch.PostAsync("/api/watch/pairing", null);
            Check((await watch.GetAsync("/api/native/config")).StatusCode == HttpStatusCode.Unauthorized, "Native account/configuration endpoints must require sign-in.");
            var nativeStatus = await watch.GetFromJsonAsync<JsonElement>("/api/native/status");
            Check(!nativeStatus.GetProperty("ready").GetBoolean() && nativeStatus.EnumerateObject().Count() == 1, "Public native status must expose only readiness.");
            Check(start.StatusCode == HttpStatusCode.OK, $"Native pairing creation must work without browser CSRF: {(int)start.StatusCode} {await start.Content.ReadAsStringAsync()}");
            var challenge = await start.Content.ReadFromJsonAsync<WatchPairingService.Challenge>();
            var code = challenge!.UserCode;
            Check((await phone.PostAsJsonAsync("/api/watch/pairing/approve", new { code })).StatusCode == HttpStatusCode.Unauthorized, "Anonymous approval must fail.");
            Check((await watch.PostAsJsonAsync("/api/watch/pairing/claim", new { deviceSecret = challenge.DeviceSecret })).StatusCode == HttpStatusCode.Accepted, "Pending HTTP claims must not sign in.");
            await phone.GetAsync("/test/login");
            using var missingCsrf = await phone.PostAsJsonAsync("/api/watch/pairing/approve", new { code });
            Check(missingCsrf.StatusCode == HttpStatusCode.BadRequest, $"Approval without CSRF must fail even when signed in: {(int)missingCsrf.StatusCode} {await missingCsrf.Content.ReadAsStringAsync()}");
            var csrf = await phone.GetFromJsonAsync<JsonElement>("/test/csrf");
            phone.DefaultRequestHeaders.Add("X-XSRF-TOKEN", csrf.GetProperty("token").GetString());
            Check((await phone.PostAsJsonAsync("/api/watch/pairing/approve", new { code })).StatusCode == HttpStatusCode.OK, "Signed-in CSRF-protected phone approval must succeed.");
            Check((await watch.PostAsJsonAsync("/api/watch/pairing/claim", new { deviceSecret = challenge.DeviceSecret })).StatusCode == HttpStatusCode.OK, "The approved watch must receive its cookie.");
            Check(await watch.GetStringAsync("/test/me") == "watch-owner", "The watch session must belong to the approving account.");
            var nativeConfig = await watch.GetFromJsonAsync<JsonElement>("/api/native/config");
            Check(nativeConfig.GetProperty("accountKey").GetString() == NativeNotificationService.AccountKey("watch-owner") && !nativeConfig.TryGetProperty("serviceAccountFile", out _), "Authenticated native configuration must bind the account and omit server credentials.");
            Check((await watch.PostAsJsonAsync("/api/watch/pairing/claim", new { deviceSecret = challenge.DeviceSecret })).StatusCode == HttpStatusCode.Gone, "HTTP claim replay must fail.");
        }
        finally { await app.StopAsync(); }
    }
    private sealed class NoNativePush : INativePushSender
    {
        public bool Ready => false;
        public Task<NativePushResult> SendAsync(string token, IReadOnlyDictionary<string, string> data, CancellationToken ct) => Task.FromResult(NativePushResult.Unavailable);
    }
}
