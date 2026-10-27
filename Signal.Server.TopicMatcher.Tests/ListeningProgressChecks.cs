using Signal.Server.Services;

internal static class ListeningProgressChecks
{
    private static void Check(bool value, string why) { if (!value) throw new Exception(why); }
    public static async Task RunAsync()
    {
        var path = Path.Combine(Path.GetTempPath(), "signal-progress-" + Guid.NewGuid().ToString("N"));
        try
        {
            var service = new ListeningProgressService(path); var otherProcess = new ListeningProgressService(path);
            var document = new ListeningProgressDocument("https://example.com/story", "Story", "Publisher", ["Heading", "Section one", "Section two"], 1);
            ListeningProgressMutation Mutation(string version, string action = "save") => new(NativeNotificationService.AccountKey("owner"), version, Guid.NewGuid().ToString("N"), action, action == "save" ? document : null);
            Check(service.Get("owner").Version == "0", "New accounts begin with an empty revision.");
            var first = Mutation("0"); var result = service.Apply("owner", first);
            Check(result.Accepted && service.Apply("owner", first).Progress.Version == result.Progress.Version, "An acknowledged write can be retried without advancing the revision.");
            document.Parts[0] = "Caller mutation";
            Check(service.Get("owner").Document!.Parts[0] == "Heading", "A caller must not mutate durable text.");
            Check(!service.Apply("owner", first with { Document = document }).Accepted, "Reusing an operation ID with different content must not overwrite state.");
            var current = service.Get("owner");
            var races = await Task.WhenAll(Enumerable.Range(0, 12).Select(i => Task.Run(() => (i % 2 == 0 ? service : otherProcess).Apply("owner", Mutation(current.Version)))));
            Check(races.Count(value => value.Accepted) == 1, "Concurrent writers across service instances must have exactly one winner.");
            current = service.Get("owner");
            var forgotten = service.Apply("owner", Mutation(current.Version, "forget"));
            Check(forgotten.Accepted && forgotten.Progress.Document is null && forgotten.Progress.State == "forgotten", "Forget removes story text and retains a tombstone revision.");
            var reopened = new ListeningProgressService(path);
            Check(!reopened.Apply("owner", Mutation(current.Version)).Accepted && !reopened.Apply("owner", Mutation("0")).Accepted, "Restart and old offline updates must not resurrect forgotten text.");
            var resume = reopened.Apply("owner", Mutation(forgotten.Progress.Version));
            var completed = reopened.Apply("owner", Mutation(resume.Progress.Version, "complete"));
            Check(completed.Accepted && completed.Progress.Document is null && completed.Progress.State == "completed", "Completion clears shared text with a new revision.");
            Check(reopened.Get("another").Version == "0", "Progress is account isolated.");
            try { reopened.Apply("another", Mutation("0")); throw new Exception("Account switching was accepted."); } catch (UnauthorizedAccessException) { }
            var file = Path.Combine(path, NativeNotificationService.AccountKey("owner") + ".json");
            File.WriteAllText(file, "broken");
            try { reopened.Get("owner"); throw new Exception("Corrupt progress reset to zero."); } catch (IOException) { }
        }
        finally { if (Directory.Exists(path)) Directory.Delete(path, true); }
        Console.WriteLine("Shared listening progress passed persistence, atomic races, idempotency, stale offline conflicts, account isolation, completion, forget and corruption checks.");
    }
}
