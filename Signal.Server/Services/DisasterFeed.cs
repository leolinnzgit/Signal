using System.Globalization;
using System.Xml;
using System.Xml.Linq;

namespace Signal.Server.Services;

public sealed record DisasterEvent(string Id, string Kind, string Source, string Title, string Description,
    string AlertLevel, DateTime TimeUtc, DateTime? EndTimeUtc, double Latitude, double Longitude, string Url,
    double? DistanceKm = null, DateTime? UpdatedAtUtc = null, string Episode = "");

public sealed class DisasterFeed(IHttpClientFactory clients)
{
    private readonly SemaphoreSlim gate = new(1);
    private DateTime fetched;
    private DisasterEvent[] cache = [];

    public async Task<DisasterEvent[]> GetAsync(CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (DateTime.UtcNow - fetched < TimeSpan.FromMinutes(6)) return cache;
            using var client = clients.CreateClient("disasters");
            using var response = await client.GetAsync("https://www.gdacs.org/xml/rss_7d.xml", ct);
            response.EnsureSuccessStatusCode();
            var events = Parse(await response.Content.ReadAsStringAsync(ct));
            cache = events;
            fetched = DateTime.UtcNow;
            return events;
        }
        finally { gate.Release(); }
    }

    public static DisasterEvent[] Parse(string xml)
    {
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8_000_000
        });
        var document = XDocument.Load(reader);
        if (document.Root?.Name.LocalName != "rss" || document.Root.Element("channel") is null)
            throw new XmlException("Invalid GDACS feed.");
        XNamespace gdacs = "http://www.gdacs.org";
        XNamespace geo = "http://www.w3.org/2003/01/geo/wgs84_pos#";
        var events = new List<DisasterEvent>();
        foreach (var item in document.Descendants("item"))
        {
            string Value(string name) => (string?)item.Element(gdacs + name) ?? "";
            var kind = Value("eventtype") switch
            {
                "FL" => "flood", "TC" => "storm", "WF" => "wildfire", "VO" => "volcano", "DR" => "drought", _ => ""
            };
            if (kind.Length == 0 || Value("eventid").Length == 0) continue;
            if (Value("iscurrent").Equals("false", StringComparison.OrdinalIgnoreCase)) continue;
            if (!double.TryParse((string?)item.Descendants(geo + "lat").FirstOrDefault(), CultureInfo.InvariantCulture, out var lat)
                || !double.TryParse((string?)item.Descendants(geo + "long").FirstOrDefault(), CultureInfo.InvariantCulture, out var lon)
                || !EarthquakeFeed.ValidLocation(lat, lon)) continue;
            const DateTimeStyles styles = DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal;
            if (!DateTime.TryParse(Value("fromdate"), CultureInfo.InvariantCulture, styles, out var start)) continue;
            DateTime? end = DateTime.TryParse(Value("todate"), CultureInfo.InvariantCulture, styles, out var endDate) ? endDate : null;
            var updated = DateTime.TryParse(Value("datemodified"), CultureInfo.InvariantCulture, styles, out var modified) ? modified
                : DateTime.TryParse((string?)item.Element("pubDate"), CultureInfo.InvariantCulture, styles, out var published) ? published : start;
            var link = (string?)item.Element("link") ?? "";
            if (Uri.TryCreate(link, UriKind.Absolute, out var legacy) && legacy.Scheme == "http"
                && (legacy.Host == "www.gdacs.org" || legacy.Host == "gdacs.org"))
                link = new UriBuilder(legacy) { Scheme = "https", Port = -1 }.Uri.AbsoluteUri;
            if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || uri.Scheme != "https") link = "https://www.gdacs.org/";
            var alert = Value("alertlevel").ToLowerInvariant();
            events.Add(new DisasterEvent($"gdacs:{Value("eventtype")}:{Value("eventid")}", kind, "GDACS",
                (string?)item.Element("title") ?? "Disaster report", (string?)item.Element("description") ?? "",
                alert is "green" or "orange" or "red" ? alert : "unknown", start, end, lat, lon, link,
                UpdatedAtUtc: updated, Episode: Value("episodeid")));
        }
        return events.GroupBy(e => e.Id).Select(g => g.OrderByDescending(e => e.UpdatedAtUtc ?? e.TimeUtc).First())
            .OrderByDescending(e => e.TimeUtc).ToArray();
    }
}
