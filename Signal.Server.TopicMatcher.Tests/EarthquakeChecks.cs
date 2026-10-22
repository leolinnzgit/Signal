using System.Text.Json;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class EarthquakeChecks
{
    public static async Task RunLiveAsync()
    {
        var feed = new EarthquakeFeed(new LiveClients());
        foreach (var location in new[] { (Latitude: -41.3, Longitude: 174.8), (Latitude: 38.0, Longitude: -122.0) })
        {
            var events = await feed.GetAsync(location.Latitude, location.Longitude, CancellationToken.None);
            if (events.Length == 0) throw new Exception("The live earthquake feed returned no usable events.");
            Console.WriteLine($"Live {events[0].Source} feed: {events.Length} valid earthquake reports.");
        }
    }

    private sealed class LiveClients : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new() { Timeout = TimeSpan.FromSeconds(20) };
    }

    public static void Run()
    {
        static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
        var now = DateTime.UtcNow;
        var device = new EarthquakeDevice { Latitude = -41.2865, Longitude = 174.7762, RadiusKm = 300,
            MinimumMagnitude = 4, EnabledAtUtc = now.AddMinutes(-10) };
        var nearby = new Earthquake("test", "GeoNet", 4.5, "Wellington", now.AddMinutes(-2), -41.3, 174.8, 12, "https://www.geonet.org.nz");
        var events = new[] { nearby, nearby with { Id = "far", Latitude = 0, Longitude = 0 },
            nearby with { Id = "small", Magnitude = 3.9 }, nearby with { Id = "old", TimeUtc = now.AddMinutes(-16) },
            nearby with { Id = "future", TimeUtc = now.AddSeconds(1) }, nearby with { Id = "before-enabled", TimeUtc = now.AddMinutes(-11) } };
        var matches = EarthquakeFeed.Nearby(events, device, now);
        Check(matches.Length == 1 && matches[0].Id == "test" && matches[0].DistanceKm is > 0 and < 5,
            "Distance, magnitude, age and activation filtering must all apply.");
        Check(EarthquakeFeed.DistanceKm(0, 179.9, 0, -179.9) is > 22 and < 23, "Distance must cross the date line correctly.");
        Check(EarthquakeFeed.UseGeoNet(-41, 175) && EarthquakeFeed.UseGeoNet(-40, -179)
            && !EarthquakeFeed.UseGeoNet(40, -122), "Use the local authoritative NZ feed in its region.");
        Check(!EarthquakeFeed.ValidLocation(double.NaN, 0) && !EarthquakeFeed.ValidLocation(91, 0), "Reject invalid GPS coordinates.");
        using var geoNet = JsonDocument.Parse("""
            {"features":[
              {"properties":{"publicID":"2026p123456","magnitude":4.8,"locality":"Near Wellington","time":"2026-10-22T00:00:00Z","depth":15,"quality":"automatic"},"geometry":{"coordinates":[174.7,-41.2]}},
              {"properties":{"quality":"deleted"}},
              {"properties":{"quality":"best","publicID":"bad","magnitude":null}}
            ]}
            """);
        var parsed = EarthquakeFeed.Parse(geoNet.RootElement, true);
        Check(parsed.Length == 1 && parsed[0].Id == "geonet:2026p123456" && parsed[0].DepthKm == 15
            && parsed[0].TimeUtc.Kind == DateTimeKind.Utc, "Parse GeoNet and ignore deleted or malformed reports.");
        using var usgs = JsonDocument.Parse("""
            {"features":[
              {"id":"us123","properties":{"type":"earthquake","mag":5.1,"place":"Test place","time":1792627200000},"geometry":{"coordinates":[-122,38,10]}},
              {"properties":{"type":"quarry blast"}},
              {"id":"bad","properties":{"type":"earthquake","mag":null}}
            ]}
            """);
        parsed = EarthquakeFeed.Parse(usgs.RootElement, false);
        Check(parsed.Length == 1 && parsed[0].Source == "USGS" && parsed[0].Latitude == 38 && parsed[0].Longitude == -122,
            "Parse USGS longitude/latitude in the correct order and reject non-earthquakes.");
        var keys = WebPush.VapidHelper.GenerateVapidKeys();
        var vapid = new WebPush.VapidDetails("mailto:test@example.com", keys.PublicKey, keys.PrivateKey);
        using var client = new WebPush.WebPushClient();
        using var pushRequest = client.GenerateRequestDetails(new WebPush.PushSubscription("https://push.example.com/test", "", ""),
            null, PushNotificationService.DeliveryOptions(vapid, true));
        Check(pushRequest.Headers.GetValues("TTL").Single() == "900" && pushRequest.Headers.GetValues("Urgency").Single() == "high",
            "Earthquake pushes need valid library options, a short expiry, and high urgency.");
        Check(!PushNotificationService.DeliveryOptions(vapid, false).ContainsKey("TTL"), "Keep the existing news push defaults.");
        Console.WriteLine("Earthquake feed and proximity checks passed.");
    }
}
