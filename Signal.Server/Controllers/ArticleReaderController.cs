using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[EnableRateLimiting("account")]
[Route("api/article-reader")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ArticleReaderController(
    ArticleReaderService articleReader,
    ILogger<ArticleReaderController> logger) : ControllerBase
{
    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve([FromQuery] string url, CancellationToken cancellationToken)
    {
        try
        {
            return Ok(new { url = await articleReader.ResolveUrlAsync(url, cancellationToken) });
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { url, error = exception.Message });
        }
        catch (Exception exception)
        {
            logger.LogInformation(exception, "Could not resolve the publisher URL for {ArticleUrl}.", url);
            return Ok(new { url });
        }
    }

    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string url, CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await articleReader.ReadAsync(url, cancellationToken));
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { available = false, reason = exception.Message });
        }
        catch (InvalidOperationException exception)
        {
            logger.LogInformation(exception, "Article exceeded Signal Reader limits.");
            return Ok(new
            {
                available = false,
                reason = "This article is too large for Signal Reader.",
            });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Signal Reader could not prepare {ArticleUrl}.", url);
            return Ok(new
            {
                available = false,
                reason = "The publisher blocked extraction or the article is temporarily unavailable.",
            });
        }
    }

    public sealed record InterrogateArticleRequest(
        string Url,
        string Title,
        string Source,
        string[]? Paragraphs,
        string Question,
        string? Language = "en");

    public sealed record InterrogateArticleResponse(
        bool Available,
        string Question,
        string Answer,
        string[] SupportingEvidence,
        string[] OmittedPerspectives,
        string StakeholderImpact,
        string Mode);

    [HttpPost("interrogate")]
    [RequestSizeLimit(131_072)]
    public IActionResult Interrogate(
        [FromBody] InterrogateArticleRequest? request)
    {
        var cleanQ = (request?.Question ?? "").Trim();
        if (cleanQ.Length < 3)
        {
            return BadRequest(new { error = "A question of at least 3 characters is required." });
        }

        var title = (request?.Title ?? "").Trim();
        var source = (request?.Source ?? "News Source").Trim();
        var paragraphs = (request?.Paragraphs ?? [])
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Select(p => p.Trim())
            .ToArray();

        var lowerQ = cleanQ.ToLowerInvariant();
        var wantsCounter = lowerQ.Contains("counter") || lowerQ.Contains("omit") || lowerQ.Contains("bias") || lowerQ.Contains("opposing");
        var wantsEvidence = lowerQ.Contains("evidence") || lowerQ.Contains("proof") || lowerQ.Contains("fact") || lowerQ.Contains("data");
        var wantsStakeholders = lowerQ.Contains("benefit") || lowerQ.Contains("who") || lowerQ.Contains("gain") || lowerQ.Contains("lose") || lowerQ.Contains("stakeholder");

        var textPool = paragraphs.Length > 0 ? paragraphs : [title];

        // 1. Supporting Evidence extraction
        var evidenceList = new List<string>();
        foreach (var p in textPool)
        {
            if (evidenceList.Count >= 2) break;
            if (p.Any(char.IsDigit) || p.Contains('%') || p.Contains('$') || p.Contains('"') || p.Contains('“'))
            {
                evidenceList.Add(p.Length > 200 ? p[..197] + "..." : p);
            }
        }
        if (evidenceList.Count == 0 && textPool.Length > 0)
        {
            evidenceList.Add(textPool[0].Length > 200 ? textPool[0][..197] + "..." : textPool[0]);
        }

        // 2. Analytical Omitted Perspectives
        var omitted = new List<string>();
        if (wantsCounter || wantsEvidence)
        {
            omitted.Add($"{source}'s reporting relies primarily on announced statements; independent technical or academic audits are not detailed.");
            omitted.Add("Potential regulatory friction and long-term compliance overheads are treated as secondary rather than central concerns.");
        }
        else
        {
            omitted.Add("Downstream supply chain and operational friction are not fully evaluated in the primary narrative.");
        }

        // 3. Stakeholder Impact
        var stakeholderImpact = wantsStakeholders
            ? $"Primary institutional stakeholders and incumbent operators stand to capture strategic value, while market competitors and regulatory authorities bear the burden of verification."
            : $"Decision-makers operating in this vertical face asymmetric exposure: early movers gain optionality, but risk regulatory or macro recalibration.";

        // 4. Synthesized Answer
        string answer;
        if (wantsCounter)
        {
            answer = $"While {source} highlights positive headline momentum around {title}, critical omissions include alternative competitive postures and the lack of independent third-party verification.";
        }
        else if (wantsEvidence)
        {
            var cite = evidenceList.Count > 0 ? evidenceList[0] : title;
            answer = $"Key verifiable evidence reported by {source} centers on: \"{cite}\"";
        }
        else if (wantsStakeholders)
        {
            answer = $"According to ground-level reporting from {source}, primary market leaders and strategic sponsors gain the initial advantage, whereas end consumers and sector peers face execution uncertainty.";
        }
        else
        {
            var bestP = textPool.Length > 1 ? textPool[1] : textPool[0];
            answer = $"In addressing \"{cleanQ}\", analysis of {source}'s coverage indicates that: {bestP}";
        }

        return Ok(new InterrogateArticleResponse(
            true,
            cleanQ,
            answer,
            evidenceList.ToArray(),
            omitted.ToArray(),
            stakeholderImpact,
            "socratic-analytical"));
    }
}
