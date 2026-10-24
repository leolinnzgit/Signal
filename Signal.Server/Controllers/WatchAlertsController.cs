using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController, Authorize, Route("api/watch/alerts"), EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class WatchAlertsController(SignalDbContext database) : ControllerBase
{
    private string UserId => User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var row = await database.Set<WatchAlertPreferences>().AsNoTracking().SingleOrDefaultAsync(p => p.UserId == UserId, ct);
        return Ok(new Rules(WatchAlertFilter.Terms(row?.TopicsJson ?? "[]"), WatchAlertFilter.Terms(row?.KeywordsJson ?? "[]")));
    }

    [HttpPost]
    public async Task<IActionResult> Save(Rules rules, CancellationToken ct)
    {
        if (rules.Topics is null || rules.Keywords is null || rules.Topics.Length > 20 || rules.Keywords.Length > 20
            || rules.Topics.Concat(rules.Keywords).Any(t => string.IsNullOrWhiteSpace(t) || t.Length > 100))
            return BadRequest(new { error = "Choose up to 20 topics and 20 keywords, each at most 100 characters." });
        var row = await database.Set<WatchAlertPreferences>().SingleOrDefaultAsync(p => p.UserId == UserId, ct);
        if (row is null) { row = new() { UserId = UserId }; database.Add(row); }
        row.TopicsJson = JsonSerializer.Serialize(rules.Topics.Select(t => t.Trim()).Distinct(StringComparer.OrdinalIgnoreCase));
        row.KeywordsJson = JsonSerializer.Serialize(rules.Keywords.Select(t => t.Trim()).Distinct(StringComparer.OrdinalIgnoreCase));
        await database.SaveChangesAsync(ct);
        return NoContent();
    }

    public sealed record Rules(string[] Topics, string[] Keywords);
}
