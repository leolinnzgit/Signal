using System.Net;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class WeatherLocationChecks
{
    private const string Hamilton = """{"features":[{"properties":{"type":"PopulatedPlace","address":{"locality":"Hamilton","countryRegion":{"name":"New Zealand"}}}}]}""";
    private static void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); }

    public static async Task RunAsync()
    {
        using (var json = JsonDocument.Parse(Hamilton))
            Check(WeatherLocationService.Parse(json.RootElement) == "Hamilton", "Resolve the municipality from coordinates.");
        foreach (var text in new[] { "null", "{}", "{\"features\":null}",
            """{"features":[{"properties":{"type":"AdminDivision1","address":{"locality":"Waikato"}}}]}""",
            """{"features":[{"properties":{"type":"PopulatedPlace","address":{"countryRegion":{"name":"New Zealand"}}}}]}""" })
        {
            using var json = JsonDocument.Parse(text);
            Check(WeatherLocationService.Parse(json.RootElement) is null, "A region or country must not replace a missing town.");
        }

        var clients = new Clients(Hamilton);
        var settings = Options.Create(new AzureMapsOptions { SubscriptionKey = "test-weather-location-subscription" });
        using var service = new WeatherLocationService(clients, settings);
        var names = await Task.WhenAll(service.GetAsync(-37.787123, 175.279345, default), service.GetAsync(-37.787124, 175.279346, default));
        Check(names.All(name => name == "Hamilton") && clients.Calls == 1, "Concurrent requests for the same rounded location share a cached town lookup.");
        Check(clients.LastUri!.Host == "atlas.microsoft.com" && clients.LastUri.Query.Contains("coordinates=175.279%2C-37.787")
            && clients.LastUri.Query.Contains("resultTypes=PopulatedPlace"), "Use longitude/latitude order and town-level results.");
        Check(!clients.LastUri.ToString().Contains(settings.Value.SubscriptionKey) && clients.KeyHeaderPresent,
            "The Azure key belongs in the server request header, not the URL or client response.");
        await service.GetAsync(-41.2865, 174.7762, default);
        Check(clients.Calls == 2, "Moving to a different location requires a fresh town lookup.");
        foreach (var point in new[] { (double.NaN, 1d), (91d, 1d), (1d, 181d) })
        {
            try { await service.GetAsync(point.Item1, point.Item2, default); throw new Exception("Invalid coordinates were accepted."); }
            catch (ArgumentException) { }
        }
        Check(clients.Calls == 2, "Invalid coordinates never reach Azure.");
        using var disabled = new WeatherLocationService(clients, Options.Create(new AzureMapsOptions()));
        Check(await disabled.GetAsync(-37.787, 175.279, default) is null && clients.Calls == 2,
            "An unconfigured geocoder leaves the weather fallback available without external requests.");

        using var empty = new WeatherLocationService(new Clients("{\"features\":[]}"), settings);
        Check(await empty.GetAsync(-37.787, 175.279, default) is null, "Unknown towns remain unknown.");
        Check(typeof(WeatherController).GetCustomAttribute<AuthorizeAttribute>() is not null, "Town lookups require an authenticated Signal session.");
        var controller = new WeatherController(service);
        Check(await controller.Location(null, 175.279, default) is BadRequestObjectResult
            && await controller.Location(-37.787, 181, default) is BadRequestObjectResult, "Reject missing and invalid API coordinates.");
        using var failed = new WeatherLocationService(new Clients("{}", HttpStatusCode.ServiceUnavailable), settings);
        Check(await new WeatherController(failed).Location(-37.787, 175.279, default) is ObjectResult { StatusCode: 503 },
            "Provider outages return a recoverable result without exposing provider details.");
        Console.WriteLine("Weather town lookup parsing, coordinate precision, caching, authentication and fallback checks passed.");
    }

    private sealed class Clients(string body, HttpStatusCode status = HttpStatusCode.OK) : IHttpClientFactory
    {
        public int Calls;
        public Uri? LastUri;
        public bool KeyHeaderPresent;
        public HttpClient CreateClient(string name) => new(new Handler(this, body, status));
        private sealed class Handler(Clients parent, string body, HttpStatusCode status) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                parent.Calls++;
                parent.LastUri = request.RequestUri;
                parent.KeyHeaderPresent = request.Headers.Contains("subscription-key");
                return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
            }
        }
    }
}
