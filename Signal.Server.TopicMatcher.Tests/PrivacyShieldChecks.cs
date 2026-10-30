using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class PrivacyShieldChecks
{
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    public static async Task RunAsync()
    {
        // 1. Local fallback and regex redaction
        var localResult = AzureLanguagePiiService.LocalRedact("Contact me at user@example.test or 021-555-1234 or card 4111-2222-3333-4444");
        Require(localResult.HasPii, "Local redaction should detect PII.");
        Require(localResult.Entities.Length == 3, "Should detect 3 PII entities.");
        Require(!localResult.RedactedText.Contains("user@example.test"), "Email should be redacted.");
        Require(!localResult.RedactedText.Contains("021-555-1234"), "Phone number should be redacted.");
        Require(!localResult.RedactedText.Contains("4111-2222-3333-4444"), "Card number should be redacted.");

        // 2. Disabled Azure Language service falls back cleanly
        var options = Options.Create(new AzureLanguageOptions());
        var cache = new MemoryCache(new MemoryCacheOptions());
        var factory = new TestHttpClientFactory();
        var service = new AzureLanguagePiiService(options, factory, cache, NullLogger<AzureLanguagePiiService>.Instance);
        Require(!service.Enabled, "Service should report not enabled.");

        var unconfiguredResult = await service.AnalyzeAndRedactAsync("Reach me at secret@corp.org", CancellationToken.None);
        Require(unconfiguredResult.HasPii, "Unconfigured service should apply local fallback.");
        Require(!unconfiguredResult.RedactedText.Contains("secret@corp.org"), "Email should be masked by fallback.");

        // 3. Azure Language JSON parsing
        const string piiJson = """
        {
            "kind": "PiiEntityRecognitionResults",
            "results": {
                "documents": [
                    {
                        "id": "1",
                        "redactedText": "Please call ************ or email ******************",
                        "entities": [
                            {
                                "text": "021-123-4567",
                                "category": "PhoneNumber",
                                "subcategory": null,
                                "offset": 12,
                                "length": 12,
                                "confidenceScore": 0.92
                            },
                            {
                                "text": "support@example.com",
                                "category": "Email",
                                "subcategory": null,
                                "offset": 34,
                                "length": 19,
                                "confidenceScore": 0.99
                            }
                        ],
                        "warnings": []
                    }
                ],
                "errors": [],
                "modelVersion": "2023-04-01"
            }
        }
        """;
        using (var doc = JsonDocument.Parse(piiJson))
        {
            var parsed = AzureLanguagePiiService.Parse(doc.RootElement, "Please call 021-123-4567 or email support@example.com");
            Require(parsed.Available, "Parsed result should be available.");
            Require(parsed.HasPii, "Parsed result should indicate PII.");
            Require(parsed.HasHighRiskPii, "PhoneNumber and Email are high-risk PII.");
            Require(parsed.Entities.Length == 2, "Should parse two entities.");
            Require(parsed.Entities[0].Category == "PhoneNumber", "First entity should be PhoneNumber.");
            Require(parsed.Entities[1].Category == "Email", "Second entity should be Email.");
            Require(parsed.RedactedText.StartsWith("Please call ************"), "Should contain Azure redactedText.");
        }

        // 4. PrivacyShieldController endpoint checks
        var controller = new PrivacyShieldController(service);
        var emptyRes = (PiiAnalysisResult)((OkObjectResult)await controller.Redact(new(null), CancellationToken.None)).Value!;
        Require(!emptyRes.HasPii && emptyRes.RedactedText == "", "Empty text should return blank result.");

        var tooLong = await controller.Redact(new(new string('a', 4_001)), CancellationToken.None);
        Require(tooLong is BadRequestObjectResult, "Controller should reject text over 4000 characters.");

        var redactRes = (PiiAnalysisResult)((OkObjectResult)await controller.Redact(new("Send to help@test.nz"), CancellationToken.None)).Value!;
        Require(redactRes.HasPii && !redactRes.RedactedText.Contains("help@test.nz"), "Controller should return redacted output.");

        // 5. SharedCommentsController automatic PII protection
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var dbOptions = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options;
        await using var database = new SignalDbContext(dbOptions);
        await database.Database.EnsureCreatedAsync();
        database.Users.Add(new ApplicationUser { Id = "user1", UserName = "user1@example.test" });
        await database.SaveChangesAsync();
        await AnonymousCommentSchema.UpgradeAsync(database);

        var share = new SharedNewsArticle
        {
            Id = new string('c', 48),
            UserId = "user1",
            ContentHash = "hash",
            OriginalUrl = "https://publisher.test/news",
            DiscussionUrl = "https://example.test/news",
            Title = "Tech News"
        };
        database.SharedNewsArticles.Add(share);
        await database.SaveChangesAsync();

        var sharedComments = new SharedCommentsController(database, null, service);
        var created = (SharedCommentsController.PublicComment)((OkObjectResult)await sharedComments.Create(
            share.Id,
            new("Call my cell 021-555-9876 to chat", "Dave"),
            CancellationToken.None)).Value!;

        Require(!created.Body.Contains("021-555-9876"), "Shared comment must sanitize phone number.");
        Require(created.Body.Contains("Call my cell"), "Shared comment should preserve harmless text.");
    }

    private sealed class TestHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
