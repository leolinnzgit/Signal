using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class ProductWatchItem
{
    [Required]
    public string Id { get; set; } = "";

    [Required]
    public string UserId { get; set; } = "";

    public ApplicationUser User { get; set; } = null!;

    [Required]
    public string ProductName { get; set; } = "";

    [Required]
    public string ModelOrSku { get; set; } = "";

    [Required]
    public string Frequency { get; set; } = "daily";

    [Required]
    public string Currency { get; set; } = "NZD";

    public decimal? TargetPrice { get; set; }

    public bool Enabled { get; set; } = true;

    public bool NotifyOnPriceDrop { get; set; } = true;

    public decimal? BestPrice { get; set; }

    public decimal? RegularPrice { get; set; }

    public decimal? LowestPriceEver { get; set; }

    public decimal? PreviousBestPrice { get; set; }

    [Required]
    public string BestRetailer { get; set; } = "";

    [Required]
    public string BestOfferUrl { get; set; } = "";

    [Required]
    public string PriceVerdict { get; set; } = "";

    [Required]
    public string Summary { get; set; } = "";

    [Required]
    public string BuyingTip { get; set; } = "";

    [Required]
    public string CustomPrompt { get; set; } = "";

    [Required]
    public string CustomPromptAnswer { get; set; } = "";

    [Required]
    public string QaHistoryJson { get; set; } = "[]";

    [Required]
    public string OffersJson { get; set; } = "[]";

    [Required]
    public string PriceHistoryJson { get; set; } = "[]";

    [Required]
    public string ModelUsed { get; set; } = "gpt-6.1-sol";

    public int CheckCount { get; set; }

    public DateTime? LastCheckedAtUtc { get; set; }

    public DateTime? NextCheckAtUtc { get; set; }

    [Required]
    public string LastError { get; set; } = "";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
