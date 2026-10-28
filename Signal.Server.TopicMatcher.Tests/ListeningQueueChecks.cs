using Signal.Server.Services;

internal static class ListeningQueueChecks
{
    private static void Check(bool value, string why) { if (!value) throw new Exception(why); }
    public static async Task RunAsync()
    {
        var path = Path.Combine(Path.GetTempPath(), "signal-queue-" + Guid.NewGuid().ToString("N"));
        try
        {
            var service = new ListeningQueueService(path); var other = new ListeningQueueService(path);
            var first = new ListeningProgressDocument("https://example.com/first", "First", "Publisher", ["Heading", "Exact section", "Last"], 1, "https://images.example.com/a.jpg");
            var second = first with { Url = "https://example.com/second", Title = "Second", PartIndex = 0 };
            var document = new ListeningQueueDocument([first, second], first.Url);
            ListeningQueueMutation Mutation(string version, ListeningQueueDocument? doc = null) => new(NativeNotificationService.AccountKey("owner"), version, Guid.NewGuid().ToString("N"), "save", doc ?? document);
            var sent = Mutation("0"); var saved = service.Apply("owner", sent);
            Check(saved.Accepted && service.Apply("owner", sent).Progress.Version == saved.Progress.Version, "Queue retries must be idempotent.");
            var copy = service.Get("owner"); copy.Document!.Items[0].Parts[0] = "Caller change";
            Check(service.Get("owner").Document!.Items[0].Parts[0] == "Heading", "Returned arrays must be deep copies.");
            Check(!service.Apply("owner", sent with { Document = document with { CurrentUrl = second.Url } }).Accepted, "Reused operation IDs cannot alter text or position.");
            var reordered = service.Apply("owner", Mutation(saved.Progress.Version, new([second, first], first.Url)));
            Check(reordered.Progress.Document!.Items[1].PartIndex == 1 && reordered.Progress.Document.CurrentUrl == first.Url, "Reordering preserves current identity and exact section.");
            var races = await Task.WhenAll(Enumerable.Range(0, 8).Select(i => Task.Run(() => (i % 2 == 0 ? service : other).Apply("owner", Mutation(reordered.Progress.Version)))));
            Check(races.Count(result => result.Accepted) == 1, "Concurrent queue edits have exactly one durable winner.");
            var current = service.Get("owner"); var cleared = service.Apply("owner", Mutation(current.Version, new([], null)));
            Check(cleared.Accepted && cleared.Progress.Document!.Items.Length == 0 && cleared.Progress.Version != "0", "Empty queues retain a revision.");
            var reopened = new ListeningQueueService(path);
            Check(!reopened.Apply("owner", Mutation(current.Version)).Accepted && !reopened.Apply("owner", Mutation("0")).Accepted, "Offline edits cannot resurrect cleared queues after restart.");
            Check(reopened.Get("other").Version == "0", "Queues are account isolated.");
            try { reopened.Apply("other", Mutation("0")); throw new Exception("Wrong-account mutation accepted."); } catch (UnauthorizedAccessException) { }
            foreach (var invalid in new[] { new ListeningQueueDocument([first, first], first.Url), new([first], second.Url), new([], first.Url),
                new(Enumerable.Repeat(first, 11).ToArray(), first.Url), new([first with { PartIndex = 3 }], first.Url),
                new(Enumerable.Range(0, 6).Select(i => first with { Url = "https://example.com/" + i, Parts = Enumerable.Repeat(new string('x', 1000), 19).ToArray() }).ToArray(), "https://example.com/0") })
            {
                try { service.Apply("owner", Mutation(cleared.Progress.Version, invalid)); throw new Exception("Invalid queue accepted."); } catch (ArgumentException) { }
            }
            File.WriteAllText(Path.Combine(path, NativeNotificationService.AccountKey("owner") + ".json"), "broken");
            try { reopened.Get("owner"); throw new Exception("Corrupt queue reset revision."); } catch (IOException) { }
        }
        finally { if (Directory.Exists(path)) Directory.Delete(path, true); }
        Console.WriteLine("Listen later passed order/section preservation, bounds, persistence, concurrent CAS, replay, empty revisions, account isolation and corruption checks.");
    }
}
