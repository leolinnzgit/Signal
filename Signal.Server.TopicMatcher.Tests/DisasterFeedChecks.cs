using System.Net;
using System.Xml;
using Signal.Server.Services;

internal static class DisasterFeedChecks
{
    public static async Task RunAsync(string? livePath = null)
    {
        static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
        static string Item(string type, string id, string lat = "-18", string current = "true") => $"""
            <item><title>Flood &amp; storm report</title><description>Source details</description>
            <link>http://www.gdacs.org/report.aspx?eventtype={type}&amp;eventid={id}</link>
            <gdacs:eventtype>{type}</gdacs:eventtype><gdacs:eventid>{id}</gdacs:eventid>
            <gdacs:iscurrent>{current}</gdacs:iscurrent><gdacs:alertlevel>Orange</gdacs:alertlevel>
            <gdacs:fromdate>Wed, 21 Oct 2026 15:00:00 GMT</gdacs:fromdate><gdacs:todate>Thu, 22 Oct 2026 21:00:00 GMT</gdacs:todate>
            <geo:Point><geo:lat>{lat}</geo:lat><geo:long>178</geo:long></geo:Point></item>
            """;
        static string Feed(string items) => $"""
            <rss xmlns:gdacs="http://www.gdacs.org" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#"><channel>{items}</channel></rss>
            """;
        var xml = Feed(Item("FL", "1") + Item("TC", "2") + Item("WF", "3") + Item("VO", "4") + Item("DR", "5")
            + Item("FL", "1") + Item("EQ", "6") + Item("FL", "7", "NaN") + Item("FL", "8", "91")
            + Item("FL", "9", current: "false"));
        var parsed = DisasterFeed.Parse(xml);
        Check(parsed.Length == 5, "Keep five valid, unique hazard reports; skip old episodes, earthquakes and invalid coordinates.");
        Check(parsed.Select(e => e.Kind).Distinct().Count() == 5, "All disaster categories must map correctly.");
        Check(parsed[0].Url.StartsWith("https://www.gdacs.org/report.aspx?"), "Upgrade GDACS report links to HTTPS.");
        Check(parsed[0].AlertLevel == "orange" && parsed[0].DistanceKm is null && parsed[0].Latitude == -18,
            "Preserve alert levels, nested point geometry and unknown distance.");
        Check(parsed[0].Title == "Flood & storm report" && parsed[0].TimeUtc.Kind == DateTimeKind.Utc, "Decode text and parse UTC dates.");
        try { DisasterFeed.Parse("<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///secret'>]><rss><channel>&x;</channel></rss>"); throw new Exception("DTD must be rejected."); }
        catch (XmlException) { }
        try { DisasterFeed.Parse("<html/>"); throw new Exception("Invalid feed must be rejected."); }
        catch (XmlException) { }
        var clients = new Clients(xml);
        var service = new DisasterFeed(clients);
        Check((await service.GetAsync(default)).Length == 5 && (await service.GetAsync(default)).Length == 5 && clients.Calls == 1,
            "Cache the shared disaster feed rather than refetching per device.");
        if (livePath is not null)
        {
            var live = DisasterFeed.Parse(await File.ReadAllTextAsync(livePath));
            Check(live.Length > 0 && live.Any(e => e.Kind == "flood"), "Live GDACS data must include usable flood reports.");
            Console.WriteLine($"Live GDACS feed parsed: {live.Length} reports ({string.Join(", ", live.GroupBy(e => e.Kind).Select(g => $"{g.Key}: {g.Count()}"))}).");
            var downloaded = await new DisasterFeed(new LiveClients()).GetAsync(default);
            Check(downloaded.Length > 0, "The server HTTP client must retrieve a usable GDACS feed.");
            Console.WriteLine($"Server HTTP client retrieved {downloaded.Length} GDACS reports.");
        }
        Console.WriteLine("Disaster parsing, validation and cache checks passed.");
    }
    private sealed class LiveClients : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new() { Timeout = TimeSpan.FromSeconds(20) };
    }
    private sealed class Clients(string xml) : IHttpClientFactory
    {
        public int Calls;
        public HttpClient CreateClient(string name) => new(new Handler(this, xml));
        private sealed class Handler(Clients parent, string xml) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            { parent.Calls++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(xml) }); }
        }
    }
}
