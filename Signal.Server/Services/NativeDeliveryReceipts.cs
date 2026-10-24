using System.Collections.Concurrent;

namespace Signal.Server.Services;

/// <summary>Short receipt window: a browser is replaced only after the phone actually posts its alert.</summary>
public sealed class NativeDeliveryReceipts
{
    private sealed record Pending(string UserId, string DeviceId, DateTimeOffset Expires,
        TaskCompletionSource<bool> Completion);
    private readonly ConcurrentDictionary<string, Pending> pending = new();
    public Task<bool> Begin(string id, string userId, string deviceId)
    {
        var receipt = new Pending(userId, deviceId, DateTimeOffset.UtcNow.AddSeconds(12),
            new(TaskCreationOptions.RunContinuationsAsynchronously));
        if (!pending.TryAdd(id, receipt)) throw new InvalidOperationException("Duplicate delivery ID.");
        return receipt.Completion.Task;
    }
    public bool Receive(string id, string userId, string deviceId, bool displayed)
    {
        if (!pending.TryGetValue(id, out var receipt) || receipt.UserId != userId || receipt.DeviceId != deviceId || receipt.Expires <= DateTimeOffset.UtcNow) return false;
        if (!displayed && receipt.Expires - DateTimeOffset.UtcNow < TimeSpan.FromSeconds(5)) return false;
        if (displayed) receipt.Completion.TrySetResult(true);
        // The phone must check before starting a watch handover. Delayed FCM must
        // not display a second native copy after browser fallback has completed.
        return true;
    }
    public void End(string id) => pending.TryRemove(id, out _);
}
