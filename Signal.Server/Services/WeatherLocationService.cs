using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class WeatherLocationService(IHttpClientFactory clients, IOptions<AzureMapsOptions> maps) : IDisposable
{
    public const string HttpClientName = "weather-location";
    private readonly MemoryCache cache = new(new MemoryCacheOptions { SizeLimit = 512 });
    private readonly SemaphoreSlim gate = new(1);

    public async Task<string?> GetAsync(double latitude, double longitude, CancellationToken ct)
    {
        if (!EarthquakeFeed.ValidLocation(latitude, longitude))
            throw new ArgumentException("Choose valid latitude and longitude coordinates.");
        if (!maps.Value.Enabled) return null;

        // Town lookup needs about 100 m precision, not the device's exact position.
        var point = string.Create(CultureInfo.InvariantCulture, $"{Math.Round(longitude, 3):F3},{Math.Round(latitude, 3):F3}");
        if (cache.TryGetValue(point, out string? saved)) return saved;
        await gate.WaitAsync(ct);
        try
        {
            if (cache.TryGetValue(point, out saved)) return saved;
            using var client = clients.CreateClient(HttpClientName);
            using var request = new HttpRequestMessage(HttpMethod.Get,
                "https://atlas.microsoft.com/reverseGeocode?api-version=2026-01-01&resultTypes=PopulatedPlace&coordinates="
                + Uri.EscapeDataString(point));
            request.Headers.Add("subscription-key", maps.Value.SubscriptionKey);
            using var response = await client.SendAsync(request, ct);
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var name = Parse(document.RootElement);
            cache.Set(point, name, new MemoryCacheEntryOptions
            {
                Size = 1,
                AbsoluteExpirationRelativeToNow = name is null ? TimeSpan.FromMinutes(5) : TimeSpan.FromHours(1)
            });
            return name;
        }
        finally { gate.Release(); }
    }

    public static string? Parse(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("features", out var features)
            || features.ValueKind != JsonValueKind.Array) return null;
        foreach (var feature in features.EnumerateArray())
        {
            if (feature.ValueKind != JsonValueKind.Object || !feature.TryGetProperty("properties", out var properties)
                || properties.ValueKind != JsonValueKind.Object || !properties.TryGetProperty("type", out var type)
                || type.ValueKind != JsonValueKind.String || type.GetString() != "PopulatedPlace"
                || !properties.TryGetProperty("address", out var address) || address.ValueKind != JsonValueKind.Object
                || !address.TryGetProperty("locality", out var locality) || locality.ValueKind != JsonValueKind.String) continue;
            var name = string.Join(' ', (locality.GetString() ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            if (name.Length is > 0 and <= 120 && !name.Any(char.IsControl)) return name;
        }
        return null;
    }

    public void Dispose() { cache.Dispose(); gate.Dispose(); }
}
