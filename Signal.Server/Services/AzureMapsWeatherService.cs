using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record WeatherAlert(
    string Id,
    string Category,
    string Level,
    string Source,
    string Headline,
    string Description,
    string AreaName,
    DateTimeOffset? EffectiveTime,
    DateTimeOffset? Expires
);

public sealed record WeatherAlertsResult(
    bool Available,
    string Message,
    WeatherAlert[] Alerts,
    DateTime CheckedAtUtc
);

public sealed class AzureMapsWeatherService(
    IOptions<AzureMapsOptions> options,
    IHttpClientFactory clients,
    IMemoryCache cache)
{
    public const string HttpClientName = "AzureMapsWeather";
    private readonly SemaphoreSlim gate = new(1, 1);

    public bool Enabled => options.Value.Enabled;

    public async Task<WeatherAlertsResult> GetAlertsAsync(double latitude, double longitude, CancellationToken token)
    {
        if (!Enabled)
            return new(false, "Azure Maps has not been configured yet.", [], DateTime.UtcNow);

        if (!EarthquakeFeed.ValidLocation(latitude, longitude))
            return new(false, "Invalid location coordinates.", [], DateTime.UtcNow);

        var roundedLat = Math.Round(latitude, 2);
        var roundedLon = Math.Round(longitude, 2);
        var cacheKey = $"azure-weather-alerts:{roundedLat:F2}:{roundedLon:F2}";

        if (cache.TryGetValue(cacheKey, out WeatherAlertsResult? cached) && cached is not null)
            return cached;

        await gate.WaitAsync(token);
        try
        {
            if (cache.TryGetValue(cacheKey, out cached) && cached is not null)
                return cached;

            var client = clients.CreateClient(HttpClientName);
            var key = Uri.EscapeDataString(options.Value.SubscriptionKey.Trim());
            var query = FormattableString.Invariant($"{latitude:F4},{longitude:F4}");
            var url = $"https://atlas.microsoft.com/weather/severe/alerts/json?api-version=1.1&query={query}&subscription-key={key}";

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Accept.ParseAdd("application/json");

            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                return new(false, $"Azure Maps returned status {(int)response.StatusCode}.", [], DateTime.UtcNow);
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var alerts = Parse(json.RootElement);

            var result = new WeatherAlertsResult(true, "", alerts, DateTime.UtcNow);
            cache.Set(cacheKey, result, TimeSpan.FromMinutes(15));
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return new(false, "Azure Maps weather alerts are temporarily unavailable.", [], DateTime.UtcNow);
        }
        finally
        {
            gate.Release();
        }
    }

    public static WeatherAlert[] Parse(JsonElement root)
    {
        var list = new List<WeatherAlert>();
        if (!root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            return [];

        foreach (var result in results.EnumerateArray())
        {
            try
            {
                var alertId = result.TryGetProperty("alertId", out var idProp) ? idProp.ToString() : Guid.NewGuid().ToString("N");
                var category = result.TryGetProperty("category", out var catProp) ? catProp.GetString() ?? "Weather Alert" : "Weather Alert";
                var level = result.TryGetProperty("level", out var lvlProp) ? lvlProp.GetString() ?? "Warning" : "Warning";
                var source = result.TryGetProperty("source", out var srcProp) ? srcProp.GetString() ?? "Meteorological Service" : "Meteorological Service";

                string headline = "";
                string description = "";
                string areaName = "";
                DateTimeOffset? effective = null;
                DateTimeOffset? expires = null;

                if (result.TryGetProperty("alertDetails", out var details) && details.ValueKind == JsonValueKind.Array)
                {
                    var first = details.EnumerateArray().FirstOrDefault();
                    if (first.ValueKind == JsonValueKind.Object)
                    {
                        areaName = first.TryGetProperty("areaName", out var aProp) ? aProp.GetString() ?? "" : "";
                        headline = first.TryGetProperty("headline", out var hProp) ? hProp.GetString() ?? "" : "";
                        description = first.TryGetProperty("description", out var dProp) ? dProp.GetString() ?? "" : "";
                        if (first.TryGetProperty("effectiveTime", out var effProp) && DateTimeOffset.TryParse(effProp.GetString(), out var effVal))
                            effective = effVal;
                        if (first.TryGetProperty("expires", out var expProp) && DateTimeOffset.TryParse(expProp.GetString(), out var expVal))
                            expires = expVal;
                    }
                }

                if (string.IsNullOrWhiteSpace(headline) && result.TryGetProperty("description", out var descObj))
                {
                    headline = descObj.TryGetProperty("localized", out var loc) ? loc.GetString() ?? "" : "";
                    if (string.IsNullOrWhiteSpace(headline))
                        headline = descObj.TryGetProperty("english", out var eng) ? eng.GetString() ?? "" : "";
                }

                if (string.IsNullOrWhiteSpace(headline))
                    headline = $"{level} {category}".Trim();

                list.Add(new WeatherAlert(alertId, category, level, source, headline, description, areaName, effective, expires));
            }
            catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException)
            {
                // Skip single malformed alert without suppressing others
            }
        }
        return list.ToArray();
    }
}
