using Signal.Server.Services;

internal static class BriefingProgressChecks
{
    private static void Check(bool value, string why) { if (!value) throw new Exception(why); }

    public static async Task RunAsync()
    {
        var path = Path.Combine(Path.GetTempPath(), "signal-briefing-progress-" + Guid.NewGuid().ToString("N"));
        try
        {
            var service = new BriefingProgressService(path);
            var otherProcess = new BriefingProgressService(path);

            var items = new[]
            {
                new BriefingProgressItem("https://example.com/story-1", "Story 1", "Publisher A", ["Part 1", "Part 2"], "https://example.com/img1.jpg", CatchUpKeys: new() { ["https://example.com/story-1"] = "a".repeat(64) }),
                new BriefingProgressItem("https://example.com/story-2", "Story 2", "Publisher B", ["Intro", "Body", "Outro"], CatchUpKeys: new() { ["https://example.com/story-2"] = "b".repeat(64) })
            };
            var document = new BriefingProgressDocument(items, 0, 1, Shuffled: false, Heard: ["https://example.com/story-1"],
                CatchUpHeard: new() { ["https://example.com/story-1"] = "a".repeat(64) });

            BriefingProgressMutation Mutation(string version, string action = "save", BriefingProgressDocument? doc = null) =>
                new(NativeNotificationService.AccountKey("owner"), version, Guid.NewGuid().ToString("N"), action, action == "save" ? (doc ?? document) : null);

            Check(service.Get("owner").Version == "0", "New accounts begin with an empty briefing progress revision.");

            var first = Mutation("0");
            var result = service.Apply("owner", first);
            Check(result.Accepted && service.Apply("owner", first).Progress.Version == result.Progress.Version,
                "An acknowledged write can be retried idempotently without advancing the revision.");

            items[0].Parts[0] = "Caller mutation";
            Check(service.Get("owner").Document!.Items[0].Parts[0] == "Part 1", "A caller must not mutate durable text.");

            Check(!service.Apply("owner", first with { Document = document with { Index = 1 } }).Accepted,
                "Reusing an operation ID with different content must not overwrite state.");

            var current = service.Get("owner");
            var races = await Task.WhenAll(Enumerable.Range(0, 12).Select(i => Task.Run(() =>
                (i % 2 == 0 ? service : otherProcess).Apply("owner", Mutation(current.Version)))));
            Check(races.Count(value => value.Accepted) == 1,
                "Concurrent writers across service instances must have exactly one winner.");

            // Test catch-up heard merging
            current = service.Get("owner");
            var docWithMoreHeard = document with
            {
                CatchUpHeard = new Dictionary<string, string>
                {
                    ["https://example.com/story-2"] = "b".repeat(64),
                    ["https://example.com/story-3"] = "c".repeat(64)
                }
            };
            var mergeResult = service.Apply("owner", Mutation(current.Version, "save", docWithMoreHeard));
            Check(mergeResult.Accepted, "Valid update with new heard fingerprints is accepted.");
            var savedHeard = service.Get("owner").Document!.CatchUpHeard!;
            Check(savedHeard.ContainsKey("https://example.com/story-1") && savedHeard.ContainsKey("https://example.com/story-2") && savedHeard.ContainsKey("https://example.com/story-3"),
                "Catch-up heard fingerprints must be merged across updates.");

            current = service.Get("owner");
            var forgotten = service.Apply("owner", Mutation(current.Version, "forget"));
            Check(forgotten.Accepted && forgotten.Progress.Document is null && forgotten.Progress.State == "forgotten",
                "Forget removes briefing document and retains a tombstone revision.");

            var reopened = new BriefingProgressService(path);
            Check(!reopened.Apply("owner", Mutation(current.Version)).Accepted && !reopened.Apply("owner", Mutation("0")).Accepted,
                "Restart and old offline updates must not resurrect forgotten text.");

            var resume = reopened.Apply("owner", Mutation(forgotten.Progress.Version));
            var completed = reopened.Apply("owner", Mutation(resume.Progress.Version, "complete"));
            Check(completed.Accepted && completed.Progress.Document is null && completed.Progress.State == "completed",
                "Completion clears shared briefing text with a new revision.");

            Check(reopened.Get("another").Version == "0", "Progress is account isolated.");
            try
            {
                reopened.Apply("another", Mutation("0"));
                throw new Exception("Account switching was accepted.");
            }
            catch (UnauthorizedAccessException) { }

            var file = Path.Combine(path, NativeNotificationService.AccountKey("owner") + ".json");
            File.WriteAllText(file, "corrupt content");
            try
            {
                reopened.Get("owner");
                throw new Exception("Corrupt progress reset to zero.");
            }
            catch (IOException) { }
        }
        finally
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        Console.WriteLine("Briefing progress passed persistence, atomic races, idempotency, fingerprint merging, stale offline conflicts, account isolation, completion, forget and corruption checks.");
    }

    private static string repeat(this string s, int count) => string.Concat(Enumerable.Repeat(s, count));
}
