using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
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

public sealed record WeatherConditions(
    bool Available,
    string Message,
    int? UvIndex,
    string UvCategory,
    int? AirQualityIndex,
    string AirQualityCategory,
    string DominantPollutant,
    string AirQualityDescription,
    DateTime CheckedAtUtc
);

public sealed record MinuteForecastInterval(
    int Minute,
    DateTimeOffset? StartTime,
    double Dbz,
    string ShortPhrase,
    string PrecipitationType,
    string ColorHex
);

public sealed record MinuteForecastResult(
    bool Available,
    string Message,
    string Summary,
    string BriefPhrase60,
    string LongPhrase,
    bool HasPrecipitation,
    bool IsRainingNow,
    int? StartsInMinutes,
    int? EndsInMinutes,
    int? DurationMinutes,
    double MaxDbz,
    string PrecipitationType,
    string AlertState,
    MinuteForecastInterval[] Intervals,
    DateTime CheckedAtUtc
);

public sealed class AzureMapsWeatherService(
    IOptions<AzureMapsOptions> options,
    IHttpClientFactory clients,
    IMemoryCache cache)
{
    public const string HttpClientName = "AzureMapsWeather";
    // Azure Maps' free tier is shared by alerts (polled by the background disaster monitor every minute),
    // the client weather card, and current conditions. Long cache windows keep one location well inside it:
    // alerts ≈ 48 calls/day, conditions ≈ 2 calls/hour of active use.
    public static readonly TimeSpan AlertCacheDuration = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan ConditionsCacheDuration = TimeSpan.FromMinutes(60);
    public static readonly TimeSpan MinuteForecastCacheDuration = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan FailureCacheDuration = TimeSpan.FromMinutes(5);
    private static readonly Regex HexColorRegex = new(@"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", RegexOptions.Compiled);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly SemaphoreSlim conditionsGate = new(1, 1);
    private readonly SemaphoreSlim minuteGate = new(1, 1);

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
                // Cache failures briefly so a quota (429) or outage is not retried every monitor tick.
                var failed = new WeatherAlertsResult(false, $"Azure Maps returned status {(int)response.StatusCode}.", [], DateTime.UtcNow);
                cache.Set(cacheKey, failed, FailureCacheDuration);
                return failed;
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var alerts = Parse(json.RootElement);

            var result = new WeatherAlertsResult(true, "", alerts, DateTime.UtcNow);
            cache.Set(cacheKey, result, AlertCacheDuration);
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

    public async Task<WeatherConditions> GetConditionsAsync(double latitude, double longitude, CancellationToken token)
    {
        if (!Enabled)
            return EmptyConditions("Azure Maps has not been configured yet.");
        if (!EarthquakeFeed.ValidLocation(latitude, longitude))
            return EmptyConditions("Invalid location coordinates.");

        var cacheKey = FormattableString.Invariant($"azure-weather-conditions:{Math.Round(latitude, 2):F2}:{Math.Round(longitude, 2):F2}");
        if (cache.TryGetValue(cacheKey, out WeatherConditions? cached) && cached is not null)
            return cached;

        await conditionsGate.WaitAsync(token);
        try
        {
            if (cache.TryGetValue(cacheKey, out cached) && cached is not null)
                return cached;

            var current = FetchJsonAsync("weather/currentConditions/json", latitude, longitude, token);
            var air = FetchJsonAsync("weather/airQuality/current/json", latitude, longitude, token);
            await Task.WhenAll(current, air);

            var (uv, _) = ParseUv(await current);
            var airQuality = ParseAirQuality(await air);
            var available = uv.HasValue || airQuality.Index.HasValue;
            var result = new WeatherConditions(
                available,
                available ? "" : "Azure Maps current conditions are temporarily unavailable.",
                uv, UvCategory(uv),
                airQuality.Index, airQuality.Category, airQuality.DominantPollutant, airQuality.Description,
                DateTime.UtcNow);
            cache.Set(cacheKey, result, available ? ConditionsCacheDuration : FailureCacheDuration);
            return result;
        }
        finally
        {
            conditionsGate.Release();
        }
    }

    private async Task<JsonElement?> FetchJsonAsync(string path, double latitude, double longitude, CancellationToken token)
    {
        try
        {
            var client = clients.CreateClient(HttpClientName);
            var key = Uri.EscapeDataString(options.Value.SubscriptionKey.Trim());
            var query = FormattableString.Invariant($"{latitude:F4},{longitude:F4}");
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"https://atlas.microsoft.com/{path}?api-version=1.1&query={query}&subscription-key={key}");
            request.Headers.Accept.ParseAdd("application/json");
            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode) return null;
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            return json.RootElement.Clone();
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException && !token.IsCancellationRequested)
        {
            return null;
        }
    }

    public async Task<MinuteForecastResult> GetMinuteForecastAsync(double latitude, double longitude, CancellationToken token)
    {
        if (!Enabled)
            return EmptyMinuteForecast("Azure Maps has not been configured yet.");
        if (!EarthquakeFeed.ValidLocation(latitude, longitude))
            return EmptyMinuteForecast("Invalid location coordinates.");

        var cacheKey = FormattableString.Invariant($"azure-weather-minute:{Math.Round(latitude, 2):F2}:{Math.Round(longitude, 2):F2}");
        if (cache.TryGetValue(cacheKey, out MinuteForecastResult? cached) && cached is not null)
            return cached;

        await minuteGate.WaitAsync(token);
        try
        {
            if (cache.TryGetValue(cacheKey, out cached) && cached is not null)
                return cached;

            var client = clients.CreateClient(HttpClientName);
            var key = Uri.EscapeDataString(options.Value.SubscriptionKey.Trim());
            var query = FormattableString.Invariant($"{latitude:F4},{longitude:F4}");
            var url = $"https://atlas.microsoft.com/weather/forecast/minute/json?api-version=1.1&query={query}&interval=5&subscription-key={key}";

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Accept.ParseAdd("application/json");

            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                var failed = EmptyMinuteForecast($"Azure Maps returned status {(int)response.StatusCode}.");
                cache.Set(cacheKey, failed, FailureCacheDuration);
                return failed;
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var result = ParseMinuteForecast(json.RootElement);
            cache.Set(cacheKey, result, result.Available ? MinuteForecastCacheDuration : FailureCacheDuration);
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException && !token.IsCancellationRequested)
        {
            return EmptyMinuteForecast("Azure Maps minute-by-minute precipitation is temporarily unavailable.");
        }
        finally
        {
            minuteGate.Release();
        }
    }

    public static MinuteForecastResult EmptyMinuteForecast(string message) =>
        new(false, message, "", "", "", false, false, null, null, null, 0, "", "none", [], DateTime.UtcNow);

    public static MinuteForecastResult ParseMinuteForecast(JsonElement root, DateTime? checkedAtUtc = null)
    {
        var timestamp = checkedAtUtc ?? DateTime.UtcNow;
        if (root.ValueKind != JsonValueKind.Object)
            return EmptyMinuteForecast("Minute-by-minute precipitation is not available for this location.") with { CheckedAtUtc = timestamp };

        static string ReadString(JsonElement obj, string name) =>
            obj.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String
                ? prop.GetString()?.Trim() ?? ""
                : "";

        var shortSummary = "";
        var briefPhrase60 = "";
        var briefPhrase = "";
        var longPhrase = "";
        if (root.TryGetProperty("summary", out var summaryObj) && summaryObj.ValueKind == JsonValueKind.Object)
        {
            shortSummary = ReadString(summaryObj, "shortPhrase");
            briefPhrase60 = ReadString(summaryObj, "briefPhrase60");
            briefPhrase = ReadString(summaryObj, "briefPhrase");
            longPhrase = ReadString(summaryObj, "longPhrase");
        }

        var intervals = new List<MinuteForecastInterval>();
        if (root.TryGetProperty("intervals", out var intervalsProp) && intervalsProp.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var item in intervalsProp.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    index++;
                    continue;
                }

                var minute = item.TryGetProperty("minute", out var minProp) && minProp.TryGetInt32(out var parsedMin)
                    ? Math.Max(0, parsedMin)
                    : index * 5;
                DateTimeOffset? startTime = null;
                var startStr = ReadString(item, "startTime");
                if (startStr.Length > 0 && DateTimeOffset.TryParse(startStr, out var parsedStart))
                    startTime = parsedStart;

                var dbz = item.TryGetProperty("dbz", out var dbzProp) && dbzProp.TryGetDouble(out var parsedDbz) && double.IsFinite(parsedDbz)
                    ? Math.Max(0, parsedDbz)
                    : 0.0;
                var intervalPhrase = ReadString(item, "shortPhrase");
                var precipType = ReadString(item, "precipitationType").ToLowerInvariant();
                var colorHex = "";
                if (item.TryGetProperty("color", out var colorObj) && colorObj.ValueKind == JsonValueKind.Object)
                {
                    var candidateHex = ReadString(colorObj, "hex");
                    if (HexColorRegex.IsMatch(candidateHex))
                        colorHex = candidateHex;
                }

                intervals.Add(new MinuteForecastInterval(minute, startTime, Math.Round(dbz, 1), intervalPhrase, precipType, colorHex));
                index++;
            }
        }

        var hasAnySummary = shortSummary.Length > 0 || briefPhrase60.Length > 0 || briefPhrase.Length > 0 || longPhrase.Length > 0;
        if (intervals.Count == 0 && !hasAnySummary)
            return EmptyMinuteForecast("Minute-by-minute precipitation is not available for this location.") with { CheckedAtUtc = timestamp };

        static bool IsWet(MinuteForecastInterval interval) =>
            interval.Dbz > 0 && (!string.IsNullOrWhiteSpace(interval.PrecipitationType) || interval.Dbz >= 5.0);

        var stepMinutes = intervals.Count >= 2 && intervals[1].Minute > intervals[0].Minute
            ? intervals[1].Minute - intervals[0].Minute
            : 5;

        var firstWetIndex = intervals.FindIndex(IsWet);
        var hasPrecipitation = firstWetIndex >= 0;
        var isRainingNow = firstWetIndex == 0;
        int? startsInMinutes = null;
        int? endsInMinutes = null;
        int? durationMinutes = null;
        var precipitationType = "";

        if (hasPrecipitation)
        {
            startsInMinutes = isRainingNow ? 0 : intervals[firstWetIndex].Minute;

            var firstDryAfterWet = -1;
            for (var i = firstWetIndex + 1; i < intervals.Count; i++)
            {
                if (!IsWet(intervals[i]))
                {
                    firstDryAfterWet = i;
                    break;
                }
            }

            if (firstDryAfterWet >= 0)
            {
                endsInMinutes = intervals[firstDryAfterWet].Minute;
                durationMinutes = Math.Max(stepMinutes, endsInMinutes.Value - startsInMinutes.Value);
            }
            else
            {
                var lastMinute = intervals[^1].Minute + stepMinutes;
                durationMinutes = Math.Max(stepMinutes, lastMinute - startsInMinutes.Value);
            }

            for (var i = firstWetIndex; i < (firstDryAfterWet >= 0 ? firstDryAfterWet : intervals.Count); i++)
            {
                if (!string.IsNullOrWhiteSpace(intervals[i].PrecipitationType))
                {
                    precipitationType = intervals[i].PrecipitationType;
                    break;
                }
            }
            if (precipitationType.Length == 0)
                precipitationType = "rain";
        }

        var maxDbz = intervals.Count > 0 ? Math.Round(intervals.Max(i => i.Dbz), 1) : 0.0;
        var alertState = !hasPrecipitation
            ? "none"
            : isRainingNow
                ? (endsInMinutes.HasValue ? "ongoing-ending" : "ongoing")
                : (startsInMinutes <= 60 ? "starting-soon" : "starting-later");

        var precipLabel = precipitationType switch
        {
            "snow" => "Snow",
            "ice" => "Ice",
            "mix" => "Wintry mix",
            _ => "Rain",
        };

        var primarySummary = !string.IsNullOrWhiteSpace(shortSummary)
            ? shortSummary
            : !string.IsNullOrWhiteSpace(briefPhrase60)
                ? briefPhrase60
                : !string.IsNullOrWhiteSpace(briefPhrase)
                    ? briefPhrase
                    : alertState switch
                    {
                        "starting-soon" or "starting-later" when startsInMinutes.HasValue => $"{precipLabel} starting in {startsInMinutes.Value} min",
                        "ongoing-ending" when endsInMinutes.HasValue => $"{precipLabel} ending in {endsInMinutes.Value} min",
                        "ongoing" => $"{precipLabel} continuing",
                        _ => "No precipitation expected for 2 hours",
                    };

        var effectiveBrief60 = !string.IsNullOrWhiteSpace(briefPhrase60)
            ? briefPhrase60
            : !string.IsNullOrWhiteSpace(briefPhrase)
                ? briefPhrase
                : primarySummary;

        var effectiveLong = !string.IsNullOrWhiteSpace(longPhrase) ? longPhrase : effectiveBrief60;

        return new MinuteForecastResult(
            Available: true,
            Message: "",
            Summary: primarySummary,
            BriefPhrase60: effectiveBrief60,
            LongPhrase: effectiveLong,
            HasPrecipitation: hasPrecipitation,
            IsRainingNow: isRainingNow,
            StartsInMinutes: startsInMinutes,
            EndsInMinutes: endsInMinutes,
            DurationMinutes: durationMinutes,
            MaxDbz: maxDbz,
            PrecipitationType: precipitationType,
            AlertState: alertState,
            Intervals: intervals.ToArray(),
            CheckedAtUtc: timestamp);
    }

    private static WeatherConditions EmptyConditions(string message) =>
        new(false, message, null, "", null, "", "", "", DateTime.UtcNow);

    /// <summary>Responses may wrap the reading in a <c>results</c> array; accept either shape.</summary>
    private static JsonElement? FirstReading(JsonElement? root)
    {
        if (root is not { ValueKind: JsonValueKind.Object } value) return null;
        if (value.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
        {
            var first = results.EnumerateArray().FirstOrDefault();
            return first.ValueKind == JsonValueKind.Object ? first : null;
        }
        return value;
    }

    public static (int? Index, string Phrase) ParseUv(JsonElement? root)
    {
        var reading = FirstReading(root);
        if (reading is not { } r || !r.TryGetProperty("uvIndex", out var uv) || !uv.TryGetDouble(out var value)
            || value is < 0 or > 20)
            return (null, "");
        var phrase = r.TryGetProperty("uvIndexPhrase", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
        return ((int)Math.Round(value), phrase);
    }

    public static (int? Index, string Category, string DominantPollutant, string Description) ParseAirQuality(JsonElement? root)
    {
        var reading = FirstReading(root);
        if (reading is not { } r) return (null, "", "", "");
        double? index = null;
        foreach (var name in new[] { "globalIndex", "index" })
        {
            if (r.TryGetProperty(name, out var prop) && prop.TryGetDouble(out var value) && value is >= 0 and <= 1000)
            {
                index = value;
                break;
            }
        }
        if (index is null) return (null, "", "", "");
        static string Text(JsonElement element, string name) =>
            element.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String ? prop.GetString()?.Trim() ?? "" : "";
        return ((int)Math.Round(index.Value), Text(r, "category"), Text(r, "dominantPollutant"), Text(r, "description"));
    }

    /// <summary>WHO UV index bands, computed locally so the card and spoken briefing always agree.</summary>
    public static string UvCategory(int? uv) => uv switch
    {
        null => "",
        <= 2 => "Low",
        <= 5 => "Moderate",
        <= 7 => "High",
        <= 10 => "Very high",
        _ => "Extreme",
    };

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
