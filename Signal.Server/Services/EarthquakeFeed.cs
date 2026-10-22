using System.Globalization;
using System.Text.Json;

namespace Signal.Server.Services;

public sealed record Earthquake(string Id, string Source, double Magnitude, string Place,
    DateTime TimeUtc, double Latitude, double Longitude, double DepthKm, string Url, double DistanceKm = 0);

public sealed class EarthquakeFeed(IHttpClientFactory clients)
{
    private readonly SemaphoreSlim gate = new(1);
    private readonly Dictionary<bool, (DateTime Fetched, Earthquake[] Events)> cache = [];

    public static bool UseGeoNet(double latitude, double longitude) =>
        latitude is >= -49 and <= -30 && (longitude >= 160 || longitude <= -175);

    public async Task<Earthquake[]> GetAsync(double latitude, double longitude, CancellationToken cancellationToken)
    {
        var geoNet = UseGeoNet(latitude, longitude);
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (cache.TryGetValue(geoNet, out var saved) && DateTime.UtcNow - saved.Fetched < TimeSpan.FromSeconds(55))
                return saved.Events;
            using var client = clients.CreateClient("earthquakes");
            using var request = new HttpRequestMessage(HttpMethod.Get, geoNet
                ? "https://api.geonet.org.nz/quake?MMI=-1"
                : "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson");
            request.Headers.Accept.ParseAdd(geoNet ? "application/vnd.geo+json;version=2" : "application/geo+json");
            using var response = await client.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var events = Parse(json.RootElement, geoNet);
            cache[geoNet] = (DateTime.UtcNow, events);
            return events;
        }
        finally { gate.Release(); }
    }

    public static Earthquake[] Parse(JsonElement root, bool geoNet)
    {
        var result = new List<Earthquake>();
        foreach (var feature in root.GetProperty("features").EnumerateArray())
        {
            try
            {
                var p = feature.GetProperty("properties");
                if (geoNet && p.GetProperty("quality").GetString() == "deleted") continue;
                if (!geoNet && p.GetProperty("type").GetString() != "earthquake") continue;
                var coordinates = feature.GetProperty("geometry").GetProperty("coordinates");
                var id = geoNet ? p.GetProperty("publicID").GetString()! : feature.GetProperty("id").GetString()!;
                var magnitude = p.GetProperty(geoNet ? "magnitude" : "mag").GetDouble();
                var lat = coordinates[1].GetDouble();
                var lon = coordinates[0].GetDouble();
                if (!double.IsFinite(magnitude) || !ValidLocation(lat, lon) || string.IsNullOrWhiteSpace(id)) continue;
                var time = geoNet
                    ? DateTime.Parse(p.GetProperty("time").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal)
                    : DateTimeOffset.FromUnixTimeMilliseconds(p.GetProperty("time").GetInt64()).UtcDateTime;
                result.Add(new Earthquake((geoNet ? "geonet:" : "usgs:") + id, geoNet ? "GeoNet" : "USGS", magnitude,
                    p.GetProperty(geoNet ? "locality" : "place").GetString() ?? "Unknown location", time, lat, lon,
                    geoNet ? p.GetProperty("depth").GetDouble() : coordinates[2].GetDouble(),
                    geoNet ? $"https://www.geonet.org.nz/earthquake/{Uri.EscapeDataString(id)}"
                        : $"https://earthquake.usgs.gov/earthquakes/eventpage/{Uri.EscapeDataString(id)}"));
            }
            catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException or ArgumentException or IndexOutOfRangeException)
            { /* A malformed event must not suppress the rest of the feed. */ }
        }
        return result.ToArray();
    }

    public static bool ValidLocation(double latitude, double longitude) =>
        double.IsFinite(latitude) && double.IsFinite(longitude) && latitude is >= -90 and <= 90 && longitude is >= -180 and <= 180;

    public static double DistanceKm(double latitude, double longitude, double otherLatitude, double otherLongitude)
    {
        static double Radians(double degrees) => degrees * Math.PI / 180;
        var a = Math.Pow(Math.Sin(Radians(otherLatitude - latitude) / 2), 2)
            + Math.Cos(Radians(latitude)) * Math.Cos(Radians(otherLatitude)) * Math.Pow(Math.Sin(Radians(otherLongitude - longitude) / 2), 2);
        return 6371 * 2 * Math.Asin(Math.Sqrt(Math.Clamp(a, 0, 1)));
    }

    public static Earthquake[] Nearby(IEnumerable<Earthquake> events, Models.EarthquakeDevice device, DateTime now) => events
        .Where(e => e.TimeUtc >= now.AddMinutes(-15) && e.TimeUtc >= device.EnabledAtUtc && e.TimeUtc <= now
            && e.Magnitude >= device.MinimumMagnitude)
        .Select(e => e with { DistanceKm = DistanceKm(device.Latitude, device.Longitude, e.Latitude, e.Longitude) })
        .Where(e => e.DistanceKm <= device.RadiusKm).OrderBy(e => e.TimeUtc).ToArray();
}
