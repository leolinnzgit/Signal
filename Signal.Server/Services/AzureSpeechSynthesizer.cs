using System.Collections.Concurrent;
using Microsoft.CognitiveServices.Speech;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

internal sealed record AzureSpeechBatch(byte[] Pcm, IReadOnlyDictionary<string, ulong> Bookmarks);
internal interface IAzureSpeechSynthesizer
{
    Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken cancellationToken);
}

internal sealed class AzureSpeechSynthesizer(IOptions<AzureSpeechOptions> options) : IAzureSpeechSynthesizer
{
    public async Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        settings.Validate();
        var config = SpeechConfig.FromSubscription(settings.Key, settings.Region);
        config.SetSpeechSynthesisOutputFormat(SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm);
        // A null output collects PCM without playing anything on the IIS server.
        using var synth = new SpeechSynthesizer(config, null);
        var bookmarks = new ConcurrentDictionary<string, ulong>();
        synth.BookmarkReached += (_, args) => bookmarks.TryAdd(args.Text, args.AudioOffset);
        using var result = await SpeakAsync(synth, ssml, cancellationToken);
        if (result.Reason != ResultReason.SynthesizingAudioCompleted)
        {
            var details = SpeechSynthesisCancellationDetails.FromResult(result);
            // Azure error details can contain request data. Return only a safe diagnosis.
            throw details.ErrorCode switch
            {
                CancellationErrorCode.AuthenticationFailure => new HeadlineAudioUnavailableException("authentication", "Azure rejected the Speech key or region. Check the server Speech configuration."),
                CancellationErrorCode.TooManyRequests => new HeadlineAudioUnavailableException("quota", "Azure's Speech allowance or request limit has been reached. Wait a minute and try again, or use Browser voice."),
                _ => new HeadlineAudioUnavailableException("azure", "Azure could not prepare this recording. Please try again or use Browser voice."),
            };
        }
        return new AzureSpeechBatch(result.AudioData, bookmarks);
    }

    private static async Task<SpeechSynthesisResult> SpeakAsync(SpeechSynthesizer synth, string ssml, CancellationToken token)
    {
        try { return await synth.SpeakSsmlAsync(ssml).WaitAsync(token); }
        catch (OperationCanceledException)
        {
            try { await synth.StopSpeakingAsync().WaitAsync(TimeSpan.FromSeconds(3)); }
            catch { /* Disposing the synthesizer below also closes the cloud connection. */ }
            throw;
        }
    }
}
