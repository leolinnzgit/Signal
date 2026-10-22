namespace Signal.Server.Models;

public sealed class EarthquakeDevice
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public double RadiusKm { get; set; } = 300;
    public double MinimumMagnitude { get; set; } = 4;
    public DateTime LocationUpdatedAtUtc { get; set; }
    public DateTime EnabledAtUtc { get; set; }
    public string PushEndpoint { get; set; } = "";
    public string SeenJson { get; set; } = "[]";
}
