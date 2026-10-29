using Signal.Server.Services;

internal static class QueueHandoffChecks
{
    private static void Check(bool value, string why) { if (!value) throw new Exception(why); }
    public static async Task RunAsync()
    {
        var path = Path.Combine(Path.GetTempPath(), "signal-queue-transfer-" + Guid.NewGuid().ToString("N"));
        try
        {
            var queues = new ListeningQueueService(path); var handoffs = new ListeningHandoffService(queues: queues);
            var first = new ListeningProgressDocument("https://example.com/first", "First", "Publisher", ["Title", "First section", "Latest section"], 0, "https://images.example.com/first.jpg");
            var second = first with { Url = "https://example.com/second", Title = "Second", PartIndex = 1 };
            var doc = new ListeningQueueDocument([first, second], first.Url);
            ListeningQueueMutation Save(string version, ListeningQueueDocument document) => new(NativeNotificationService.AccountKey("owner"), version, Guid.NewGuid().ToString("N"), "save", document);
            var saved = queues.Apply("owner", Save("0", doc)).Progress;
            var offer = handoffs.Create("owner", new(first.Url, first.Title, first.Source, first.Parts, first.PartIndex, "watch", first.ImageUrl, saved.Version));
            Check(handoffs.Inbox("owner").Length == 0 && handoffs.Inbox("owner", true).Single().QueueCount == 2, "Old watches must not discover unsupported queue transfers.");
            Check(handoffs.Get("owner", offer.Id)!.Queue is null && handoffs.Get("stranger", offer.Id) is null, "Discovery must withhold queue text and isolate accounts.");
            var proof = new string('b', 64);
            Check(!handoffs.Accept("owner", offer.Id, proof, "watch") && handoffs.Accept("owner", offer.Id, proof, "watch", true), "Queue acceptance requires an explicit receiver capability.");
            Check(handoffs.Get("owner", offer.Id, proof)!.Parts is null && handoffs.Get("owner", offer.Id, proof)!.Queue is null, "Acceptance cannot start audio before pause acknowledgement.");
            var latest = queues.Apply("owner", Save(saved.Version, new([first with { PartIndex = 2 }, second], first.Url))).Progress;
            Check(!handoffs.Ready("owner", offer.Id, offer.SourceToken, 2, saved.Version), "A stale queue revision cannot be handed off.");
            Check(!handoffs.Ready("owner", offer.Id, proof, 2, latest.Version) && !handoffs.Ready("owner", offer.Id, offer.SourceToken, 1, latest.Version), "Only the source can confirm its actual durable section.");
            var races = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => handoffs.Ready("owner", offer.Id, offer.SourceToken, 2, latest.Version))));
            Check(races.All(value => value), "Identical readiness retries must be idempotent.");
            var ready = handoffs.Get("owner", offer.Id, proof)!;
            Check(ready.IsQueue && ready.QueueVersion != latest.Version && ready.Queue!.Items.Select(item => item.Url).SequenceEqual([first.Url, second.Url])
                && ready.Queue.Items[0].PartIndex == 2 && ready.Queue.Items[1].PartIndex == 1, "Handoff preserves every story, its order and exact saved sections, with a fresh ownership revision.");
            Check(handoffs.Get("owner", offer.Id, offer.SourceToken)!.Queue is null, "A source proof cannot impersonate the claiming receiver.");
            ready.Queue!.Items[0].Parts[0] = "Caller mutation";
            Check(handoffs.Get("owner", offer.Id, proof)!.Queue!.Items[0].Parts[0] == "Title", "Returned queue snapshots must be deep copies.");
            Check(!queues.Apply("owner", Save(latest.Version, doc)).Accepted, "The old source outbox cannot reclaim the transferred queue.");
            var advanced = queues.Apply("owner", Save(ready.QueueVersion!, new([second], second.Url)));
            Check(advanced.Accepted && handoffs.Ready("owner", offer.Id, offer.SourceToken, 2, latest.Version), "A late acknowledgement retry must not overwrite receiver progress.");
            Check(queues.Get("owner").Version == advanced.Progress.Version && !handoffs.Cancel("owner", offer.Id, offer.SourceToken, null), "Completed handoffs cannot rewind the receiver.");
            var cancelled = handoffs.Create("owner", new(second.Url, second.Title, second.Source, second.Parts, second.PartIndex, QueueVersion: advanced.Progress.Version, ImageUrl: second.ImageUrl));
            Check(handoffs.Cancel("owner", cancelled.Id, null, proof) && !handoffs.Ready("owner", cancelled.Id, cancelled.SourceToken, 1, advanced.Progress.Version), "Cancelling before readiness never transfers queue ownership.");
            Check(queues.Get("owner").Version == advanced.Progress.Version, "Cancellation leaves the durable queue unchanged.");
        }
        finally { if (Directory.Exists(path)) Directory.Delete(path, true); }
        Console.WriteLine("Full-queue handoff passed capability negotiation, withheld text, exact order/sections, atomic readiness retries, stale source rejection, receiver progress, cancellation and account isolation.");
    }
}
