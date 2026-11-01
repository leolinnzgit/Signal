using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class VoiceSearchChecks
{
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static byte[] CreateMinimalValidWavHeader()
    {
        var bytes = new byte[48];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(bytes, 0);
        BitConverter.GetBytes(40).CopyTo(bytes, 4);
        Encoding.ASCII.GetBytes("WAVE").CopyTo(bytes, 8);
        Encoding.ASCII.GetBytes("fmt ").CopyTo(bytes, 12);
        BitConverter.GetBytes(16).CopyTo(bytes, 16);
        BitConverter.GetBytes((short)1).CopyTo(bytes, 20);
        BitConverter.GetBytes((short)1).CopyTo(bytes, 22);
        BitConverter.GetBytes(16000).CopyTo(bytes, 24);
        BitConverter.GetBytes(32000).CopyTo(bytes, 28);
        BitConverter.GetBytes((short)2).CopyTo(bytes, 32);
        BitConverter.GetBytes((short)16).CopyTo(bytes, 34);
        Encoding.ASCII.GetBytes("data").CopyTo(bytes, 36);
        BitConverter.GetBytes(4).CopyTo(bytes, 40);
        return bytes;
    }

    public static async Task RunAsync()
    {
        // 1. Disabled / Windows speech provider state
        var disabledOpts = Options.Create(new AzureSpeechOptions { Provider = "Windows" });
        var transcriber = new AzureSpeechTranscriber(disabledOpts, new TestHttpClientFactory(), NullLogger<AzureSpeechTranscriber>.Instance);
        Require(!transcriber.Enabled, "Transcriber should be disabled when Speech provider is Windows.");

        // 2. Enabled Azure speech provider validation
        var validOpts = Options.Create(new AzureSpeechOptions
        {
            Provider = "Azure",
            Key = "0123456789abcdef0123456789abcdef",
            Region = "australiaeast"
        });
        var enabledTranscriber = new AzureSpeechTranscriber(validOpts, new TestHttpClientFactory(), NullLogger<AzureSpeechTranscriber>.Instance);
        Require(enabledTranscriber.Enabled, "Transcriber should be enabled when valid Azure Speech options are configured.");

        // 3. Language tag normalization & injection prevention
        Require(AzureSpeechTranscriber.NormalizeLanguage("en-US") == "en-US", "Valid BCP-47 tag should be preserved.");
        Require(AzureSpeechTranscriber.NormalizeLanguage("zh-TW") == "zh-TW", "Mandarin tag should be preserved.");
        Require(AzureSpeechTranscriber.NormalizeLanguage("") == "en-NZ", "Empty tag should default to en-NZ.");
        Require(AzureSpeechTranscriber.NormalizeLanguage("en-NZ& evil=1") == "en-NZ", "Malformed language tag should fall back safely to en-NZ.");

        // 4. WAV magic header validation
        var validWav = CreateMinimalValidWavHeader();
        Require(AzureSpeechTranscriber.IsValidWaveHeader(validWav), "Minimal PCM WAV header should pass validation.");
        Require(!AzureSpeechTranscriber.IsValidWaveHeader(new byte[10]), "Truncated payload should fail WAV validation.");
        Require(!AzureSpeechTranscriber.IsValidWaveHeader(Encoding.ASCII.GetBytes(new string('A', 64))), "Non-RIFF payload should fail WAV validation.");

        var disabledRes = await transcriber.TranscribeWaveAsync(validWav, "en-NZ", CancellationToken.None);
        Require(!disabledRes.Available && disabledRes.Status == "Disabled", "Unconfigured transcriber should return Disabled status.");

        // 5. Azure STT JSON response parsing
        const string successDetailedJson = """
        {
            "RecognitionStatus": "Success",
            "Offset": 1200000,
            "Duration": 18500000,
            "NBest": [
                {
                    "Confidence": 0.942,
                    "Lexical": "renewable energy",
                    "Display": "Renewable energy."
                }
            ]
        }
        """;
        using (var doc = JsonDocument.Parse(successDetailedJson))
        {
            var parsed = AzureSpeechTranscriber.Parse(doc.RootElement);
            Require(parsed.Available, "Detailed NBest Success JSON should return Available=true.");
            Require(parsed.Text == "Renewable energy.", $"Expected 'Renewable energy.', got '{parsed.Text}'.");
        }

        const string noMatchJson = """{ "RecognitionStatus": "NoMatch" }""";
        using (var doc = JsonDocument.Parse(noMatchJson))
        {
            var parsed = AzureSpeechTranscriber.Parse(doc.RootElement);
            Require(!parsed.Available && parsed.Status == "NoMatch", "NoMatch JSON should return Available=false.");
        }

        // 6. Controller validation
        var controller = new VoiceSearchController(transcriber);
        var badAudio = await controller.TranscribeBytesAsync([1, 2, 3], "en-NZ", CancellationToken.None);
        Require(badAudio is BadRequestObjectResult, "Invalid WAV bytes should return BadRequest from VoiceSearchController.");

        var okDisabled = await controller.TranscribeBytesAsync(validWav, "en-NZ", CancellationToken.None);
        Require(okDisabled is OkObjectResult, "Valid WAV bytes should return structured VoiceTranscriptionResult.");
    }

    private sealed class TestHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
