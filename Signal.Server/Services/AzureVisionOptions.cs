namespace Signal.Server.Services;

public sealed class AzureVisionOptions
{
    public const string SectionName = "AzureVision";
    public string Endpoint { get; set; } = "";
    public string Key { get; set; } = "";
    public bool Enabled => !string.IsNullOrWhiteSpace(Endpoint) && !string.IsNullOrWhiteSpace(Key);

    internal Uri Validate()
    {
        if (!Uri.TryCreate(Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || uri.AbsolutePath != "/" || !uri.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase)
            || Key.Length is < 20 or > 256 || Key.Any(char.IsWhiteSpace) || Key.Any(char.IsControl))
            throw new InvalidOperationException("Azure Vision requires a valid Cognitive Services endpoint and key.");
        return uri;
    }
}
