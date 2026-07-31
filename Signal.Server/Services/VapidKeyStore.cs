using System.Text.Json;
using WebPush;

namespace Signal.Server.Services;

public sealed class VapidKeyStore(
    IWebHostEnvironment environment,
    ILogger<VapidKeyStore> logger)
{
    private const string Subject = "https://signal.tail445c22.ts.net";
    private readonly SemaphoreSlim gate = new(1, 1);
    private PushVapidKeys? cached;

    public async Task<PushVapidKeys> GetAsync(CancellationToken cancellationToken)
    {
        if (cached is not null) return cached;

        await gate.WaitAsync(cancellationToken);
        try
        {
            if (cached is not null) return cached;

            var directory = Path.Combine(environment.ContentRootPath, "App_Data");
            var path = Path.Combine(directory, "push-vapid.json");
            Directory.CreateDirectory(directory);
            if (File.Exists(path))
            {
                var saved = JsonSerializer.Deserialize<PushVapidKeys>(
                    await File.ReadAllTextAsync(path, cancellationToken));
                if (saved is not null
                    && saved.PublicKey.Length > 0
                    && saved.PrivateKey.Length > 0)
                {
                    cached = saved;
                    return saved;
                }
            }

            var generated = VapidHelper.GenerateVapidKeys();
            var created = new PushVapidKeys(
                Subject,
                generated.PublicKey,
                generated.PrivateKey);
            var temporaryPath = $"{path}.{Guid.NewGuid():N}.partial";
            await File.WriteAllTextAsync(
                temporaryPath,
                JsonSerializer.Serialize(created),
                cancellationToken);
            File.Move(temporaryPath, path, overwrite: true);
            logger.LogInformation("Generated Signal Web Push VAPID keys in App_Data.");
            cached = created;
            return created;
        }
        finally
        {
            gate.Release();
        }
    }
}

public sealed record PushVapidKeys(
    string Subject,
    string PublicKey,
    string PrivateKey);
