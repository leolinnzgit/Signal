using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed record HeadlineAudioRequest(string[] Titles, int Seconds = 6, string Language = "en-NZ");
public sealed record HeadlineAudio(byte[] Wave, double[] Starts);
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

    public HeadlineAudioService() : this(HeadlineAudioWorker.GenerateAsync, TimeSpan.FromSeconds(45), TimeSpan.FromSeconds(30)) { }

    internal HeadlineAudioService(Func<HeadlineAudioRequest, CancellationToken, Task<HeadlineAudio>> render, TimeSpan renderTimeout, TimeSpan queueTimeout)
    {
        this.render = render;
        this.renderTimeout = renderTimeout;
        this.queueTimeout = queueTimeout;
    }

    internal static string[] Validate(HeadlineAudioRequest request)
    {
        if (request.Titles is not { Length: > 0 and <= 200 }
            || request.Seconds is not (3 or 6 or 10 or 15)
            || request.Titles.Any(title => string.IsNullOrWhiteSpace(title) || title.Length > 1_000)
            || request.Titles.Sum(title => title.Length) > 20_000)
            throw new ArgumentException("This briefing is too long to prepare as audio. Try a shorter briefing.");
        return request.Titles.Select(title => Regex.Replace(title, @"\s+", " ").Trim()).ToArray();
    }

    public async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken cancellationToken)
    {
        var titles = Validate(request);
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Screen-off audio is unavailable on this server.");
        if (!await generation.WaitAsync(queueTimeout, cancellationToken))
            throw new HeadlineAudioUnavailableException("busy", "The audio server is busy preparing another briefing. Please try again shortly.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(renderTimeout);
        try
        {
            return await render(request with { Titles = titles }, deadline.Token).WaitAsync(deadline.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new HeadlineAudioUnavailableException("timeout", "The speech engine took too long to prepare audio. Please try again; the stuck job has been stopped.");
        }
        finally
        {
            generation.Release();
        }
    }

    [SupportedOSPlatform("windows")]
    internal static HeadlineAudio GenerateWindows(string[] titles, int seconds, string language, CancellationToken cancellationToken)
    {
        using var pcm = new MemoryStream();
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
        var voices = new List<(object Token, CultureInfo Culture)>();
        try
        {
            for (var index = 0; index < (int)tokens.Count; index++)
            {
                dynamic token = tokens.Item(index);
                try
                {
                    var languageId = ((string)token.GetAttribute("Language")).Split(';')[0];
                    voices.Add(((object)token, CultureInfo.GetCultureInfo(int.Parse(languageId, NumberStyles.HexNumber, CultureInfo.InvariantCulture))));
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
                var desired = chinese ? "zh" : "en";
                var voice = voices.Where(candidate => candidate.Culture.TwoLetterISOLanguageName == desired)
                    .OrderByDescending(candidate => candidate.Culture.Name.Equals(language, StringComparison.OrdinalIgnoreCase))
                    .ThenByDescending(candidate => desired == "en" && candidate.Culture.Name is "en-GB" or "en-AU" or "en-NZ")
                    .FirstOrDefault();
                if (voice.Token is null)
                    throw new InvalidOperationException($"A {desired} voice is unavailable for this briefing.");
                synth.Voice = voice.Token;
                var startBytes = pcm.Length;
                starts[index] = startBytes / (double)BytesPerSecond;
                var text = Regex.IsMatch(title, @"[.!?。！？][""'”’]*$") ? title : title + (chinese ? "。" : ".");
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
                        throw new InvalidOperationException($"Windows speech could not render {voice.Culture.Name}.{hint}", exception);
                    }
                    byte[] spoken = stream.GetData();
                    if (spoken.Length == 0 || spoken.Length % 2 != 0)
                        throw new InvalidOperationException("The speech engine returned invalid audio.");
                    pcm.Write(spoken);
                }
                finally
                {
                    Marshal.FinalReleaseComObject((object)format);
                    Marshal.FinalReleaseComObject((object)stream);
                }
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
        }
    }

}
