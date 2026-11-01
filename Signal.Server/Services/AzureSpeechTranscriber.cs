using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record VoiceTranscriptionResult(
    bool Available,
    string Text,
    string Status,
    string Reason
)
{
    public static VoiceTranscriptionResult Unavailable(string reason, string status = "Unavailable") =>
        new(false, "", status, reason);
}

public sealed partial class AzureSpeechTranscriber(
    IOptions<AzureSpeechOptions> speechOptions,
    IHttpClientFactory clients,
    ILogger<AzureSpeechTranscriber> logger)
{
    public const string HttpClientName = "AzureSpeechTranscriber";
    public const int MaxAudioBytes = 2_000_000;

    [GeneratedRegex("^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$")]
    private static partial Regex LanguageTagPattern();

    public bool Enabled
    {
        get
        {
            var opts = speechOptions.Value;
            if (!opts.Enabled) return false;
            try
            {
                opts.Validate();
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    public static string NormalizeLanguage(string? language)
    {
        var trimmed = (language ?? "").Trim();
        if (trimmed.Length == 0 || !LanguageTagPattern().IsMatch(trimmed))
            return "en-NZ";
        return trimmed;
    }

    public static bool IsValidWaveHeader(ReadOnlySpan<byte> audio)
    {
        if (audio.Length < 44 || audio.Length > MaxAudioBytes)
            return false;

        // RIFF....WAVE magic header
        return audio[0] == (byte)'R'
            && audio[1] == (byte)'I'
            && audio[2] == (byte)'F'
            && audio[3] == (byte)'F'
            && audio[8] == (byte)'W'
            && audio[9] == (byte)'A'
            && audio[10] == (byte)'V'
            && audio[11] == (byte)'E';
    }

    public async Task<VoiceTranscriptionResult> TranscribeWaveAsync(
        byte[] waveBytes,
        string? language,
        CancellationToken token)
    {
        if (waveBytes is null || !IsValidWaveHeader(waveBytes))
        {
            return VoiceTranscriptionResult.Unavailable("Invalid or empty WAV audio payload.", "InvalidAudio");
        }

        if (!Enabled)
        {
            return VoiceTranscriptionResult.Unavailable("Azure Speech recognition is not configured on this server.", "Disabled");
        }

        var opts = speechOptions.Value;
        var region = opts.Region.Trim().ToLowerInvariant();
        var lang = NormalizeLanguage(language);
        var endpoint = new Uri(
            $"https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language={Uri.EscapeDataString(lang)}&format=detailed");

        try
        {
            var client = clients.CreateClient(HttpClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Headers.Add("Ocp-Apim-Subscription-Key", opts.Key);
            request.Headers.Accept.ParseAdd("application/json");

            var content = new ByteArrayContent(waveBytes);
            content.Headers.ContentType = MediaTypeHeaderValue.Parse("audio/wav; codecs=audio/pcm; samplerate=16000");
            request.Content = content;

            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Azure Speech STT returned status {StatusCode}.", (int)response.StatusCode);
                return VoiceTranscriptionResult.Unavailable(
                    $"Speech recognition returned status {(int)response.StatusCode}.",
                    "HttpError");
            }

            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            return Parse(doc.RootElement);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Azure Speech STT transcription failed.");
            return VoiceTranscriptionResult.Unavailable("Voice transcription is temporarily unavailable.", "NetworkError");
        }
    }

    public static VoiceTranscriptionResult Parse(JsonElement root)
    {
        try
        {
            var status = root.TryGetProperty("RecognitionStatus", out var rs) && rs.ValueKind == JsonValueKind.String
                ? rs.GetString() ?? "Unknown"
                : "Unknown";

            if (!status.Equals("Success", StringComparison.OrdinalIgnoreCase))
            {
                var reason = status switch
                {
                    "NoMatch" => "No speech could be recognized. Please try speaking closer to the microphone.",
                    "InitialSilenceTimeout" => "No speech was heard before timeout.",
                    "BabbleTimeout" => "Background noise prevented clear recognition.",
                    _ => $"Speech recognition finished with status: {status}.",
                };
                return VoiceTranscriptionResult.Unavailable(reason, status);
            }

            var text = "";
            if (root.TryGetProperty("DisplayText", out var dt) && dt.ValueKind == JsonValueKind.String)
            {
                text = (dt.GetString() ?? "").Trim();
            }

            if (text.Length == 0
                && root.TryGetProperty("NBest", out var nbest)
                && nbest.ValueKind == JsonValueKind.Array)
            {
                foreach (var candidate in nbest.EnumerateArray())
                {
                    if (candidate.TryGetProperty("Display", out var disp) && disp.ValueKind == JsonValueKind.String)
                    {
                        text = (disp.GetString() ?? "").Trim();
                        if (text.Length > 0) break;
                    }
                    if (candidate.TryGetProperty("Lexical", out var lex) && lex.ValueKind == JsonValueKind.String)
                    {
                        text = (lex.GetString() ?? "").Trim();
                        if (text.Length > 0) break;
                    }
                }
            }

            if (text.Length == 0)
            {
                return VoiceTranscriptionResult.Unavailable("No words were detected in the recording.", "NoMatch");
            }

            return new VoiceTranscriptionResult(true, text, "Success", "");
        }
        catch
        {
            return VoiceTranscriptionResult.Unavailable("Failed to parse speech transcription response.", "ParseError");
        }
    }
}
