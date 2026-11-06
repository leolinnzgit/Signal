using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/sovereign-risk")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class SovereignRiskController : ControllerBase
{
    public sealed record SovereignEconomy(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("currencyCode")] string CurrencyCode,
        [property: JsonPropertyName("sovereignRiskScore")] int SovereignRiskScore, // 0 - 100
        [property: JsonPropertyName("cdsSpreadBps")] int CdsSpreadBps,
        [property: JsonPropertyName("fx30dDepreciationVelocityPercent")] double Fx30dDepreciationVelocityPercent,
        [property: JsonPropertyName("foreignReservesCoverMonths")] double ForeignReservesCoverMonths,
        [property: JsonPropertyName("capitalControlStatus")] string CapitalControlStatus, // "Open" | "Advisory" | "Severe Restrictions" | "Strict Rationing"
        [property: JsonPropertyName("macroBrief")] string MacroBrief);

    public sealed record SovereignAssessRequest(
        [property: JsonPropertyName("economyId")] string? EconomyId,
        [property: JsonPropertyName("corporateExposureUsd")] double? CorporateExposureUsd);

    public sealed record SovereignAssessResponse(
        [property: JsonPropertyName("economyId")] string EconomyId,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("currencyCode")] string CurrencyCode,
        [property: JsonPropertyName("sovereignRiskScore")] int SovereignRiskScore,
        [property: JsonPropertyName("cdsSpreadBps")] int CdsSpreadBps,
        [property: JsonPropertyName("fx30dDepreciationVelocityPercent")] double Fx30dDepreciationVelocityPercent,
        [property: JsonPropertyName("foreignReservesCoverMonths")] double ForeignReservesCoverMonths,
        [property: JsonPropertyName("capitalControlStatus")] string CapitalControlStatus,
        [property: JsonPropertyName("repatriationHaircutPercent")] double RepatriationHaircutPercent,
        [property: JsonPropertyName("estimatedExposureLossUsd")] string EstimatedExposureLossUsd,
        [property: JsonPropertyName("treasuryActionPlaybooks")] string[] TreasuryActionPlaybooks,
        [property: JsonPropertyName("assessedAt")] DateTimeOffset AssessedAt);

    private static readonly SovereignEconomy[] DefaultEconomies =
    [
        new(
            Id: "argentina",
            Name: "Argentina",
            CurrencyCode: "ARS",
            SovereignRiskScore: 92,
            CdsSpreadBps: 1420,
            Fx30dDepreciationVelocityPercent: -18.4,
            ForeignReservesCoverMonths: 1.8,
            CapitalControlStatus: "Strict Rationing",
            MacroBrief: "Cepo cambiario restrictions and severe central bank net reserve deficits enforce mandatory central bank approval for foreign currency repatriation."
        ),
        new(
            Id: "egypt",
            Name: "Egypt",
            CurrencyCode: "EGP",
            SovereignRiskScore: 78,
            CdsSpreadBps: 980,
            Fx30dDepreciationVelocityPercent: -12.2,
            ForeignReservesCoverMonths: 2.6,
            CapitalControlStatus: "Severe Restrictions",
            MacroBrief: "Suez Canal transit revenue down 55% due to Red Sea diversions, widening current account deficit despite Ras El-Hekma investment inflows."
        ),
        new(
            Id: "pakistan",
            Name: "Pakistan",
            CurrencyCode: "PKR",
            SovereignRiskScore: 82,
            CdsSpreadBps: 890,
            Fx30dDepreciationVelocityPercent: -9.5,
            ForeignReservesCoverMonths: 2.1,
            CapitalControlStatus: "Severe Restrictions",
            MacroBrief: "Heavy external debt amortization schedule ($24B due over 12 months) requiring rolling bilateral deposit rollovers from GCC partners."
        ),
        new(
            Id: "turkey",
            Name: "Turkey",
            CurrencyCode: "TRY",
            SovereignRiskScore: 64,
            CdsSpreadBps: 420,
            Fx30dDepreciationVelocityPercent: -6.8,
            ForeignReservesCoverMonths: 3.4,
            CapitalControlStatus: "Advisory",
            MacroBrief: "CBRT policy rate held at 50% with orthodox disinflation framework showing signs of net reserve rebuilding, but real rates remain volatile."
        ),
        new(
            Id: "nigeria",
            Name: "Nigeria",
            CurrencyCode: "NGN",
            SovereignRiskScore: 71,
            CdsSpreadBps: 680,
            Fx30dDepreciationVelocityPercent: -14.6,
            ForeignReservesCoverMonths: 3.1,
            CapitalControlStatus: "Advisory",
            MacroBrief: "Naira float and fuel subsidy reforms creating transitional inflation shock; central bank working through backlog of foreign airline and corporate FX remittances."
        ),
        new(
            Id: "japan",
            Name: "Japan",
            CurrencyCode: "JPY",
            SovereignRiskScore: 32,
            CdsSpreadBps: 25,
            Fx30dDepreciationVelocityPercent: -4.2,
            ForeignReservesCoverMonths: 16.5,
            CapitalControlStatus: "Open",
            MacroBrief: "Bank of Japan policy rate normalization and global JPY carry trade unwinding creating cross-asset equity volatility."
        ),
        new(
            Id: "uk",
            Name: "United Kingdom",
            CurrencyCode: "GBP",
            SovereignRiskScore: 24,
            CdsSpreadBps: 18,
            Fx30dDepreciationVelocityPercent: -0.8,
            ForeignReservesCoverMonths: 8.4,
            CapitalControlStatus: "Open",
            MacroBrief: "Gilt market steady with tight fiscal rules; sovereign debt-to-GDP hovering near 98% with limited autumn budget headroom."
        ),
        new(
            Id: "us",
            Name: "United States",
            CurrencyCode: "USD",
            SovereignRiskScore: 15,
            CdsSpreadBps: 0,
            Fx30dDepreciationVelocityPercent: 0.0,
            ForeignReservesCoverMonths: 24.0,
            CapitalControlStatus: "Open",
            MacroBrief: "Global reserve currency anchor; federal deficit at 6.4% of GDP with steady international demand for Treasury auctions."
        )
    ];

    [HttpGet("economies")]
    public IActionResult GetEconomies()
    {
        return Ok(DefaultEconomies);
    }

    [HttpPost("assess")]
    [IgnoreAntiforgeryToken]
    public IActionResult Assess([FromBody] SovereignAssessRequest? request)
    {
        var economyId = request?.EconomyId?.Trim().ToLowerInvariant() ?? "argentina";
        var economy = DefaultEconomies.FirstOrDefault(e => e.Id == economyId) ?? DefaultEconomies[0];
        var exposureUsd = request?.CorporateExposureUsd ?? 10_000_000.0;

        // Calculate expected repatriation haircut %
        var haircutPercent = economy.CapitalControlStatus switch
        {
            "Strict Rationing" => 42.0,
            "Severe Restrictions" => 28.0,
            "Advisory" => 14.0,
            _ => 1.5
        };

        var estimatedLoss = (exposureUsd * (haircutPercent / 100.0));
        var estimatedLossStr = $"${Math.Round(estimatedLoss / 1_000_000.0, 2)}M USD";

        string[] playbooks = economy.CapitalControlStatus switch
        {
            "Strict Rationing" => [
                "Execute local currency reinvestment into inflation-linked sovereign paper (CER) or capital equipment.",
                "Structure cross-border dividend distributions via blue-chip swap (Contado con Liquidación) or authorized import prepayments.",
                "Convert onshore cash into hard-asset inventory with domestic liquidation optionality."
            ],
            "Severe Restrictions" => [
                "Incorporate mandatory USD letter of credit (LC) terms on all outbound shipments.",
                "Route enterprise services contracts through offshore regional hubs (e.g. Dubai or Singapore).",
                "Negotiate sovereign debt collateralization on large government off-take contracts."
            ],
            "Advisory" => [
                "Maintain 30-day rolling sweep of onshore cash balances into offshore treasury accounts.",
                "Hedge local FX exposure through non-deliverable forwards (NDFs).",
                "Pre-clear tax clearance certificates required for cross-border royalty remittances."
            ],
            _ => [
                "Standard multi-currency cash pool sweep with zero restriction buffers.",
                "Monitor central bank rate decision calendar for duration matching.",
                "Maintain investment-grade commercial paper allocation."
            ]
        };

        var response = new SovereignAssessResponse(
            EconomyId: economy.Id,
            Name: economy.Name,
            CurrencyCode: economy.CurrencyCode,
            SovereignRiskScore: economy.SovereignRiskScore,
            CdsSpreadBps: economy.CdsSpreadBps,
            Fx30dDepreciationVelocityPercent: economy.Fx30dDepreciationVelocityPercent,
            ForeignReservesCoverMonths: economy.ForeignReservesCoverMonths,
            CapitalControlStatus: economy.CapitalControlStatus,
            RepatriationHaircutPercent: haircutPercent,
            EstimatedExposureLossUsd: estimatedLossStr,
            TreasuryActionPlaybooks: playbooks,
            AssessedAt: DateTimeOffset.UtcNow);

        return Ok(response);
    }
}
