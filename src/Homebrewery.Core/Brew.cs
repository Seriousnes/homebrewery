using NanoidDotNet;
using NpgsqlTypes;

namespace Homebrewery.Core;

/// <summary>
/// A brew (document). Mapped by <c>Homebrewery.Data.Configurations.BrewConfiguration</c> to the
/// <c>brews</c> table (plan §8.2).
/// </summary>
/// <remarks>
/// Timestamps must be UTC (<see cref="DateTimeOffset.UtcNow"/>): Npgsql writes
/// <see cref="DateTimeOffset"/> to <c>timestamptz</c> only with a zero offset.
/// </remarks>
public sealed class Brew
{
    public Guid Id { get; set; } = Guid.CreateVersion7();

    /// <summary>Public read link id (<c>/share/{ShareId}</c>).</summary>
    public string ShareId { get; set; } = Nanoid.Generate(size: 12);

    /// <summary>Edit URL id (<c>/edit/{EditId}</c>). Knowing it is not enough: edits still need authorization.</summary>
    public string EditId { get; set; } = Nanoid.Generate(size: 12);

    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string Lang { get; set; } = "en";

    /// <summary>A static theme key (e.g. <c>5ePHB</c>) or the share id of a user theme.</summary>
    public string Theme { get; set; } = "5ePHB";

    public int DocSchemaVersion { get; set; } = 1;

    /// <summary>The editor document as JSON (<c>jsonb</c>). Opaque to the server except in DocInspector.</summary>
    public string Doc { get; set; } = "";

    /// <summary>User CSS.</summary>
    public string Style { get; set; } = "";

    /// <summary>User snippets as JSON (<c>jsonb</c>): <c>[{ group, name, gen }]</c>.</summary>
    public string? Snippets { get; set; }

    /// <summary>The original HBFM text when the brew was imported.</summary>
    public string? SourceMarkdown { get; set; }

    /// <summary>Plain text extracted from <see cref="Doc"/> on save (capped). Feeds <see cref="SearchVector"/>.</summary>
    public string SearchText { get; set; } = "";

    /// <summary>
    /// Generated, stored <c>tsvector</c> ('simple' config) over title, description and search text.
    /// Read-only: PostgreSQL computes it. Project it away in list queries; it can be large.
    /// </summary>
    public NpgsqlTsVector SearchVector { get; set; } = null!;

    public string[] Tags { get; set; } = [];
    public int PageCount { get; set; } = 1;
    public bool Published { get; set; }
    public string? ThumbnailUrl { get; set; }
    public int Views { get; set; }

    /// <summary>Optimistic concurrency token: saves run <c>UPDATE … WHERE version = @original</c>.</summary>
    public int Version { get; set; } = 1;

    /// <summary>Moderation lock (<c>jsonb</c>); null when the brew is not locked.</summary>
    public BrewLock? Lock { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastViewedAt { get; set; }

    public List<BrewAuthor> Authors { get; set; } = [];
}
