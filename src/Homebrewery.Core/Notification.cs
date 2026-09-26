namespace Homebrewery.Core;

/// <summary>A site-wide notification shown between <see cref="StartsAt"/> and <see cref="StopsAt"/>.</summary>
public sealed class Notification
{
    public Guid Id { get; set; } = Guid.CreateVersion7();

    /// <summary>Unique key the client remembers when the user dismisses the notification.</summary>
    public string DismissKey { get; set; } = "";

    public string Title { get; set; } = "";

    /// <summary>Plain text or a tiny doc JSON; never HBFM.</summary>
    public string Body { get; set; } = "";

    public DateTimeOffset StartsAt { get; set; }
    public DateTimeOffset StopsAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
