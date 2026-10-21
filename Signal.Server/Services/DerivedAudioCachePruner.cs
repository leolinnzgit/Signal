namespace Signal.Server.Services;

// Only derived recordings with content-hash filenames are eligible for eviction.
internal static class DerivedAudioCachePruner
{
    internal static bool IsCacheFile(string name, IReadOnlyList<string> extensions)
        => name.Length > 64 && name.AsSpan(0, 64).ContainsAnyExcept("0123456789abcdefABCDEF") == false
            && extensions.Any(extension => name[64..] == extension);

    internal static void Prune(string directory, IReadOnlyList<string> extensions, long maximumBytes, TimeSpan lifetime, string? keep = null)
    {
        try
        {
            if (!Directory.Exists(directory)) return;
            var files = new DirectoryInfo(directory).GetFiles();
            foreach (var temporary in files.Where(file => file.Name.EndsWith(".tmp", StringComparison.Ordinal)
                && file.LastWriteTimeUtc < DateTime.UtcNow.AddDays(-1)))
            {
                var stem = temporary.Name[..^4];
                if (stem.Length > 33 && Guid.TryParseExact(stem[^32..], "N", out _)
                    && stem[^33] == '.' && IsCacheFile(stem[..^33], extensions)) Delete(temporary);
            }
            var recordings = files.Where(file => IsCacheFile(file.Name, extensions)).OrderBy(file => file.LastWriteTimeUtc).ToArray();
            var size = recordings.Sum(file => file.Length);
            foreach (var file in recordings)
            {
                if (file.LastWriteTimeUtc >= DateTime.UtcNow - lifetime && size <= maximumBytes) break;
                if (file.FullName == keep) continue;
                var length = file.Length;
                if (Delete(file)) size -= length;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static bool Delete(FileInfo file)
    {
        try { file.Delete(); return true; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
}
