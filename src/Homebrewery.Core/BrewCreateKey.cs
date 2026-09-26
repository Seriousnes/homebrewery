namespace Homebrewery.Core;

/// <summary>
/// An <c>Idempotency-Key</c> a user sent with <c>POST /api/brews</c> (<c>brew_create_keys</c>, SAVE-8). A retry
/// with the same key and the same request gets the brew that the first request created instead of a second brew.
/// Keys are scoped per user and expire after 24 hours; the row goes when its brew or its user is deleted.
/// </summary>
public sealed class BrewCreateKey
{
    /// <summary>At most this many characters (visible ASCII).</summary>
    public const int MaxKeyLength = 128;

    /// <summary>How long a key is remembered.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    public Guid UserId { get; set; }

    /// <summary>The client's key (e.g. a UUID), unique per user.</summary>
    public string Key { get; set; } = "";

    /// <summary>The brew the first request created.</summary>
    public Guid BrewId { get; set; }

    /// <summary>SHA-256 of the first request's canonical JSON: a replay with a different body is refused.</summary>
    public byte[] RequestHash { get; set; } = [];

    public DateTimeOffset CreatedAt { get; set; }
}
