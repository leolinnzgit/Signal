using System.Xml.Linq;

namespace Signal.Server.Services;

public sealed record ArticleAudioStreamStatus(double[] Starts, bool Complete, double Duration, string? Error);

// Sessions belong to the signed-in user. A native <audio> request receives MP3
// bytes directly, so playback does not rely on foreground JavaScript timers.
public sealed class ArticleAudioStreamService
{
    private readonly AzureSpeechAudioRenderer azure;
    private readonly IAzureSpeechStreamer synth;
    private readonly object gate = new();
    private readonly Dictionary<string, Session> sessions = [];
    private readonly SemaphoreSlim generation = new(2, 2);
    internal ArticleAudioStreamService(AzureSpeechAudioRenderer azure, IAzureSpeechStreamer synth) { this.azure = azure; this.synth = synth; }
    public bool Enabled => azure.Enabled;

    internal async Task<Session> CreateAsync(string owner, HeadlineAudioRequest request, CancellationToken token)
    {
        if (!Enabled) throw new HeadlineAudioUnavailableException("configuration", "Streaming narration needs Azure Speech. Choose recorded audio instead.");
        // Full articles may contain 40,000 characters; each cloud batch is much smaller.
        var titles = HeadlineAudioService.Validate(request, 40_000);
        var voices = await azure.GetVoicesAsync(token);
        var clips = titles.Select(title =>
        {
            var chinese = title.Any(character => character is >= '\u3400' and <= '\u9fff');
            var configured = azure.DefaultVoice(chinese);
            var voice = AzureSpeechAudioRenderer.ChooseVoice(voices, request.Language, chinese, request.Voices?.GetValueOrDefault(chinese ? "zh" : "en"), configured);
            return new AzureSpeechAudioRenderer.Clip(voice.Id, title);
        }).ToArray();
        lock (gate)
        {
            foreach (var expired in sessions.Values.Where(session => !session.Running && session.Created < DateTimeOffset.UtcNow.AddMinutes(-30)).ToArray()) sessions.Remove(expired.Id);
            var owned = sessions.Values.Where(session => session.Owner == owner).OrderBy(session => session.Created).ToArray();
            while (owned.Length >= 2)
            {
                var removable = owned.FirstOrDefault(session => !session.Running);
                if (removable is null) throw new HeadlineAudioUnavailableException("busy", "Close another audio player before starting this article.");
                sessions.Remove(removable.Id);
                owned = owned.Where(session => session != removable).ToArray();
            }
            if (sessions.Count >= 8) throw new HeadlineAudioUnavailableException("busy", "The audio server is busy. Please try again shortly.");
            var created = new Session(owner, clips);
            sessions.Add(created.Id, created);
            return created;
        }
    }

    internal Session? Find(string owner, string id)
    {
        lock (gate) return sessions.TryGetValue(id, out var session) && session.Owner == owner
            && (session.Running || session.Created > DateTimeOffset.UtcNow.AddMinutes(-30)) ? session : null;
    }

    internal void Remove(Session session) { lock (gate) sessions.Remove(session.Id); }

    internal async Task WriteAsync(Session session, Stream output, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(5));
        var entered = false;
        try
        {
            entered = await generation.WaitAsync(TimeSpan.FromSeconds(30), deadline.Token);
            if (!entered) throw new HeadlineAudioUnavailableException("busy", "The audio server is busy. Please try again shortly.");
            var elapsed = 0d;
            for (var first = 0; first < session.Clips.Length;)
            {
                var batch = new List<AzureSpeechAudioRenderer.Clip>();
                var characters = 0;
                foreach (var clip in session.Clips.Skip(first))
                {
                    if (batch.Count == 10 || (batch.Count > 0 && characters + clip.Text.Length > 1500)) break;
                    batch.Add(clip); characters += clip.Text.Length;
                }
                var offset = first;
                var batchStart = elapsed;
                var duration = await synth.StreamAsync(CreateSsml(batch), async (bytes, cancellation) =>
                {
                    session.Append(bytes);
                    await output.WriteAsync(bytes, cancellation);
                    await output.FlushAsync(cancellation);
                }, (mark, ticks) =>
                {
                    if (mark.StartsWith("clip-", StringComparison.Ordinal) && mark.EndsWith("-start", StringComparison.Ordinal)
                        && int.TryParse(mark.AsSpan(5, mark.Length - 11), out var index) && index >= 0 && index < batch.Count)
                        session.Mark(offset + index, batchStart + ticks / (double)TimeSpan.TicksPerSecond);
                }, deadline.Token);
                if (duration <= TimeSpan.Zero) throw new HeadlineAudioUnavailableException("stream", "Azure returned an incomplete audio stream.");
                elapsed += duration.TotalSeconds;
                first += batch.Count;
            }
            session.Finish(elapsed);
        }
        catch (Exception exception)
        {
            session.Fail(exception is HeadlineAudioUnavailableException known ? known.Message : "The audio stream stopped. Try again or prepare a recording.");
            throw;
        }
        finally { if (entered) generation.Release(); }
    }

    internal static string CreateSsml(IReadOnlyList<AzureSpeechAudioRenderer.Clip> clips)
    {
        XNamespace ns = "http://www.w3.org/2001/10/synthesis";
        return new XElement(ns + "speak", new XAttribute("version", "1.0"), new XAttribute(XNamespace.Xml + "lang", "en-US"),
            clips.Select((clip, index) => new XElement(ns + "voice", new XAttribute("name", clip.Voice),
                new XElement(ns + "bookmark", new XAttribute("mark", $"clip-{index}-start")), new XText(clip.Text),
                new XElement(ns + "break", new XAttribute("time", "650ms"))))).ToString(SaveOptions.DisableFormatting);
    }

    internal sealed class Session(string owner, AzureSpeechAudioRenderer.Clip[] clips)
    {
        private readonly object gate = new();
        private MemoryStream? audio = new();
        private readonly double?[] starts = new double?[clips.Length];
        private byte[]? recording;
        private bool started, complete;
        private string? error;
        private double duration;
        public string Id { get; } = Guid.NewGuid().ToString("N");
        public string Owner { get; } = owner;
        public DateTimeOffset Created { get; } = DateTimeOffset.UtcNow;
        public AzureSpeechAudioRenderer.Clip[] Clips { get; } = clips;
        public bool Running { get { lock (gate) return started && !complete && error is null; } }
        public byte[]? Recording { get { lock (gate) return recording; } }
        public bool TryStart() { lock (gate) { if (started) return false; started = true; return true; } }
        public ArticleAudioStreamStatus Status { get { lock (gate) return new(starts.TakeWhile(start => start.HasValue).Select(start => start!.Value).ToArray(), complete, duration, error); } }
        public void Append(byte[] bytes)
        {
            lock (gate)
            {
                if (audio is null || audio.Length + bytes.Length > 16 * 1024 * 1024) throw new HeadlineAudioUnavailableException("stream", "This article is too long to stream. Try a shorter article.");
                audio.Write(bytes);
            }
        }
        public void Mark(int index, double time) { lock (gate) starts[index] = time; }
        public void Finish(double elapsed)
        {
            lock (gate)
            {
                if (audio is null || audio.Length == 0 || starts.Any(start => !start.HasValue || !double.IsFinite(start.Value) || start < 0)
                    || starts.Zip(starts.Skip(1)).Any(pair => pair.Second <= pair.First))
                    throw new HeadlineAudioUnavailableException("stream", "Azure returned an incomplete audio stream. Please try again.");
                recording = audio.ToArray(); audio.Dispose(); audio = null;
                duration = elapsed; complete = true;
            }
        }
        public void Fail(string message) { lock (gate) { error = message; audio?.Dispose(); audio = null; } }
    }
}
