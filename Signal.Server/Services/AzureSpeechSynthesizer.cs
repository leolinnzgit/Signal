using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.CognitiveServices.Speech;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

internal sealed record AzureSpeechBatch(byte[] Pcm, IReadOnlyDictionary<string, ulong> Bookmarks);
internal interface IAzureSpeechSynthesizer
{
    Task<AzureSpeechBatch> SynthesizeAsync(string ssml, CancellationToken cancellationToken);
}

internal interface IAzureSpeechStreamer
{
    Task<TimeSpan> StreamAsync(string ssml, Func<byte[], CancellationToken, Task> write, Action<string, ulong> bookmark, CancellationToken token);
}

internal sealed class AzureSpeechSynthesizer(IOptions<AzureSpeechOptions> options) : IAzureSpeechSynthesizer, IAzureSpeechStreamer
{
    public async Task<TimeSpan> StreamAsync(string ssml, Func<byte[], CancellationToken, Task> write, Action<string, ulong> bookmark, CancellationToken token)
    {
        var settings = options.Value;
        settings.Validate();
        var config = SpeechConfig.FromSubscription(settings.Key, settings.Region);
        config.SetSpeechSynthesisOutputFormat(SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3);
        using var synth = new SpeechSynthesizer(config, null);
        using var abort = CancellationTokenSource.CreateLinkedTokenSource(token);
        // Azure can deliver many tiny MP3 fragments in a burst. Limit queued
        // bytes rather than fragment count so normal browser backpressure does
        // not cancel synthesis after only a few kilobytes of audio.
        var chunks = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
        long queuedBytes = 0;
        synth.BookmarkReached += (_, args) => bookmark(args.Text, args.AudioOffset);
        synth.Synthesizing += (_, args) =>
        {
            var bytes = args.Result.AudioData;
            if (bytes.Length == 0) return;
            if (Interlocked.Add(ref queuedBytes, bytes.Length) > 2 * 1024 * 1024 || !chunks.Writer.TryWrite(bytes))
            {
                Interlocked.Add(ref queuedBytes, -bytes.Length);
                chunks.Writer.TryComplete(new HeadlineAudioUnavailableException("stream", "The audio connection is too slow. Try again or prepare a recording."));
                abort.Cancel();
            }
        };
        var duration = TimeSpan.Zero;
        async Task ProduceAsync()
        {
            try
            {
                using var result = await SpeakAsync(synth, ssml, abort.Token);
                EnsureCompleted(result);
                duration = result.AudioDuration;
                chunks.Writer.TryComplete();
            }
            catch (Exception exception) { chunks.Writer.TryComplete(exception); }
        }
        var producing = ProduceAsync();
        try
        {
            await foreach (var chunk in chunks.Reader.ReadAllAsync(token))
            {
                Interlocked.Add(ref queuedBytes, -chunk.Length);
                await write(chunk, token);
            }
            await producing;
            return duration;
        }
        finally { abort.Cancel(); await producing; }
    }

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
        EnsureCompleted(result);
        return new AzureSpeechBatch(result.AudioData, bookmarks);
    }

    private static void EnsureCompleted(SpeechSynthesisResult result)
    {
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
