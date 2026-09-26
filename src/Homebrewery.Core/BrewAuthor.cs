namespace Homebrewery.Core;

/// <summary>A user's membership in a brew's author list (<c>brew_authors</c>).</summary>
public sealed class BrewAuthor
{
    public Guid BrewId { get; set; }
    public Guid UserId { get; set; }
    public AuthorRole Role { get; set; }

    /// <summary>Display order in the author list, starting at 0.</summary>
    public short Position { get; set; }

    /// <summary>The author's account. Optional navigation for queries (handles in author lists).</summary>
    public AppUser? User { get; set; }
}

/// <summary>Stored as <c>smallint</c>. Do not renumber: the values are persisted.</summary>
public enum AuthorRole : short
{
    Owner = 0,
    Author = 1,

    /// <summary>Invited but has not saved yet; becomes <see cref="Author"/> on the first save.</summary>
    Invited = 2,
}
