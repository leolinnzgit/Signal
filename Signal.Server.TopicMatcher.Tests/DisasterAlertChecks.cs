using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class DisasterAlertChecks
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static async Task RunAsync()
    {
        var now = DateTime.UtcNow;
        var device = new EarthquakeDevice { Latitude = -41.3, Longitude = 174.8, RadiusKm = 300, MinimumMagnitude = 4,
            EnabledAtUtc = now.AddMinutes(-5), HazardKindsJson = JsonSerializer.Serialize(DisasterAlertFeed.Kinds), MinimumAlertLevel = "orange" };
        var flood = new DisasterEvent("gdacs:FL:1", "flood", "GDACS", "Flood near Wellington", "Long-running flood", "orange",
            now.AddDays(-10), now, -41.31, 174.81, "https://www.gdacs.org/", UpdatedAtUtc: now.AddMinutes(-1), Episode: "3");
        var reports = new[] { flood, flood with { Id = "old-update", UpdatedAtUtc = now.AddHours(-25) },
            flood with { Id = "future", UpdatedAtUtc = now.AddMinutes(1) }, flood with { Id = "far", Latitude = 40 },
            flood with { Id = "green", AlertLevel = "green" }, flood with { Id = "unknown", AlertLevel = "unknown" } };
        var nearby = DisasterAlertFeed.Nearby(reports, device, now);
        Check(nearby.Length == 1 && nearby[0].Id == flood.Id && nearby[0].DistanceKm is > 0 and < 3,
            "Disaster filters must use updated reports, distance and severity, without suppressing long-running events.");
        Check(nearby[0].Magnitude is null && nearby[0].DepthKm is null && nearby[0].NotificationKey == "gdacs:FL:1:3:orange",
            "Flood alerts must preserve their episode, never fake earthquake measurements.");
        Check(DisasterAlertFeed.Nearby([flood with { UpdatedAtUtc = now }], device, now)[0].NotificationKey == nearby[0].NotificationKey,
            "Routine text/time updates must not repeat the same episode alert.");
        Check(DisasterAlertFeed.Nearby([flood with { Episode = "4" }], device, now)[0].NotificationKey != nearby[0].NotificationKey,
            "New episodes must be eligible for another alert.");
        Check(DisasterAlertFeed.Nearby([flood with { AlertLevel = "red" }], device, now)[0].NotificationKey != nearby[0].NotificationKey,
            "A change in severity must be eligible for another alert.");
        device.HazardKindsJson = "[\"wildfire\"]";
        Check(DisasterAlertFeed.Nearby([flood], device, now).Length == 0, "Disabled hazard types must be excluded.");
        device.HazardKindsJson = JsonSerializer.Serialize(DisasterAlertFeed.Kinds);
        var payload = PushNotificationService.SerializeMessage(PushNotificationService.DisasterMessage(nearby[0]));
        using (var json = JsonDocument.Parse(payload))
        {
            Check(json.RootElement.GetProperty("title").GetString() == "Flood: orange alert"
                && json.RootElement.GetProperty("tag").GetString() == "signal-disaster-gdacs:FL:1:3:orange"
                && json.RootElement.GetProperty("url").GetString() == "/#disaster-alerts", "Background pushes must carry the hazard, episode and settings link.");
        }
        foreach (var failure in new[] { "earthquakes", "disasters", "both", "none" })
        {
            var clients = new Clients(failure, now);
            var feed = new DisasterAlertFeed(new EarthquakeFeed(clients), new DisasterFeed(clients));
            var result = await feed.GetAsync(device, default);
            Check(result.Warnings.Length == (failure == "both" ? 2 : failure == "none" ? 0 : 1), "Each failed source must return an explicit warning.");
            Check(result.Events.Length == (failure == "both" ? 0 : failure == "none" ? 2 : 1), "One failed source must not suppress another source's alerts.");
        }
        await SchemaAsync();
        await ControllerAsync();
        Console.WriteLine("Disaster alert filters, episodes, partial failures, push payloads, device ownership and database upgrade checks passed.");
    }
    private static async Task SchemaAsync()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new SignalDbContext(new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options);
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE EarthquakeDevices (Id TEXT PRIMARY KEY, UserId TEXT NOT NULL, Latitude REAL NOT NULL, Longitude REAL NOT NULL,
                RadiusKm REAL NOT NULL, MinimumMagnitude REAL NOT NULL, LocationUpdatedAtUtc TEXT NOT NULL, EnabledAtUtc TEXT NOT NULL,
                PushEndpoint TEXT NOT NULL, SeenJson TEXT NOT NULL);
            INSERT INTO EarthquakeDevices VALUES ('existing', 'owner', -41.3, 174.8, 500, 5, '2026-10-23 00:00:00', '2026-10-23 00:00:00', 'https://push.test/1', '["geonet:seen"]');
            """);
        await DisasterDeviceSchema.UpgradeAsync(db);
        await DisasterDeviceSchema.UpgradeAsync(db);
        var saved = await db.EarthquakeDevices.SingleAsync();
        Check(saved.RadiusKm == 500 && saved.MinimumMagnitude == 5 && saved.PushEndpoint == "https://push.test/1"
            && saved.SeenJson == "[\"geonet:seen\"]" && saved.MinimumAlertLevel == "green", "Upgrade must preserve device settings, subscription and seen events.");
    }
    private static async Task ControllerAsync()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new SignalDbContext(new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options);
        await db.Database.EnsureCreatedAsync();
        db.Users.AddRange(new ApplicationUser { Id = "owner", UserName = "owner@test" }, new ApplicationUser { Id = "other", UserName = "other@test" });
        await db.SaveChangesAsync();
        var services = new ServiceCollection().AddLogging().AddSingleton(db);
        services.AddIdentityCore<ApplicationUser>().AddEntityFrameworkStores<SignalDbContext>();
        using var provider = services.BuildServiceProvider();
        var clients = new Clients("none", DateTime.UtcNow);
        var quakes = new EarthquakeFeed(clients); var disasters = new DisasterFeed(clients);
        var controller = new EarthquakesController(db, provider.GetRequiredService<UserManager<ApplicationUser>>(), quakes, disasters,
            new DisasterAlertFeed(quakes, disasters), Options.Create(new AzureMapsOptions())) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "owner")], "test")) } }
        };
        var id = Guid.NewGuid();
        var request = new EarthquakeDeviceRequest(-41.3, 174.8, 300, 4, null, ["flood", "earthquake"], "orange");
        Check(await controller.Save(id, request with { HazardKinds = [] }, default) is BadRequestObjectResult, "Empty hazard selection must be rejected.");
        Check(await controller.Save(id, request with { HazardKinds = ["invalid"] }, default) is BadRequestObjectResult, "Unsupported hazard must be rejected.");
        Check(await controller.Save(id, request with { MinimumAlertLevel = "invalid" }, default) is BadRequestObjectResult, "Unknown alert level must be rejected.");
        Check(await controller.Save(id, request, default) is OkObjectResult, "Disaster settings must save.");
        var device = await db.EarthquakeDevices.SingleAsync();
        Check(DisasterAlertFeed.DeviceKinds(device).SequenceEqual(request.HazardKinds!) && device.MinimumAlertLevel == "orange", "Persist hazard and severity preferences.");
        await controller.Save(id, request with { HazardKinds = null, MinimumAlertLevel = null }, default);
        Check(device.MinimumAlertLevel == "orange" && DisasterAlertFeed.DeviceKinds(device).Length == 2, "Legacy clients must not overwrite disaster preferences.");
        device.LocationUpdatedAtUtc = DateTime.UtcNow.AddHours(-25); await db.SaveChangesAsync();
        Check(await controller.CheckDisasters(id, default) is ObjectResult { StatusCode: 409 }, "Expired phone location must stop disaster monitoring.");
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "other")], "test"));
        Check(await controller.CheckDisasters(id, default) is NotFoundResult && await controller.Save(id, request, default) is NotFoundResult,
            "Another account must never read or modify device registrations.");
        await controller.Delete(id, default);
        Check(await db.EarthquakeDevices.CountAsync() == 1, "Another account must never delete a device.");
    }
    private sealed class Clients(string failure, DateTime now) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler(name, failure, now));
        private sealed class Handler(string name, string failure, DateTime now) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                if (failure == name || failure == "both") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
                var data = name == "earthquakes" ? JsonSerializer.Serialize(new { features = new[] { new {
                    properties = new { publicID = "test", magnitude = 5.1, locality = "Near Wellington", time = now.AddMinutes(-1), depth = 12, quality = "best" },
                    geometry = new { coordinates = new[] { 174.8, -41.3 } }
                } } }) : $$"""
                    <rss xmlns:gdacs="http://www.gdacs.org" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#"><channel><item>
                    <title>Flood near Wellington</title><gdacs:eventtype>FL</gdacs:eventtype><gdacs:eventid>1</gdacs:eventid><gdacs:episodeid>3</gdacs:episodeid>
                    <gdacs:fromdate>{{now.AddDays(-2):O}}</gdacs:fromdate><gdacs:datemodified>{{now.AddMinutes(-1):O}}</gdacs:datemodified>
                    <gdacs:alertlevel>Orange</gdacs:alertlevel><geo:Point><geo:lat>-41.3</geo:lat><geo:long>174.8</geo:long></geo:Point>
                    </item></channel></rss>
                    """;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(data) });
            }
        }
    }
}
