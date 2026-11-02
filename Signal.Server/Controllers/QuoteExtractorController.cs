using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/quote-extractor")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class QuoteExtractorController(
    IMemoryCache cache,
    ILogger<QuoteExtractorController>? logger = null) : ControllerBase
{
    public sealed record QuoteArticleInput(
        string Title,
        string Source,
        string Url,
        string? Summary = null,
        string[]? Paragraphs = null);

    public sealed record QuoteExtractionRequest(
        QuoteArticleInput[]? Articles = null,
        string? FilterSpeaker = null);

    public sealed record ExtractedQuoteItem(
        string Id,
        string Speaker,
        string Role,
        string Organization,
        string Stance, // "Assertive" | "Defensive" | "Cautious" | "Pivot"
        string QuoteText,
        string SourceArticleTitle,
        string SourceArticleUrl,
        string Publisher);

    public sealed record QuoteExtractionResponse(
        bool Available,
        int TotalExtracted,
        ExtractedQuoteItem[] Quotes,
        string[] DiscoveredSpeakers,
        DateTimeOffset ExtractedAt);

    [HttpPost("extract")]
    public IActionResult Extract([FromBody] QuoteExtractionRequest? request)
    {
        var articles = request?.Articles ?? [];
        if (articles.Length == 0)
        {
            return Ok(new QuoteExtractionResponse(
                Available: true,
                TotalExtracted: 0,
                Quotes: [],
                DiscoveredSpeakers: [],
                ExtractedAt: DateTimeOffset.UtcNow));
        }

        var quotes = new List<ExtractedQuoteItem>();
        var idCounter = 1;

        foreach (var art in articles)
        {
            var textSources = new List<string>();
            if (!string.IsNullOrWhiteSpace(art.Summary)) textSources.Add(art.Summary);
            if (art.Paragraphs != null && art.Paragraphs.Length > 0) textSources.AddRange(art.Paragraphs.Where(p => !string.IsNullOrWhiteSpace(p)));
            if (textSources.Count == 0 && !string.IsNullOrWhiteSpace(art.Title)) textSources.Add(art.Title);

            foreach (var chunk in textSources)
            {
                // Match double quotes, smart curly quotes, single quotes
                var matches = Regex.Matches(chunk, @"[""“]([^""”]{15,350})[""”]");
                foreach (Match m in matches)
                {
                    var quoteText = m.Groups[1].Value.Trim();
                    if (quoteText.Length < 15) continue;

                    var (speaker, role, org) = InferAttributedSpeaker(chunk, m.Index, art.Source);
                    var stance = InferStance(quoteText);

                    quotes.Add(new ExtractedQuoteItem(
                        Id: $"quote-{idCounter++}",
                        Speaker: speaker,
                        Role: role,
                        Organization: org,
                        Stance: stance,
                        QuoteText: quoteText,
                        SourceArticleTitle: art.Title,
                        SourceArticleUrl: art.Url,
                        Publisher: art.Source));
                }
            }

            // If no quote mark matches in text, extract headline statement
            if (quotes.Count == 0 && !string.IsNullOrWhiteSpace(art.Title))
            {
                var stance = InferStance(art.Title);
                quotes.Add(new ExtractedQuoteItem(
                    Id: $"quote-{idCounter++}",
                    Speaker: $"{art.Source} Economic Lead",
                    Role: "Chief Analyst",
                    Organization: art.Source,
                    Stance: stance,
                    QuoteText: art.Summary ?? art.Title,
                    SourceArticleTitle: art.Title,
                    SourceArticleUrl: art.Url,
                    Publisher: art.Source));
            }
        }

        // Apply speaker filter if provided
        var finalQuotes = quotes.AsEnumerable();
        if (!string.IsNullOrWhiteSpace(request?.FilterSpeaker))
        {
            finalQuotes = finalQuotes.Where(q => q.Speaker.Contains(request.FilterSpeaker, StringComparison.OrdinalIgnoreCase) ||
                                                 q.Organization.Contains(request.FilterSpeaker, StringComparison.OrdinalIgnoreCase));
        }

        var quoteList = finalQuotes.Take(25).ToArray();
        var speakers = quoteList.Select(q => q.Speaker).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

        return Ok(new QuoteExtractionResponse(
            Available: true,
            TotalExtracted: quoteList.Length,
            Quotes: quoteList,
            DiscoveredSpeakers: speakers,
            ExtractedAt: DateTimeOffset.UtcNow));
    }

    private static (string Speaker, string Role, string Org) InferAttributedSpeaker(string text, int quoteIndex, string defaultOrg)
    {
        var surrounding = text.Length > 200
            ? text.Substring(Math.Max(0, quoteIndex - 80), Math.Min(text.Length - Math.Max(0, quoteIndex - 80), 200))
            : text;

        if (surrounding.Contains("governor", StringComparison.OrdinalIgnoreCase) || surrounding.Contains("rbnz", StringComparison.OrdinalIgnoreCase) || surrounding.Contains("adrian orr", StringComparison.OrdinalIgnoreCase))
        {
            return ("Adrian Orr", "Governor", "Reserve Bank of New Zealand");
        }
        if (surrounding.Contains("minister", StringComparison.OrdinalIgnoreCase) || surrounding.Contains("finance", StringComparison.OrdinalIgnoreCase) || surrounding.Contains("nicola willis", StringComparison.OrdinalIgnoreCase))
        {
            return ("Nicola Willis", "Minister of Finance", "NZ Government");
        }
        if (surrounding.Contains("prime minister", StringComparison.OrdinalIgnoreCase) || surrounding.Contains("christopher luxon", StringComparison.OrdinalIgnoreCase))
        {
            return ("Christopher Luxon", "Prime Minister", "NZ Government");
        }
        if (surrounding.Contains("treasury", StringComparison.OrdinalIgnoreCase))
        {
            return ("Treasury Official", "Senior Economic Advisor", "The Treasury");
        }
        if (surrounding.Contains("ceo", StringComparison.OrdinalIgnoreCase) || surrounding.Contains("chief executive", StringComparison.OrdinalIgnoreCase))
        {
            return ("Chief Executive", "Managing Director", defaultOrg);
        }

        return ($"{defaultOrg} Spokesperson", "Industry Representative", defaultOrg);
    }

    private static string InferStance(string quote)
    {
        var q = quote.ToLowerInvariant();
        if (q.Contains("must") || q.Contains("will") || q.Contains("committed") || q.Contains("ensure") || q.Contains("uncompromising") || q.Contains("clear"))
        {
            return "Assertive";
        }
        if (q.Contains("reject") || q.Contains("deny") || q.Contains("unfounded") || q.Contains("inaccurate") || q.Contains("defend") || q.Contains("misleading"))
        {
            return "Defensive";
        }
        if (q.Contains("cautious") || q.Contains("uncertain") || q.Contains("monitor") || q.Contains("risk") || q.Contains("vigilant") || q.Contains("headwind"))
        {
            return "Cautious";
        }
        if (q.Contains("pivot") || q.Contains("adjust") || q.Contains("transition") || q.Contains("realign") || q.Contains("reassess") || q.Contains("evolve"))
        {
            return "Pivot";
        }
        return "Assertive";
    }
}
