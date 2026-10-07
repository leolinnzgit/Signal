using System.Security.Cryptography;
using System.Text;

namespace Signal.Server.Services;

internal sealed class HeadlineAudioClipCache(string directory, long maximumBytes = 256 * 1024 * 1024)
{
    private const int MaximumClipBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    internal byte[] GetOrCreate(string voice, string text, Func<byte[]> render)
    {
        var path = Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("pcm16k-v1\n" + voice + "\n" + text))) + ".pcm");
        try
        {
            var file = new FileInfo(path);
            if (file.Exists && file.Length is > 0 and <= MaximumClipBytes && file.Length % 2 == 0 && file.LastWriteTimeUtc >= DateTime.UtcNow - Lifetime)
            {
                var cached = File.ReadAllBytes(path);
                if (cached.Length > 0 && cached.Length % 2 == 0 && cached.AsSpan().IndexOfAnyExcept((byte)0) >= 0) return cached;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        var audio = render();
        if (audio.Length == 0 || audio.Length % 2 != 0 || audio.AsSpan().IndexOfAnyExcept((byte)0) < 0)
            throw new InvalidOperationException("The speech engine returned invalid audio.");
        if (audio.Length <= MaximumClipBytes)
        {
            string? temporary = null;
            try
            {
                Directory.CreateDirectory(directory);
                temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllBytes(temporary, audio);
                File.Move(temporary, path, overwrite: true);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            finally
            {
                if (temporary is not null) { try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
            }
        }
        return audio;
    }

    internal void Prune()
    {
        try
        {
            if (!Directory.Exists(directory)) return;
            var files = new DirectoryInfo(directory).GetFiles("*.pcm").OrderBy(file => file.LastWriteTimeUtc).ToArray();
            var size = files.Sum(file => file.Length);
            foreach (var file in files)
            {
                if (file.LastWriteTimeUtc >= DateTime.UtcNow - Lifetime && size <= maximumBytes) break;
                var length = file.Length;
                file.Delete();
                size -= length;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
