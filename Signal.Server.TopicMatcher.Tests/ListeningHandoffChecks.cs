using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class ListeningHandoffChecks
{
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-10-27T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private static ListeningHandoffDocument Document() => new("https://example.com/news", "Story", "Publisher", ["Heading.", "First section.", "Updated second section."], 0);
    public static async Task RunAsync()
    {
        var clock = new Clock(); var service = new ListeningHandoffService(clock);
        var sourceDocument = Document(); var created = service.Create("owner", sourceDocument);
        sourceDocument.Parts[0] = "Changed caller array";
        var receiver = new string('a', 64); var other = new string('b', 64);
        Check(service.Get("stranger", created.Id) is null, "Transfers must be scoped to the authenticated account.");
        Check(!service.Ready("owner", created.Id, created.SourceToken, 0), "A phone must explicitly accept before the watch may acknowledge pausing.");
        Check(service.Get("owner", created.Id)!.Parts is null, "Pending transfers must not expose playable text.");
        var claims = await Task.WhenAll(Enumerable.Range(0, 12).Select(i => Task.Run(() => service.Accept("owner", created.Id, i % 2 == 0 ? receiver : other))));
        Check(claims.Count(value => value) == 6, "Concurrent receivers cannot both claim the transfer; same-receiver retries are idempotent.");
        var winner = service.Accept("owner", created.Id, receiver) ? receiver : other;
        var loser = winner == receiver ? other : receiver;
        Check(!service.Ready("owner", created.Id, loser, 2), "Phone receiver credentials cannot impersonate the watch pause acknowledgement.");
        Check(service.Get("owner", created.Id, winner)!.Parts is null, "Accepted transfers still cannot start until the watch confirms pausing.");
        Check(service.Ready("owner", created.Id, created.SourceToken, 2), "The watch can acknowledge its latest section rather than the initial one.");
        var ready = service.Get("owner", created.Id, winner)!;
        Check(ready.PartIndex == 2 && ready.Parts![0] == "Heading.", "The exact source text and refreshed section must survive handoff.");
        ready.Parts![0] = "Changed receiver array";
        Check(service.Get("owner", created.Id, winner)!.Parts![0] == "Heading.", "Returned arrays cannot mutate stored transfer text.");
        Check(service.Get("owner", created.Id, loser)!.Parts is null && service.Get("owner", created.Id)!.Parts is null, "Only the claiming receiver can retrieve ready text.");
        Check(!service.Cancel("owner", created.Id, created.SourceToken, null), "A completed transfer must not be silently rewound.");
        Check(service.Ready("owner", created.Id, created.SourceToken, 2) && !service.Ready("owner", created.Id, created.SourceToken, 1), "Ready acknowledgement retries must not replace the confirmed position.");
        var pending = service.Create("owner", Document());
        Check(service.Cancel("owner", pending.Id, null, receiver), "Not now cancels a pending transfer without pausing the watch.");
        Check(service.Get("owner", pending.Id)!.Status == "cancelled" && !service.Accept("owner", pending.Id, receiver), "Cancelled transfers cannot later acquire playback.");
        var timeout = service.Create("owner", Document()); service.Accept("owner", timeout.Id, receiver);
        clock.Now = clock.Now.AddSeconds(46);
        Check(service.Get("owner", timeout.Id, receiver) is null && !service.Ready("owner", timeout.Id, timeout.SourceToken, 0), "Missing watch acknowledgement must expire instead of allowing phone playback.");
        var bounded = new ListeningHandoffService(clock, 1); bounded.Create("owner", Document());
        try { bounded.Create("another", Document()); throw new Exception("Capacity must be bounded."); } catch (InvalidOperationException) { }
        clock.Now = clock.Now.AddMinutes(6); bounded.Create("another", Document());
        foreach (var invalid in new[] { Document() with { Url = "file:///private" }, Document() with { Url = "https://user:secret@example.com/news" },
            Document() with { Url = "http://localhost/private" }, Document() with { PartIndex = 3 }, Document() with { Parts = [" "] },
            Document() with { Parts = Enumerable.Repeat(new string('x', 1000), 20).ToArray() } })
        {
            try { service.Create("owner", invalid); throw new Exception("Malformed transfer was accepted."); } catch (ArgumentException) { }
        }
        var reverse = service.Create("owner", Document() with { Target = "watch", ImageUrl = "https://images.example.com/story.jpg" });
        Check(service.Inbox("stranger").Length == 0 && service.Inbox("owner").Single().Id == reverse.Id, "Only the owning watch inbox discovers phone transfers.");
        Check(service.Inbox("owner").Single().Parts is null, "Inbox discovery must never expose playable text.");
        Check(service.Inbox("owner").Single().ImageUrl == "https://images.example.com/story.jpg", "Available image metadata must reach the watch without fetching an image on the server.");
        foreach (var image in new[] { "javascript:alert(1)", "https://user:secret@example.com/image", "https://localhost/image" })
        {
            try { service.Create("owner", Document() with { ImageUrl = image }); throw new Exception("Unsafe image metadata was accepted."); } catch (ArgumentException) { }
        }
        Check(!service.Accept("owner", reverse.Id, receiver) && service.Accept("owner", reverse.Id, receiver, "watch"), "Receivers must match the intended device direction.");
        Check(service.Inbox("owner").Length == 0 && service.Get("owner", reverse.Id, receiver)!.Parts is null, "Claimed offers leave discovery and still wait for phone pause.");
        Check(!service.Ready("owner", reverse.Id, receiver, 2) && service.Ready("owner", reverse.Id, reverse.SourceToken, 2), "Only the phone's source proof confirms a reverse transfer.");
        Check(service.Get("owner", reverse.Id, receiver)!.Parts!.SequenceEqual(Document().Parts), "Watch receives the exact confirmed phone sections.");
        await HttpChecksAsync();
        Console.WriteLine("Listening handoff passed exact text/section, two-phase playback, concurrent claims, identity, capacity, expiry, authorization and CSRF checks.");
    }
    private static async Task HttpChecksAsync()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Development" });
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0"); builder.Logging.ClearProviders();
        builder.Services.AddAuthentication("test").AddCookie("test", options => options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; });
        builder.Services.AddAuthorization(); builder.Services.AddAntiforgery(options => options.HeaderName = "X-XSRF-TOKEN");
        builder.Services.AddControllersWithViews(options => options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute())).AddApplicationPart(typeof(ListeningHandoffsController).Assembly);
        builder.Services.AddSingleton<ListeningHandoffService>();
        var progressDirectory = Path.Combine(Path.GetTempPath(), "signal-progress-http-" + Guid.NewGuid().ToString("N"));
        builder.Services.AddSingleton(new ListeningProgressService(progressDirectory));
        builder.Services.AddSingleton(new ListeningQueueService(Path.Combine(progressDirectory, "queue")));
        builder.Services.AddRateLimiter(options => options.AddFixedWindowLimiter("listening-handoff", value => { value.PermitLimit = 1000; value.Window = TimeSpan.FromMinutes(1); }));
        await using var app = builder.Build();
        app.UseRouting(); app.UseAuthentication(); app.UseAuthorization(); app.UseRateLimiter(); app.MapControllers();
        app.MapGet("/test/login/{user}", async (HttpContext context, string user) => {
            await context.SignInAsync("test", new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, user), new Claim(ClaimTypes.Email, user + "@example.com")], "test"))); return Results.Ok();
        });
        app.MapGet("/test/csrf", (HttpContext context, IAntiforgery csrf) => Results.Json(new { token = csrf.GetAndStoreTokens(context).RequestToken }));
        await app.StartAsync();
        try
        {
            var origin = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            using var watch = new HttpClient(new HttpClientHandler { CookieContainer = new(), AllowAutoRedirect = false }) { BaseAddress = new(origin) };
            using var phone = new HttpClient(new HttpClientHandler { CookieContainer = new(), AllowAutoRedirect = false }) { BaseAddress = new(origin) };
            using var stranger = new HttpClient(new HttpClientHandler { CookieContainer = new(), AllowAutoRedirect = false }) { BaseAddress = new(origin) };
            Check((await watch.GetAsync("/api/listening-handoffs/" + new string('a', 64))).StatusCode == HttpStatusCode.Unauthorized, "Anonymous handoff reads must fail.");
            Check((await watch.PostAsJsonAsync("/api/listening-handoffs", Document())).StatusCode == HttpStatusCode.Unauthorized, "Anonymous handoff creation must fail.");
            Check((await watch.GetAsync("/api/listening-handoffs/inbox")).StatusCode == HttpStatusCode.Unauthorized, "Anonymous inbox discovery must fail.");
            Check((await watch.GetAsync("/api/listening-progress")).StatusCode == HttpStatusCode.Unauthorized, "Anonymous shared progress must fail.");
            Check((await watch.GetAsync("/api/listening-queue")).StatusCode == HttpStatusCode.Unauthorized, "Anonymous queues must fail.");
            foreach (var client in new[] { watch, phone }) await client.GetAsync("/test/login/owner");
            await stranger.GetAsync("/test/login/stranger");
            Check((await watch.PostAsJsonAsync("/api/listening-handoffs", Document())).StatusCode == HttpStatusCode.BadRequest, "Signed-in creation must require CSRF.");
            Check((await watch.PostAsJsonAsync("/api/listening-progress", new { accountKey = NativeNotificationService.AccountKey("owner"), baseVersion = "0", operationId = Guid.NewGuid().ToString("N"), action = "forget" })).StatusCode == HttpStatusCode.BadRequest, "Shared progress writes require CSRF.");
            Check((await watch.PostAsJsonAsync("/api/listening-queue", new { })).StatusCode == HttpStatusCode.BadRequest, "Queue writes require CSRF.");
            foreach (var client in new[] { watch, phone, stranger })
            {
                var csrf = await client.GetFromJsonAsync<JsonElement>("/test/csrf");
                client.DefaultRequestHeaders.Add("X-XSRF-TOKEN", csrf.GetProperty("token").GetString());
            }
            var response = await watch.PostAsJsonAsync("/api/listening-handoffs", Document());
            Check(response.IsSuccessStatusCode, "Authenticated, CSRF-protected creation must work.");
            var offer = await response.Content.ReadFromJsonAsync<ListeningHandoffCreated>(); var path = "/api/listening-handoffs/" + offer!.Id;
            Check((await stranger.GetAsync(path)).StatusCode == HttpStatusCode.NotFound, "Other accounts cannot read transfers.");
            Check((await stranger.PostAsJsonAsync(path + "/accept", new { receiverToken = new string('c', 64) })).StatusCode == HttpStatusCode.Conflict, "Other accounts cannot claim transfers.");
            Check((await watch.PostAsJsonAsync(path + "/ready", new { sourceToken = offer.SourceToken, partIndex = 2 })).StatusCode == HttpStatusCode.Conflict, "HTTP ready cannot bypass phone consent.");
            var key = new string('a', 64);
            Check((await phone.PostAsJsonAsync(path + "/accept", new { receiverToken = key })).IsSuccessStatusCode, "Phone consent must claim the transfer.");
            Check((await phone.PostAsJsonAsync(path + "/ready", new { sourceToken = key, partIndex = 2 })).StatusCode == HttpStatusCode.Conflict, "Receiver cannot forge watch pause acknowledgement.");
            Check((await watch.PostAsJsonAsync(path + "/ready", new { sourceToken = offer.SourceToken, partIndex = 2 })).IsSuccessStatusCode, "Watch can acknowledge pausing through HTTP.");
            phone.DefaultRequestHeaders.Add("X-Signal-Handoff-Receiver", key);
            var ready = await phone.GetAsync(path); var data = await ready.Content.ReadFromJsonAsync<ListeningHandoffView>();
            Check(data!.PartIndex == 2 && data.Parts!.SequenceEqual(Document().Parts), "HTTP phone receives the exact source section text.");
            Check(ready.Headers.CacheControl?.NoStore == true, "Private transfer text must not be cached by intermediaries.");
            var reverseResponse = await phone.PostAsJsonAsync("/api/listening-handoffs", Document() with { Target = "watch" });
            var reverse = (await reverseResponse.Content.ReadFromJsonAsync<ListeningHandoffCreated>())!;
            var inbox = await watch.GetFromJsonAsync<ListeningHandoffView[]>("/api/listening-handoffs/inbox");
            Check(inbox!.Length == 1 && inbox[0].Id == reverse.Id && inbox[0].Parts is null && inbox[0].Target == "watch", "Watch discovery is metadata-only and direction-scoped.");
            Check((await stranger.GetFromJsonAsync<ListeningHandoffView[]>("/api/listening-handoffs/inbox"))!.Length == 0, "Other accounts cannot discover phone transfers.");
            var reversePath = "/api/listening-handoffs/" + reverse.Id;
            Check((await watch.PostAsJsonAsync(reversePath + "/accept", new { receiverToken = key })).StatusCode == HttpStatusCode.Conflict, "Old phone consent cannot claim a watch-targeted offer.");
            Check((await watch.PostAsJsonAsync(reversePath + "/accept", new { receiverToken = key, target = "watch" })).IsSuccessStatusCode, "Watch explicitly accepts the phone offer.");
            Check((await phone.PostAsJsonAsync(reversePath + "/ready", new { sourceToken = reverse.SourceToken, partIndex = 1 })).IsSuccessStatusCode, "Phone pause acknowledgement confirms the current section.");
            watch.DefaultRequestHeaders.Add("X-Signal-Handoff-Receiver", key);
            Check((await watch.GetFromJsonAsync<ListeningHandoffView>(reversePath))!.PartIndex == 1, "Watch receives the refreshed section through HTTP.");
            var sharedMutation = new ListeningProgressMutation(NativeNotificationService.AccountKey("owner"), "0", Guid.NewGuid().ToString("N"), "save", new("https://example.com/story", "Story", "Publisher", ["Title", "Section"], 1));
            var sharedReply = await phone.PostAsJsonAsync("/api/listening-progress", sharedMutation);
            Check(sharedReply.IsSuccessStatusCode && sharedReply.Headers.CacheControl?.NoStore == true, "Shared progress is authenticated, CSRF-protected and no-store.");
            Check((await stranger.PostAsJsonAsync("/api/listening-progress", sharedMutation)).StatusCode == HttpStatusCode.Forbidden, "Queued old-account work must fail after an account switch.");
            Check((await watch.PostAsJsonAsync("/api/listening-progress", sharedMutation with { OperationId = Guid.NewGuid().ToString("N") })).StatusCode == HttpStatusCode.Conflict, "HTTP stale updates must return the current shared state with 409.");
            var shared = await watch.GetFromJsonAsync<JsonElement>("/api/listening-progress");
            Check(shared.GetProperty("document").GetProperty("partIndex").GetInt32() == 1, "The other device receives exact current sections.");
            Check(shared.GetProperty("accountEmail").GetString() == "owner@example.com", "Browser bootstrap verifies the signed-in account identity.");
            var queued = new ListeningQueueMutation(NativeNotificationService.AccountKey("owner"), "0", Guid.NewGuid().ToString("N"), "save",
                new([sharedMutation.Document!], sharedMutation.Document!.Url));
            var queueReply = await phone.PostAsJsonAsync("/api/listening-queue", queued);
            Check(queueReply.IsSuccessStatusCode && queueReply.Headers.CacheControl?.NoStore == true, "Queue updates are authenticated, CSRF-protected and no-store.");
            Check((await stranger.PostAsJsonAsync("/api/listening-queue", queued)).StatusCode == HttpStatusCode.Forbidden, "Queued work cannot cross accounts.");
            Check((await watch.PostAsJsonAsync("/api/listening-queue", queued with { OperationId = Guid.NewGuid().ToString("N") })).StatusCode == HttpStatusCode.Conflict, "Stale queue writes return 409.");
            var queueState = await watch.GetFromJsonAsync<JsonElement>("/api/listening-queue");
            Check(queueState.GetProperty("document").GetProperty("items")[0].GetProperty("partIndex").GetInt32() == 1, "HTTP queue resume preserves exact sections.");
            var queueVersion = queueState.GetProperty("version").GetString()!;
            var queueOfferReply = await phone.PostAsJsonAsync("/api/listening-handoffs", new ListeningHandoffDocument(sharedMutation.Document.Url,
                sharedMutation.Document.Title, sharedMutation.Document.Source, sharedMutation.Document.Parts, 1, "watch", QueueVersion: queueVersion));
            Check(queueOfferReply.IsSuccessStatusCode, "A synced queue can offer an authenticated handoff.");
            var queueOffer = (await queueOfferReply.Content.ReadFromJsonAsync<ListeningHandoffCreated>())!;
            var queuePath = "/api/listening-handoffs/" + queueOffer.Id;
            Check((await watch.GetFromJsonAsync<ListeningHandoffView[]>("/api/listening-handoffs/inbox"))!.All(item => item.Id != queueOffer.Id), "Old inbox clients cannot see queue offers.");
            Check((await watch.GetFromJsonAsync<ListeningHandoffView[]>("/api/listening-handoffs/inbox?queues=true"))!.Any(item => item.Id == queueOffer.Id && item.IsQueue && item.Queue is null), "Capable clients discover metadata only.");
            Check((await watch.PostAsJsonAsync(queuePath + "/accept", new { receiverToken = key, target = "watch" })).StatusCode == HttpStatusCode.Conflict, "An old receiver cannot truncate a queue to one story.");
            Check((await watch.PostAsJsonAsync(queuePath + "/accept", new { receiverToken = key, target = "watch", supportsQueue = true })).IsSuccessStatusCode, "A capable watch explicitly accepts the queue.");
            Check((await phone.PostAsJsonAsync(queuePath + "/ready", new { sourceToken = queueOffer.SourceToken, partIndex = 1 })).StatusCode == HttpStatusCode.Conflict, "Readiness must confirm a durable queue revision.");
            Check((await phone.PostAsJsonAsync(queuePath + "/ready", new { sourceToken = queueOffer.SourceToken, partIndex = 1, queueVersion })).IsSuccessStatusCode, "Source pause confirms the queue revision.");
            var transferred = await watch.GetFromJsonAsync<ListeningHandoffView>(queuePath);
            Check(transferred!.Queue!.Items.Length == 1 && transferred.QueueVersion != queueVersion && transferred.Queue.Items[0].PartIndex == 1, "The receiver gets the exact queue and fresh revision through HTTP.");
            Check((await phone.PostAsJsonAsync("/api/listening-queue", queued with { BaseVersion = queueVersion, OperationId = Guid.NewGuid().ToString("N") })).StatusCode == HttpStatusCode.Conflict, "Source replay cannot overwrite a transferred queue.");
            watch.DefaultRequestHeaders.Add("X-Signal-Progress-Account", NativeNotificationService.AccountKey("another"));
            Check((await watch.GetAsync("/api/listening-progress")).StatusCode == HttpStatusCode.Forbidden, "An old account-scoped reader cannot fetch a newly signed-in account's progress.");
            Check((await watch.GetAsync("/api/listening-queue")).StatusCode == HttpStatusCode.Forbidden, "Old queue readers cannot read another account after sign-in changes.");
        }
        finally { await app.StopAsync(); if (Directory.Exists(progressDirectory)) Directory.Delete(progressDirectory, true); }
    }
}
