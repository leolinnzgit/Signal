using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class FriendRelationship
{
    public long Id { get; set; }

    [Required]
    public string UserOneId { get; set; } = "";

    [Required]
    public string UserTwoId { get; set; } = "";

    [Required]
    public string RequestedByUserId { get; set; } = "";

    [Required]
    public string Status { get; set; } = "Pending";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
