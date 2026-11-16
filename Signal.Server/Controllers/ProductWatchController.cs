using System.Security.Claims;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/product-watch")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class ProductWatchController(
    SignalDbContext database,
    MicrosoftFoundryService foundry,
    ProductWatchService productWatch,
    ILogger<ProductWatchController>? logger = null) : ControllerBase
{
    public sealed record ProductWatchUpsertRequest(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("productName")] string? ProductName,
        [property: JsonPropertyName("modelOrSku")] string? ModelOrSku,
        [property: JsonPropertyName("frequency")] string? Frequency,
        [property: JsonPropertyName("currency")] string? Currency,
        [property: JsonPropertyName("targetPrice")] decimal? TargetPrice,
        [property: JsonPropertyName("customPrompt")] string? CustomPrompt = null,
        [property: JsonPropertyName("enabled")] bool? Enabled = null,
        [property: JsonPropertyName("notifyOnPriceDrop")] bool? NotifyOnPriceDrop = null,
        [property: JsonPropertyName("checkNow")] bool? CheckNow = false);

    public sealed record ProductWatchCheckNowRequest(
        [property: JsonPropertyName("oneOffPrompt")] string? OneOffPrompt = null);

    public sealed record ProductWatchStateResponse(
        [property: JsonPropertyName("authenticated")] bool Authenticated,
        [property: JsonPropertyName("aiAvailable")] bool AiAvailable,
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("frequencies")] IReadOnlyList<ProductWatchFrequencyOption> Frequencies,
        [property: JsonPropertyName("currencies")] string[] Currencies,
        [property: JsonPropertyName("items")] ProductWatchItemDto[] Items);

    private string? CurrentUserId => User?.FindFirstValue(ClaimTypes.NameIdentifier);

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        var currencies = ProductWatchService.SupportedCurrencies.ToArray();
        if (string.IsNullOrEmpty(userId))
        {
            return Ok(new ProductWatchStateResponse(
                Authenticated: false,
                AiAvailable: foundry.Enabled,
                Model: ProductWatchService.DefaultModel,
                Frequencies: ProductWatchService.SupportedFrequencies,
                Currencies: currencies,
                Items: []));
        }

        var rows = await database.ProductWatches
            .AsNoTracking()
            .Where(w => w.UserId == userId)
            .OrderByDescending(w => w.CreatedAtUtc)
            .ToArrayAsync(cancellationToken);

        return Ok(new ProductWatchStateResponse(
            Authenticated: true,
            AiAvailable: foundry.Enabled,
            Model: ProductWatchService.DefaultModel,
            Frequencies: ProductWatchService.SupportedFrequencies,
            Currencies: currencies,
            Items: rows.Select(ProductWatchService.ToDto).ToArray()));
    }

    [HttpPost]
    [Authorize]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> Upsert(
        [FromBody] ProductWatchUpsertRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();
        if (request is null)
            return BadRequest(new { error = "Provide product model/SKU details to watch." });

        var modelOrSku = ProductWatchService.NormalizeText(request.ModelOrSku, 120);
        var productName = ProductWatchService.NormalizeText(request.ProductName, 200);
        if (modelOrSku.Length == 0 && productName.Length > 0)
        {
            modelOrSku = productName.Length <= 120 ? productName : productName[..120];
        }
        if (productName.Length == 0)
        {
            productName = modelOrSku;
        }

        if (modelOrSku.Length < 2)
        {
            return BadRequest(new { error = "Enter a product model or SKU (at least 2 characters)." });
        }

        if (request.TargetPrice.HasValue && (request.TargetPrice.Value <= 0 || request.TargetPrice.Value > 1_000_000m))
        {
            return BadRequest(new { error = "Target price must be between 0.01 and 1,000,000." });
        }

        var frequency = ProductWatchService.NormalizeFrequency(request.Frequency);
        var currency = ProductWatchService.NormalizeCurrency(request.Currency);
        var now = DateTime.UtcNow;

        var sanitizedId = SanitizeId(request.Id);
        var existing = sanitizedId.Length > 0
            ? await database.ProductWatches.SingleOrDefaultAsync(w => w.Id == sanitizedId && w.UserId == userId, cancellationToken)
            : null;

        if (existing is null)
        {
            var count = await database.ProductWatches.CountAsync(w => w.UserId == userId, cancellationToken);
            if (count >= ProductWatchService.MaxWatchedProductsPerUser)
            {
                return BadRequest(new { error = $"Maximum of {ProductWatchService.MaxWatchedProductsPerUser} watched products allowed per account." });
            }

            existing = new ProductWatchItem
            {
                Id = sanitizedId.Length > 0 ? sanitizedId : $"pw-{Guid.NewGuid():N}",
                UserId = userId,
                ModelUsed = ProductWatchService.DefaultModel,
                CreatedAtUtc = now,
            };
            database.ProductWatches.Add(existing);
        }

        var enabled = request.Enabled ?? true;
        var frequencyChanged = !string.Equals(existing.Frequency, frequency, StringComparison.OrdinalIgnoreCase);

        existing.ProductName = productName;
        existing.ModelOrSku = modelOrSku;
        existing.Frequency = frequency;
        existing.Currency = currency;
        existing.TargetPrice = request.TargetPrice.HasValue ? Math.Round(request.TargetPrice.Value, 2) : null;
        if (request.CustomPrompt is not null)
        {
            existing.CustomPrompt = ProductWatchService.NormalizeText(request.CustomPrompt, 800);
            if (existing.CustomPrompt.Length == 0)
            {
                existing.CustomPromptAnswer = "";
            }
        }
        existing.Enabled = enabled;
        existing.NotifyOnPriceDrop = request.NotifyOnPriceDrop ?? true;
        existing.UpdatedAtUtc = now;

        if (!enabled || frequency == "manual")
        {
            existing.NextCheckAtUtc = null;
        }
        else if (existing.LastCheckedAtUtc.HasValue)
        {
            if (frequencyChanged || !existing.NextCheckAtUtc.HasValue)
            {
                var nextFromLast = ProductWatchService.ComputeNextCheckUtc(frequency, existing.LastCheckedAtUtc.Value);
                existing.NextCheckAtUtc = nextFromLast.HasValue && nextFromLast.Value > now
                    ? nextFromLast
                    : ProductWatchService.ComputeNextCheckUtc(frequency, now);
            }
        }
        else
        {
            existing.NextCheckAtUtc = ProductWatchService.ComputeNextCheckUtc(frequency, now);
        }

        await database.SaveChangesAsync(cancellationToken);
        logger?.LogInformation("Saved Product Watch {WatchId} ({ModelOrSku}, {Frequency}) for user {UserId}.", existing.Id, existing.ModelOrSku, existing.Frequency, userId);

        if (request.CheckNow == true && foundry.Enabled)
        {
            try
            {
                var checkedDto = await productWatch.CheckWatchItemAsync(userId, existing.Id, isScheduledBackgroundCheck: false, cancellationToken);
                return Ok(checkedDto);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                logger?.LogWarning(ex, "Immediate price check after upsert failed for {WatchId}.", existing.Id);
            }
        }

        return Ok(ProductWatchService.ToDto(existing));
    }

    [HttpPost("{id}/check")]
    [Authorize]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> CheckNow(
        string id,
        [FromBody] ProductWatchCheckNowRequest? request = null,
        CancellationToken cancellationToken = default)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var sanitizedId = SanitizeId(id);
        if (sanitizedId.Length == 0)
            return BadRequest(new { error = "Invalid product watch ID." });

        try
        {
            var updated = await productWatch.CheckWatchItemAsync(
                userId,
                sanitizedId,
                isScheduledBackgroundCheck: false,
                cancellationToken,
                request?.OneOffPrompt);
            return Ok(updated);
        }
        catch (KeyNotFoundException)
        {
            return NotFound(new { error = "Watched product was not found." });
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (FoundryServiceException ex)
        {
            return StatusCode(ex.StatusCode, new { error = ex.Message });
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Manual Product Watch check failed for {WatchId}.", sanitizedId);
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Could not check the best price right now. Please try again." });
        }
    }

    [HttpPost("{id}/ask")]
    [Authorize]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> AskWatchedProduct(
        string id,
        [FromBody] ProductWatchAskRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var sanitizedId = SanitizeId(id);
        if (sanitizedId.Length == 0)
            return BadRequest(new { error = "Invalid product watch ID." });
        if (request is null || string.IsNullOrWhiteSpace(request.Question))
            return BadRequest(new { error = "Enter a question or prompt for this product." });

        try
        {
            var result = await productWatch.AskWatchItemQuestionAsync(
                userId,
                sanitizedId,
                request.Question,
                cancellationToken);
            return Ok(result);
        }
        catch (KeyNotFoundException)
        {
            return NotFound(new { error = "Watched product was not found." });
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (FoundryServiceException ex)
        {
            return StatusCode(ex.StatusCode, new { error = ex.Message });
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Product Watch Q&A failed for {WatchId}.", sanitizedId);
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Could not answer your product question right now. Please try again." });
        }
    }

    [HttpPost("ask")]
    [Authorize]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> AskCurrentProduct(
        [FromBody] ProductWatchAskRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();
        if (request is null)
            return BadRequest(new { error = "Provide a product model/SKU and question." });

        try
        {
            var result = await productWatch.AskInstantProductQuestionAsync(
                userId,
                request,
                cancellationToken);
            return Ok(result);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (FoundryServiceException ex)
        {
            return StatusCode(ex.StatusCode, new { error = ex.Message });
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Instant Product Watch Q&A failed.");
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Could not answer your product question right now. Please try again." });
        }
    }

    [HttpPost("check-instant")]
    [Authorize]
    [RequestSizeLimit(16_384)]
    public async Task<IActionResult> CheckInstant(
        [FromBody] ProductWatchInstantCheckRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();
        if (request is null)
            return BadRequest(new { error = "Enter a product model or SKU to check." });

        try
        {
            var result = await productWatch.CheckPriceWithAiAsync(
                userId,
                request.ModelOrSku ?? "",
                request.ProductName,
                request.Currency,
                request.TargetPrice,
                cancellationToken,
                request.CustomPrompt,
                request.OneOffPrompt);
            return Ok(result);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (FoundryServiceException ex)
        {
            return StatusCode(ex.StatusCode, new { error = ex.Message });
        }
        catch (Exception ex)
        {
            logger?.LogWarning(ex, "Instant Product Watch check failed.");
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "Could not check the best price right now. Please try again." });
        }
    }

    [HttpDelete("{id}")]
    [Authorize]
    public async Task<IActionResult> Delete(string id, CancellationToken cancellationToken)
    {
        var userId = CurrentUserId;
        if (string.IsNullOrEmpty(userId)) return Unauthorized();

        var sanitizedId = SanitizeId(id);
        if (sanitizedId.Length == 0)
            return BadRequest(new { error = "Invalid product watch ID." });

        var existing = await database.ProductWatches
            .SingleOrDefaultAsync(w => w.Id == sanitizedId && w.UserId == userId, cancellationToken);
        if (existing is null) return NotFound();

        database.ProductWatches.Remove(existing);
        await database.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    private static string SanitizeId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var clean = new string(value.Trim().Where(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.').ToArray());
        return clean.Length <= 64 ? clean : clean[..64];
    }
}
