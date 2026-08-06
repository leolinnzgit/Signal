using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class DirectMessage
{
    public long Id { get; set; }

    [Required]
    public string SenderUserId { get; set; } = "";

    [Required]
    public string RecipientUserId { get; set; } = "";

    [Required]
    public string Body { get; set; } = "";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime? ReadAtUtc { get; set; }
}
