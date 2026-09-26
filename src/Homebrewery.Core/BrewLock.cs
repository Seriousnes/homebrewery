namespace Homebrewery.Core;

/// <summary>
/// A moderation lock, stored as JSON in <c>brews.lock</c>. Upstream semantics: a lock blocks the share
/// view (showing <see cref="ShareMessage"/>) and the editor shows <see cref="EditMessage"/>.
/// </summary>
public sealed class BrewLock
{
    public int Code { get; set; }
    public string EditMessage { get; set; } = "";
    public string ShareMessage { get; set; } = "";
    public DateTimeOffset Applied { get; set; }
    public DateTimeOffset? ReviewRequested { get; set; }
}
