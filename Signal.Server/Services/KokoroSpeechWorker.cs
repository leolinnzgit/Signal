using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

internal sealed record KokoroClip(string Voice, string Text);
internal interface IKokoroSpeechWorker
{
    Task<byte[][]> GenerateAsync(IReadOnlyList<KokoroClip> clips, CancellationToken token, bool background = false);
}

internal sealed class KokoroSpeechWorker(IOptions<KokoroSpeechOptions> options, IWebHostEnvironment environment) : IKokoroSpeechWorker, IDisposable
{
    private Process? process;
    private readonly SemaphoreSlim gate = new(1, 1);
    private Task? diagnostics;
    private readonly string directory = string.IsNullOrWhiteSpace(options.Value.KokoroDirectory)
        ? Path.Combine(environment.ContentRootPath, "App_Data", "Kokoro") : Path.GetFullPath(options.Value.KokoroDirectory);

    private void Start()
    {
        if (process is { HasExited: false }) return;
        Stop();
        var python = Path.Combine(directory, "venv", "Scripts", "python.exe");
        var script = Path.Combine(AppContext.BaseDirectory, "Speech", "kokoro_worker.py");
        if (!File.Exists(python) || !File.Exists(script) || options.Value.KokoroThreads is < 1 or > 4)
            throw new HeadlineAudioUnavailableException("configuration", "Kokoro is not installed. Run Install Signal Kokoro on the server.");
        var start = new ProcessStartInfo(python) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardInputEncoding = new UTF8Encoding(false), StandardErrorEncoding = Encoding.UTF8 };
        start.ArgumentList.Add("-I");
        start.ArgumentList.Add(script);
        start.ArgumentList.Add("--root"); start.ArgumentList.Add(directory);
        start.ArgumentList.Add("--threads"); start.ArgumentList.Add(options.Value.KokoroThreads.ToString(System.Globalization.CultureInfo.InvariantCulture));
        start.Environment["PYTHONUTF8"] = "1";
        var temporary = Path.Combine(directory, "Temp");
        Directory.CreateDirectory(temporary);
        start.Environment["TEMP"] = temporary;
        start.Environment["TMP"] = temporary;
        process = Process.Start(start) ?? throw new InvalidOperationException("Kokoro could not start.");
        // Drain diagnostics continuously without retaining text or unbounded logs.
        var stderr = process.StandardError;
        diagnostics = Task.Run(async () => { var buffer = new char[2048]; try { while (await stderr.ReadAsync(buffer) > 0) { } } catch (IOException) { } catch (ObjectDisposedException) { } });
    }

    public async Task<byte[][]> GenerateAsync(IReadOnlyList<KokoroClip> clips, CancellationToken token, bool background = false)
    {
        await gate.WaitAsync(token);
        try
        {
            token.ThrowIfCancellationRequested();
            Start();
            using var cancel = token.Register(StopProcess);
            await process!.StandardInput.WriteLineAsync(JsonSerializer.Serialize(clips.Select(clip => new { clip.Voice, clip.Text, Background = background })).AsMemory(), token);
            await process.StandardInput.FlushAsync(token);
            var output = process.StandardOutput.BaseStream;
            var prefix = new byte[4];
            await output.ReadExactlyAsync(prefix, token);
            var jsonLength = BitConverter.ToInt32(prefix);
            if (jsonLength is < 2 or > 4096) throw new InvalidOperationException("Kokoro returned an invalid clip header.");
            var header = new byte[jsonLength];
            await output.ReadExactlyAsync(header, token);
            var lengths = JsonSerializer.Deserialize<int[]>(header);
            if (lengths is null || lengths.Length != clips.Count || lengths.Any(length => length is <= 0 or > 8 * 1024 * 1024 || length % 2 != 0) || lengths.Sum(length => (long)length) > 16 * 1024 * 1024)
                throw new InvalidOperationException("Kokoro returned incomplete narration.");
            var audio = new byte[lengths.Length][];
            for (var index = 0; index < lengths.Length; index++)
            {
                audio[index] = new byte[lengths[index]];
                await output.ReadExactlyAsync(audio[index], token);
                if (audio[index].AsSpan().IndexOfAnyExcept((byte)0) < 0) throw new InvalidOperationException("Kokoro returned silent narration.");
            }
            return audio;
        }
        catch (Exception) when (token.IsCancellationRequested) { Stop(); throw new OperationCanceledException(token); }
        catch { Stop(); throw; }
        finally { gate.Release(); }
    }

    private void StopProcess()
    {
        try { if (process is { HasExited: false }) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
    }
    private void Stop() { StopProcess(); process?.Dispose(); process = null; }
    public void Dispose() { Stop(); gate.Dispose(); }
}
