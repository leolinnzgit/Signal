using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed record HeadlineAudioRequest(string[] Titles, int Seconds = 6, string Language = "en-NZ", IReadOnlyDictionary<string, string>? Voices = null);
public sealed record HeadlineAudio(byte[] Wave, double[] Starts);
internal sealed record HeadlineAudioVoice(string Id, CultureInfo Culture, string Gender);
public sealed class HeadlineAudioUnavailableException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed class HeadlineAudioService
{
    private const int SampleRate = 16_000;
    private const int BytesPerSecond = SampleRate * 2;
    private const int MaximumAudioBytes = 64 * 1024 * 1024;
    private readonly SemaphoreSlim generation = new(1, 1);
    private readonly Func<HeadlineAudioRequest, CancellationToken, Task<HeadlineAudio>> render;
    private readonly TimeSpan renderTimeout;
    private readonly TimeSpan queueTimeout;
    private readonly AzureSpeechAudioRenderer? azure;
    private readonly bool windowsOnly;
    private readonly object backgroundLock = new();
    private CancellationTokenSource? backgroundRendering;
    private int foregroundRequests;
    private DateTime lastForegroundActivity;

    public string EngineName => azure?.Enabled == true ? "azure-neural" : "isolated-process";
    public int MaximumBatchCharacters => 15_000;
    public bool BackgroundPreparationEnabled => azure?.BackgroundPreparationEnabled == true;
    public int ArticlePartLength => Math.Min(900, MaximumBatchCharacters);
    internal const string BriefingCompleteMessage = "All caught up. You've reached the end of your audio briefing.";

    public HeadlineAudioService(AzureSpeechAudioRenderer azure)
        : this(azure.Enabled ? azure.GenerateAsync : HeadlineAudioWorker.GenerateAsync,
            TimeSpan.FromSeconds(azure.Enabled ? 90 : 45), TimeSpan.FromSeconds(30), !azure.Enabled)
    {
        this.azure = azure;
    }

    public async Task<IReadOnlyList<NarrationVoice>> GetVoicesAsync(CancellationToken token)
    {
        if (azure?.Enabled == true) return await azure.GetVoicesAsync(token);
        return OperatingSystem.IsWindows() ? HeadlineAudioVoiceCatalog.GetInstalled() : [];
    }

    public HeadlineAudioService() : this(HeadlineAudioWorker.GenerateAsync, TimeSpan.FromSeconds(45), TimeSpan.FromSeconds(30)) { }

    internal HeadlineAudioService(Func<HeadlineAudioRequest, CancellationToken, Task<HeadlineAudio>> render, TimeSpan renderTimeout, TimeSpan queueTimeout, bool windowsOnly = true)
    {
        this.render = render;
        this.renderTimeout = renderTimeout;
        this.queueTimeout = queueTimeout;
        this.windowsOnly = windowsOnly;
    }

    internal static string[] Validate(HeadlineAudioRequest request, int maximumCharacters = 20_000)
    {
        if (request.Voices is { } preferences && (preferences.Count > 2
            || preferences.Any(pair => pair.Key is not ("en" or "zh") || pair.Value is null || pair.Value.Length > 160)))
            throw new ArgumentException("Choose an available English or Chinese reading voice.");
        if (request.Titles is not { Length: > 0 and <= 200 }
            || request.Seconds is not (3 or 6 or 10 or 15)
            || request.Titles.Any(title => string.IsNullOrWhiteSpace(title) || title.Length > 1_000)
            || request.Titles.Sum(title => title.Length) > maximumCharacters)
            throw new ArgumentException("This briefing is too long to prepare as audio. Try a shorter briefing.");
        return request.Titles.Select(title => Regex.Replace(title, @"\s+", " ").Trim()).ToArray();
    }

    public async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken cancellationToken)
    {
        var titles = Validate(request);
        cancellationToken.ThrowIfCancellationRequested();
        request = request with { Titles = titles };
        if (windowsOnly && !OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Screen-off audio is unavailable on this server.");
        lock (backgroundLock) lastForegroundActivity = DateTime.UtcNow;
        // Ready recordings bypass synthesis and never interrupt background work.
        if (azure?.Enabled == true && await azure.GetCachedAsync(request, cancellationToken) is { } cloudCached) return cloudCached;
        lock (backgroundLock)
        {
            foregroundRequests++;
            backgroundRendering?.Cancel();
        }
        var entered = false;
        try
        {
            entered = await generation.WaitAsync(queueTimeout, cancellationToken);
            if (!entered)
                throw new HeadlineAudioUnavailableException("busy", "The audio server is busy preparing another briefing. Please try again shortly.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(renderTimeout);
            try
            {
                var rendering = render(request, deadline.Token);
                // The cloud worker closes its connection before releasing the queue.
                return azure?.Enabled == true ? await rendering : await rendering.WaitAsync(deadline.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new HeadlineAudioUnavailableException("timeout", "The speech engine took too long to prepare audio. Please try again or use Browser voice.");
            }
        }
        finally
        {
            lock (backgroundLock) { foregroundRequests--; lastForegroundActivity = DateTime.UtcNow; }
            if (entered) generation.Release();
        }
    }

    internal async Task<bool> TryPrepareInBackgroundAsync(HeadlineAudioRequest request, CancellationToken token)
    {
        if (!BackgroundPreparationEnabled) return false;
        token.ThrowIfCancellationRequested();
        if (azure?.Enabled == true && await azure.GetCachedAsync(request, token) is not null) return true;
        CancellationTokenSource deadline;
        lock (backgroundLock)
        {
            // Leave time for the next HTTP batch in a user's article preparation.
            if (foregroundRequests > 0 || DateTime.UtcNow - lastForegroundActivity < TimeSpan.FromSeconds(5)
                || backgroundRendering is not null || !generation.Wait(0)) return false;
            deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(renderTimeout);
            backgroundRendering = deadline;
        }
        try
        {
            await azure!.GenerateAsync(request, deadline.Token);
            var saved = await azure.GetCachedAsync(request, deadline.Token) is not null;
            if (!saved)
                throw new HeadlineAudioUnavailableException("cache", "Background audio could not be saved in the recording cache.");
            return true;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            lock (backgroundLock) { if (foregroundRequests > 0) return false; }
            throw new HeadlineAudioUnavailableException("timeout", "Background audio preparation took too long.");
        }
        finally
        {
            lock (backgroundLock) backgroundRendering = null;
            generation.Release();
            deadline.Dispose();
        }
    }

    [SupportedOSPlatform("windows")]
    internal static HeadlineAudio GenerateWindows(string[] titles, int seconds, string language, CancellationToken cancellationToken, IReadOnlyDictionary<string, string>? preferences = null)
    {
        using var pcm = new MemoryStream();
        var clips = new HeadlineAudioClipCache(Path.Combine(AppContext.BaseDirectory, "App_Data", "HeadlineAudioClips"));
        clips.Prune();
        // Use SAPI directly on the worker's STA thread. System.Speech can deadlock
        // while dispatching synthesis events under an IIS application-pool identity.
        dynamic synth = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpVoice", throwOnError: true)!)!;
        dynamic category = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpObjectTokenCategory", throwOnError: true)!)!;
        dynamic tokens;
        try
        {
            category.SetId(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\Voices", false);
            tokens = category.EnumerateTokens("", "");
        }
        catch (COMException) { tokens = synth.GetVoices(); }
        var voices = new List<(object Token, HeadlineAudioVoice Info)>();
        try
        {
            for (var index = 0; index < (int)tokens.Count; index++)
            {
                dynamic token = tokens.Item(index);
                try
                {
                    var languageId = ((string)token.GetAttribute("Language")).Split(';')[0];
                    voices.Add(((object)token, new HeadlineAudioVoice((string)token.Id,
                        CultureInfo.GetCultureInfo(int.Parse(languageId, NumberStyles.HexNumber, CultureInfo.InvariantCulture)), (string)token.GetAttribute("Gender"))));
                }
                catch { Marshal.FinalReleaseComObject((object)token); throw; }
            }
            var starts = new double[titles.Length];
            var silence = new byte[BytesPerSecond];
            for (var index = 0; index < titles.Length; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var title = titles[index];
                var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
                var selected = ChooseVoice(voices.Select(voice => voice.Info), language, chinese,
                    preferences?.GetValueOrDefault(chinese ? "zh" : "en"))
                    ?? throw new InvalidOperationException($"A {(chinese ? "zh" : "en")} voice is unavailable for this briefing.");
                var voice = voices.First(voice => voice.Info.Id == selected.Id);
                var startBytes = pcm.Length;
                starts[index] = startBytes / (double)BytesPerSecond;
                var text = Regex.IsMatch(title, @"[.!?。！？][""'”’]*$") ? title : title + (chinese ? "。" : ".");
                var spoken = clips.GetOrCreate(selected.Id, text, () =>
                {
                    synth.Voice = voice.Token;
                    dynamic stream = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpMemoryStream", throwOnError: true)!)!;
                    dynamic format = stream.Format;
                    try
                    {
                        format.Type = 18; // SAFT16kHz16BitMono: raw PCM, matching the WAV header below.
                        synth.AllowAudioOutputFormatChangesOnNextSet = false;
                        synth.AudioOutputStream = stream;
                        try { synth.Speak(text, 16); } // SVSFIsNotXML: headlines are always plain text.
                        catch (COMException exception)
                        {
                            var hint = exception.HResult == unchecked((int)0x80045040)
                                ? " Check the IIS account's Speech_OneCore/Isolated registry permissions."
                                : "";
                            throw new InvalidOperationException($"Windows speech could not render {selected.Culture.Name}.{hint}", exception);
                        }
                        return (byte[])stream.GetData();
                    }
                    finally
                    {
                        Marshal.FinalReleaseComObject((object)format);
                        Marshal.FinalReleaseComObject((object)stream);
                    }
                });
                pcm.Write(spoken);
                // Keep the display interval and the gap inside the track, so neither needs a background timer.
                var spokenBytes = pcm.Length - startBytes;
                var remainingSilence = Math.Max((long)seconds * BytesPerSecond - spokenBytes, (long)(0.65 * BytesPerSecond));
                while (remainingSilence > 0)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var length = (int)Math.Min(silence.Length, remainingSilence);
                    pcm.Write(silence, 0, length);
                    remainingSilence -= length;
                }
                if (pcm.Length > MaximumAudioBytes)
                    throw new ArgumentException("This briefing is too long to prepare as audio. Try a shorter briefing.");
            }
            using var wave = new MemoryStream(checked((int)pcm.Length + 44));
            using (var writer = new BinaryWriter(wave, Encoding.ASCII, leaveOpen: true))
            {
                writer.Write(Encoding.ASCII.GetBytes("RIFF"));
                writer.Write(checked((int)pcm.Length + 36));
                writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
                writer.Write(16);
                writer.Write((short)1);
                writer.Write((short)1);
                writer.Write(SampleRate);
                writer.Write(BytesPerSecond);
                writer.Write((short)2);
                writer.Write((short)16);
                writer.Write(Encoding.ASCII.GetBytes("data"));
                writer.Write(checked((int)pcm.Length));
            }
            pcm.Position = 0;
            pcm.CopyTo(wave);
            return new HeadlineAudio(wave.ToArray(), starts);
        }
        finally
        {
            foreach (var voice in voices) Marshal.FinalReleaseComObject(voice.Token);
            Marshal.FinalReleaseComObject((object)tokens);
            Marshal.FinalReleaseComObject((object)category);
            Marshal.FinalReleaseComObject((object)synth);
            clips.Prune();
        }
    }

    internal static HeadlineAudioVoice? ChooseVoice(IEnumerable<HeadlineAudioVoice> voices, string language, bool chinese, string? preferredId = null)
    {
        var desired = chinese ? "zh" : "en";
        var candidates = voices.Where(voice => voice.Culture.TwoLetterISOLanguageName == desired).ToArray();
        var preferred = candidates.FirstOrDefault(voice => HeadlineAudioVoiceCatalog.VoiceKey(voice.Id).Equals(preferredId, StringComparison.OrdinalIgnoreCase));
        return preferred ?? candidates
            .OrderByDescending(voice => voice.Gender.Equals("Female", StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(voice => voice.Culture.Name.Equals(language, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(voice => desired == "en" && voice.Culture.Name is "en-GB" or "en-AU" or "en-NZ")
            .FirstOrDefault();
    }

}
