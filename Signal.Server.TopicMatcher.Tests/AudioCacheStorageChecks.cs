using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Signal.Server.Services;

internal static class AudioCacheStorageChecks
{
    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    internal static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "SignalAudioStorage-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var audio = Enumerable.Range(0, 200_000).Select(index => (byte)(index % 32 + 1)).ToArray();
            var cache = new HeadlineAudioClipCache(root);
            cache.Store("voice", "Saved clip.", audio);
            var compressed = Directory.GetFiles(root, "*.pcm.br").Single();
            Assert(new FileInfo(compressed).Length < audio.Length / 2 && Directory.GetFiles(root, "*.pcm").Length == 0,
                "The clip was not compressed or its uncompressed duplicate was retained.");
            Assert(new HeadlineAudioClipCache(root).TryGet("voice", "Saved clip.")!.SequenceEqual(audio), "Compression changed the original audio samples.");
            var encoded = File.ReadAllBytes(compressed);
            var corrupted = encoded.ToArray(); corrupted[8] ^= 1;
            File.WriteAllBytes(compressed, corrupted);
            Assert(cache.TryGet("voice", "Saved clip.") is null, "A corrupt compressed clip was offered as valid audio.");
            File.WriteAllBytes(compressed, encoded[..^2]);
            Assert(cache.TryGet("voice", "Saved clip.") is null, "A truncated compressed clip was offered as valid audio.");
            corrupted = encoded.ToArray(); BinaryPrimitives.WriteInt32LittleEndian(corrupted.AsSpan(4, 4), int.MaxValue);
            File.WriteAllBytes(compressed, corrupted);
            Assert(cache.TryGet("voice", "Saved clip.") is null, "Compressed cache data bypassed the decompression size bound.");
            cache.Store("voice", "Saved clip.", audio);

            var randomAudio = new byte[2048]; new Random(42).NextBytes(randomAudio);
            cache.Store("voice", "No compression benefit.", randomAudio);
            Assert(Directory.GetFiles(root, "*.pcm").Length == 1 && cache.TryGet("voice", "No compression benefit.")!.SequenceEqual(randomAudio),
                "Compression enlarged an incompressible clip or lost its samples.");

            var legacy = Path.Combine(root, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("pcm16k-v1\nlegacy\nLegacy clip."))) + ".pcm");
            File.WriteAllBytes(legacy, audio);
            var originalTime = DateTime.UtcNow.AddDays(-2); File.SetLastWriteTimeUtc(legacy, originalTime);
            Assert(cache.TryGet("legacy", "Legacy clip.")!.SequenceEqual(audio), "The existing raw cache could not be read during migration.");
            await cache.CompactLegacyAsync(CancellationToken.None);
            Assert(!File.Exists(legacy) && File.Exists(legacy + ".br") && cache.TryGet("legacy", "Legacy clip.")!.SequenceEqual(audio)
                && (File.GetLastWriteTimeUtc(legacy + ".br") - originalTime).Duration() < TimeSpan.FromMilliseconds(1),
                "Legacy compaction lost audio, retained duplicates or extended the clip's expiry.");
            using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
            try { await cache.CompactLegacyAsync(cancelled.Token); throw new Exception("Compaction ignored shutdown."); }
            catch (OperationCanceledException) { }

            var stale = Path.Combine(root, new string('a', 64) + ".pcm.br");
            File.WriteAllBytes(stale, encoded); File.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddDays(-8));
            var orphan = Path.Combine(root, new string('b', 64) + ".pcm.br." + Guid.NewGuid().ToString("N") + ".tmp");
            File.WriteAllText(orphan, "partial"); File.SetLastWriteTimeUtc(orphan, DateTime.UtcNow.AddDays(-2));
            var unrelated = Path.Combine(root, "user-notes.txt"); File.WriteAllText(unrelated, "Keep this file.");
            cache.Prune();
            Assert(!File.Exists(stale) && !File.Exists(orphan) && File.Exists(unrelated), "Maintenance retained stale cache data or removed an unrelated file.");

            var bounded = Path.Combine(root, "bounded"); Directory.CreateDirectory(bounded);
            foreach (var (character, age) in new[] { ('c', 3), ('d', 2), ('e', 1) })
            {
                var path = Path.Combine(bounded, new string(character, 64) + ".mp3");
                File.WriteAllBytes(path, [1, 2, 3, 4]); File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddDays(-age));
            }
            var active = Path.Combine(bounded, new string('e', 64) + ".mp3");
            DerivedAudioCachePruner.Prune(bounded, [".mp3"], 4, TimeSpan.FromDays(30), active);
            Assert(Directory.GetFiles(bounded).SequenceEqual([active]), "The shared MP3 size bound did not evict older recordings or preserve the active recording.");
            File.SetLastWriteTimeUtc(active, DateTime.UtcNow.AddDays(-31));
            DerivedAudioCachePruner.Prune(bounded, [".mp3"], 4, TimeSpan.FromDays(30));
            Assert(Directory.GetFiles(bounded).Length == 0, "Expired shared MP3s were not evicted.");
            Console.WriteLine("Audio storage passed lossless compression, reopening, corruption and decompression bounds, raw compatibility, expiry-preserving migration, temporary cleanup and bounded MP3 eviction.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
