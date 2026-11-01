using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/voice-search")]
[EnableRateLimiting("audio")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class VoiceSearchController(AzureSpeechTranscriber transcriber) : ControllerBase
{
    [HttpGet("status")]
    public IActionResult Status() => Ok(new { azureEnabled = transcriber.Enabled });

    [HttpPost("transcribe")]
    [RequestSizeLimit(2_500_000)]
    public async Task<IActionResult> Transcribe([FromQuery] string? language, CancellationToken token)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[16_384];
        int totalRead = 0;

        while (true)
        {
            var read = await Request.Body.ReadAsync(chunk, token);
            if (read <= 0) break;
            totalRead += read;
            if (totalRead > AzureSpeechTranscriber.MaxAudioBytes)
            {
                return BadRequest(new { error = "Voice recording exceeds maximum size (2 MB)." });
            }
            buffer.Write(chunk, 0, read);
        }

        var waveBytes = buffer.ToArray();
        if (!AzureSpeechTranscriber.IsValidWaveHeader(waveBytes))
        {
            return BadRequest(new { error = "A valid WAV audio recording is required." });
        }

        var result = await transcriber.TranscribeWaveAsync(waveBytes, language, token);
        return Ok(result);
    }

    internal async Task<IActionResult> TranscribeBytesAsync(byte[] waveBytes, string? language, CancellationToken token)
    {
        if (waveBytes is null || waveBytes.Length > AzureSpeechTranscriber.MaxAudioBytes || !AzureSpeechTranscriber.IsValidWaveHeader(waveBytes))
        {
            return BadRequest(new { error = "A valid WAV audio recording is required." });
        }

        var result = await transcriber.TranscribeWaveAsync(waveBytes, language, token);
        return Ok(result);
    }
}
