using System.Diagnostics;
using System.Text.Json;

namespace Signal.Server.Services;

internal static class HeadlineAudioWorker
{
    internal const string Argument = "--render-headline-audio";
    private const int MaximumOutputBytes = 64 * 1024 * 1024 + 16_384;

    internal static async Task<int> RunAsync()
    {
        try
        {
            var request = await JsonSerializer.DeserializeAsync<HeadlineAudioRequest>(Console.OpenStandardInput())
                ?? throw new ArgumentException("An audio request is required.");
            var titles = HeadlineAudioService.Validate(request);
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            var completion = new TaskCompletionSource<HeadlineAudio>(TaskCreationOptions.RunContinuationsAsynchronously);
            var thread = new Thread(() =>
            {
                try
                {
                    if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
                    completion.SetResult(HeadlineAudioService.GenerateWindows(titles, request.Seconds, request.Language, CancellationToken.None, request.Voices));
                }
                catch (Exception exception) { completion.SetException(exception); }
            }) { IsBackground = true, Name = "Headline SAPI renderer" };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            var audio = await completion.Task;
            var offsets = JsonSerializer.SerializeToUtf8Bytes(audio.Starts);
            await using var output = Console.OpenStandardOutput();
            await output.WriteAsync(BitConverter.GetBytes(offsets.Length));
            await output.WriteAsync(offsets);
            await output.WriteAsync(audio.Wave);
            return 0;
        }
        catch (Exception exception)
        {
            await Console.Error.WriteLineAsync(exception.ToString());
            return 1;
        }
    }


    internal static async Task<HeadlineAudio> GenerateAsync(HeadlineAudioRequest request, CancellationToken cancellationToken)
    {
        var installedHost = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", "dotnet.exe");
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        if (string.IsNullOrEmpty(host) || !File.Exists(host)) host = File.Exists(installedHost) ? installedHost : "dotnet";
        var start = new ProcessStartInfo(host)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // IIS can inherit SYSTEM's environment even when it loads the pool's
        // own registry profile. SAPI expands these paths for its user lexicon.
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(profile))
        {
            start.Environment["USERPROFILE"] = profile;
            start.Environment["LOCALAPPDATA"] = Path.Combine(profile, "AppData", "Local");
            start.Environment["APPDATA"] = Path.Combine(profile, "AppData", "Roaming");
        }
        start.ArgumentList.Add(typeof(HeadlineAudioService).Assembly.Location);
        start.ArgumentList.Add(Argument);
        using var process = new Process { StartInfo = start };
        if (!process.Start()) throw new InvalidOperationException("The audio worker could not be started.");
        using var stop = cancellationToken.Register(() => Stop(process));
        var outputTask = ReadOutputAsync(process.StandardOutput.BaseStream, cancellationToken);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        try
        {
            await JsonSerializer.SerializeAsync(process.StandardInput.BaseStream, request, cancellationToken: cancellationToken);
            process.StandardInput.Close();
            await process.WaitForExitAsync(cancellationToken);
            var bytes = await outputTask;
            var error = await errorTask;
            if (process.ExitCode != 0) throw new InvalidOperationException("Audio worker failed: " + error[..Math.Min(error.Length, 8_000)]);
            if (bytes.Length < 48) throw new InvalidOperationException("The audio worker returned incomplete output.");
            var offsetsLength = BitConverter.ToInt32(bytes, 0);
            if (offsetsLength is < 2 or > 8_192 || offsetsLength + 48 > bytes.Length)
                throw new InvalidOperationException("The audio worker returned invalid offsets.");
            var starts = JsonSerializer.Deserialize<double[]>(bytes.AsSpan(4, offsetsLength));
            if (starts is null || starts.Length != request.Titles.Length || starts[0] != 0)
                throw new InvalidOperationException("The audio worker omitted headlines.");
            return new HeadlineAudio(bytes[(4 + offsetsLength)..], starts);
        }
        finally
        {
            // Native SAPI calls can hang in a web worker. Only this isolated child
            // holds the speech engine, so cancellation can stop it completely.
            Stop(process);
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            try { await outputTask; } catch { }
            try { await errorTask; } catch { }
        }
    }

    private static void Stop(Process process)
    {
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private static async Task<byte[]> ReadOutputAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var output = new MemoryStream();
        var buffer = new byte[81_920];
        int length;
        while ((length = await stream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (output.Length + length > MaximumOutputBytes) throw new InvalidOperationException("The audio worker output exceeded its limit.");
            output.Write(buffer, 0, length);
        }
        return output.ToArray();
    }
}
