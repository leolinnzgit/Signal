using System.Net;
using System.Text.Json;
using System.Xml.Linq;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class ArticleAudioStreamChecks
{
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    internal static async Task RunAsync()
    {
        using var client = new HttpClient(new Voices());
        var options = Options.Create(new AzureSpeechOptions { Provider = "Azure", Key = "fake-speech-key-for-streaming-tests", Region = "eastus" });
        var renderer = new AzureSpeechAudioRenderer(options, client, new AzureSpeechSynthesizer(options), Path.GetTempPath());
        var synth = new FakeStream();
        var service = new ArticleAudioStreamService(renderer, synth);
        var request = new HeadlineAudioRequest(["News <with> & punctuation.", "中文新聞。"], 3,
            Voices: new Dictionary<string, string> { ["en"] = "kokoro/bf_emma", ["zh"] = "kokoro/zf_xiaobei" });
        var session = await service.CreateAsync("owner", request, CancellationToken.None);
        Assert(service.Find("other-user", session.Id) is null && service.Find("owner", session.Id) == session, "A stream escaped its signed-in owner.");
        Assert(session.TryStart() && !session.TryStart(), "A second request could start duplicate cloud synthesis.");
        using var output = new MemoryStream();
        var writing = service.WriteAsync(session, output, CancellationToken.None);
        await synth.FirstBytes.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert(output.Length > 0 && !writing.IsCompleted && !session.Status.Complete && session.Status.Starts.SequenceEqual([0d]),
            "The first audio bytes were buffered until synthesis completed.");
        synth.Release.SetResult();
        await writing;
        Assert(session.Status.Complete && session.Status.Starts.SequenceEqual([0d, 2d]) && session.Status.Duration == 4
            && session.Recording!.SequenceEqual(output.ToArray()) && synth.Voices.SequenceEqual([options.Value.EnglishVoice, options.Value.ChineseVoice])
            && synth.Texts.SequenceEqual(request.Titles), "Streaming lost text, voice fallback, timing or the completed replay.");
        var cancelled = await service.CreateAsync("cancelled-owner", request, CancellationToken.None);
        Assert(cancelled.TryStart(), "A new stream could not start.");
        synth.Reset();
        using var cancel = new CancellationTokenSource();
        using var partial = new MemoryStream();
        var cancelling = service.WriteAsync(cancelled, partial, cancel.Token);
        await synth.FirstBytes.Task.WaitAsync(TimeSpan.FromSeconds(3)); cancel.Cancel();
        try { await cancelling; throw new Exception("Streaming ignored cancellation."); } catch (OperationCanceledException) { }
        Assert(cancelled.Status.Error is not null && !cancelled.Status.Complete && cancelled.Recording is null && !cancelled.Running,
            "A cancelled partial stream was offered as a complete recording.");
        synth.Reset(); synth.Release.SetResult();
        var longRequest = new HeadlineAudioRequest(Enumerable.Range(0, 32).Select(index => $"{index}: " + new string('a', 700)).ToArray(), 3);
        var longSession = await service.CreateAsync("long-owner", longRequest, CancellationToken.None);
        longSession.TryStart(); using var longOutput = new MemoryStream();
        await service.WriteAsync(longSession, longOutput, CancellationToken.None);
        Assert(longSession.Status.Complete && longSession.Status.Starts.Length == 32 && synth.LargestCharacters <= 1500
            && longSession.Status.Starts.Zip(longSession.Status.Starts.Skip(1)).All(pair => pair.Second > pair.First), "Long articles exceeded a cloud batch or lost timestamps between batches.");
        Console.WriteLine("Article streaming passed early bytes, owner isolation, duplicate-start protection, cancellation, voice fallback, replay and bounded multi-batch timing.");
    }

    private sealed class Voices : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new[] {
                new { ShortName = "en-NZ-MollyNeural", Locale = "en-NZ", DisplayName = "Molly", Gender = "Female", VoiceType = "Neural", Status = "GA" },
                new { ShortName = "zh-TW-HsiaoChenNeural", Locale = "zh-TW", DisplayName = "HsiaoChen", Gender = "Female", VoiceType = "Neural", Status = "GA" }
            })) });
    }
    private sealed class FakeStream : IAzureSpeechStreamer
    {
        internal TaskCompletionSource FirstBytes = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly List<string> Voices = [], Texts = [];
        internal int LargestCharacters;
        internal void Reset() { FirstBytes = new(TaskCreationOptions.RunContinuationsAsynchronously); Release = new(TaskCreationOptions.RunContinuationsAsynchronously); }
        public async Task<TimeSpan> StreamAsync(string ssml, Func<byte[], CancellationToken, Task> write, Action<string, ulong> bookmark, CancellationToken token)
        {
            XNamespace ns = "http://www.w3.org/2001/10/synthesis";
            var voices = XDocument.Parse(ssml).Root!.Elements(ns + "voice").ToArray();
            var characters = 0;
            for (var index = 0; index < voices.Length; index++)
            {
                var voice = voices[index];
                var text = string.Concat(voice.Nodes().OfType<XText>().Select(node => node.Value)); characters += text.Length;
                Voices.Add(voice.Attribute("name")!.Value); Texts.Add(text);
                bookmark(voice.Element(ns + "bookmark")!.Attribute("mark")!.Value, (ulong)index * 20_000_000);
                await write([0xff, 0xf3, 0x48, 0xc4], token);
                FirstBytes.TrySetResult(); await Release.Task.WaitAsync(token);
            }
            LargestCharacters = Math.Max(LargestCharacters, characters);
            return TimeSpan.FromSeconds(voices.Length * 2);
        }
    }
}
