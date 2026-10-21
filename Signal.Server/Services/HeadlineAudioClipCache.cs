using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace Signal.Server.Services;

internal sealed class HeadlineAudioClipCache(string directory, long maximumBytes = 256 * 1024 * 1024)
{
    private const int MaximumClipBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    private string PathFor(string voice, string text) => Path.Combine(directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("pcm16k-v1\n" + voice + "\n" + text))) + ".pcm");

    internal byte[]? TryGet(string voice, string text)
    {
        var path = PathFor(voice, text);
        return Read(path + ".br") ?? Read(path);
    }

    private static byte[]? Read(string path)
    {
        try
        {
            var file = new FileInfo(path);
            if (file.Exists && file.Length is > 0 and <= MaximumClipBytes && file.LastWriteTimeUtc >= DateTime.UtcNow - Lifetime)
            {
                var cached = File.ReadAllBytes(path);
                if (path.EndsWith(".br", StringComparison.Ordinal))
                {
                    // Bound decompression and verify exact PCM, including truncated/corrupt files.
                    if (cached.Length <= 40 || !cached.AsSpan(0, 4).SequenceEqual("SPC1"u8)) return null;
                    var length = BinaryPrimitives.ReadInt32LittleEndian(cached.AsSpan(4, 4));
                    if (length is <= 0 or > MaximumClipBytes || length % 2 != 0) return null;
                    var pcm = new byte[length];
                    if (!BrotliDecoder.TryDecompress(cached.AsSpan(40), pcm, out var written) || written != length
                        || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(pcm), cached.AsSpan(8, 32))) return null;
                    cached = pcm;
                }
                if (Valid(cached)) return cached;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        return null;
    }

    internal byte[] GetOrCreate(string voice, string text, Func<byte[]> render)
    {
        if (TryGet(voice, text) is { } cached) return cached;
        var audio = render();
        Store(voice, text, audio);
        return audio;
    }

    internal void Store(string voice, string text, byte[] audio)
    {
        var path = PathFor(voice, text);
        if (audio.Length == 0 || audio.Length % 2 != 0 || audio.AsSpan().IndexOfAnyExcept((byte)0) < 0)
            throw new InvalidOperationException("The speech engine returned invalid audio.");
        if (audio.Length <= MaximumClipBytes)
            Save(path, audio, DateTime.UtcNow);
    }

    private static bool Valid(byte[] audio) => audio.Length is > 0 and <= MaximumClipBytes && audio.Length % 2 == 0
        && audio.AsSpan().IndexOfAnyExcept((byte)0) >= 0;

    private static void Save(string rawPath, byte[] audio, DateTime writtenAt)
    {
        // Lossless compression retains the original samples and bookmark offsets.
        using var compressed = new MemoryStream();
        compressed.Write("SPC1"u8);
        var size = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(size, audio.Length);
        compressed.Write(size);
        compressed.Write(SHA256.HashData(audio));
        using (var encoder = new BrotliStream(compressed, CompressionLevel.Optimal, leaveOpen: true)) encoder.Write(audio);
        var smaller = compressed.Length < audio.Length;
        var path = smaller ? rawPath + ".br" : rawPath;
        var other = smaller ? rawPath : rawPath + ".br";
        string? temporary = null;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(rawPath)!);
            temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllBytes(temporary, smaller ? compressed.ToArray() : audio);
            File.SetLastWriteTimeUtc(temporary, writtenAt);
            File.Move(temporary, path, overwrite: true);
            File.Delete(other);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        finally
        {
            if (temporary is not null) { try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
        }
    }

    internal void Prune() => DerivedAudioCachePruner.Prune(directory, [".pcm", ".pcm.br"], maximumBytes, Lifetime);

    internal async Task CompactLegacyAsync(CancellationToken token)
    {
        try
        {
            if (!Directory.Exists(directory)) return;
            foreach (var file in new DirectoryInfo(directory).GetFiles("*.pcm"))
            {
                token.ThrowIfCancellationRequested();
                if (!DerivedAudioCachePruner.IsCacheFile(file.Name, [".pcm"])) continue;
                if (Read(file.FullName) is { } pcm) Save(file.FullName, pcm, file.LastWriteTimeUtc);
                // Startup migration should leave time for playback and news updates.
                await Task.Delay(10, token);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
