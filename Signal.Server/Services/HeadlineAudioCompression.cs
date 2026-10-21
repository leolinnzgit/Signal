using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;

namespace Signal.Server.Services;

internal static class HeadlineAudioCompression
{
    internal static IServiceCollection AddHeadlineAudioCompression(this IServiceCollection services)
    {
        // PCM speech and its silent gaps compress well. Limit HTTPS compression
        // to recordings so authenticated HTML/JSON responses are unaffected.
        services.AddResponseCompression(options =>
        {
            options.EnableForHttps = true;
            options.MimeTypes = ["audio/wav"];
        });
        services.Configure<BrotliCompressionProviderOptions>(options => options.Level = CompressionLevel.Fastest);
        services.Configure<GzipCompressionProviderOptions>(options => options.Level = CompressionLevel.Fastest);
        return services;
    }
}
