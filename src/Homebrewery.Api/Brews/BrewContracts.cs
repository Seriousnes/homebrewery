using System.Text.Json;
using System.Text.Json.Serialization;
using Homebrewery.Core;

namespace Homebrewery.Api.Brews;

/// <summary>A brew's metadata, as stored.</summary>
/// <param name="Title">At most 100 characters. When saved blank, the first heading of the document is used.</param>
/// <param name="Description">At most 500 characters.</param>
/// <param name="Tags">Free-form tags (e.g. <c>type:adventure</c>, <c>meta:theme</c>); at most 50 of 100 characters.</param>
/// <param name="Lang">Language code, e.g. <c>en</c>, <c>pt-BR</c>, <c>zh-Hant</c>.</param>
/// <param name="Theme">A static theme key (<c>5ePHB</c>, <c>5eDMG</c>, <c>Blank</c>, <c>Journal</c>, <c>UnearthedArcana</c>)
/// or the share id of a user theme.</param>
/// <param name="Published">Listed in the vault and on the author's page.</param>
/// <param name="ThumbnailUrl">Absolute http(s) URL used for link previews, or null.</param>
public sealed record BrewMeta(
    string Title,
    string Description,
    IReadOnlyList<string> Tags,
    string Lang,
    string Theme,
    bool Published,
    string? ThumbnailUrl);

/// <summary>
/// Metadata in a create or save request. Every field is optional: null (or missing) keeps the current value on
/// save and uses the default on create. To clear a thumbnail send an empty string.
/// </summary>
/// <param name="Authors">The full author list as handles, in display order. Only the owner may change it on save
/// (403 otherwise, unless the list is unchanged): new handles become <c>invited</c>, missing ones are removed, the
/// owner always stays first. Unknown handles are a validation error. Null leaves the list unchanged.</param>
public sealed record BrewMetaInput(
    string? Title = null,
    string? Description = null,
    IReadOnlyList<string>? Tags = null,
    string? Lang = null,
    string? Theme = null,
    bool? Published = null,
    string? ThumbnailUrl = null,
    IReadOnlyList<string>? Authors = null);

/// <summary>An author of a brew.</summary>
/// <param name="Handle">Public handle (<c>/user/{handle}</c>).</param>
/// <param name="Role"><c>owner</c>, <c>author</c>, or <c>invited</c> (can edit; becomes <c>author</c> on their first save).</param>
public sealed record BrewAuthorInfo(string Handle, AuthorRole Role);

/// <summary>A moderation lock as the editor shows it.</summary>
/// <param name="Code">Lock reason code.</param>
/// <param name="Message">The lock's edit message for the authors.</param>
public sealed record BrewLockInfo(int Code, string Message, DateTimeOffset Applied, DateTimeOffset? ReviewRequested);

/// <summary>Everything the editor needs (<c>GET /api/brews/edit/{editId}</c>, and the result of create and clone).</summary>
/// <param name="Version">The version to send back as <c>baseVersion</c> on the next save.</param>
/// <param name="DocSchemaVersion">Schema version of <paramref name="Doc"/>; the client migrates older documents on load.</param>
/// <param name="Doc">The document (plan §3.3): <c>{ "type": "doc", "content": [ page, … ] }</c>.</param>
/// <param name="Style">User CSS.</param>
/// <param name="Snippets">User snippets (JSON array), or null.</param>
/// <param name="SourceMarkdown">The original Homebrewery markdown when the brew was imported, or null.</param>
/// <param name="Authors">All authors in display order, owner first.</param>
/// <param name="Role">The caller's role.</param>
/// <param name="Lock">The moderation lock, or null. Saving still works while locked.</param>
public sealed record BrewForEdit(
    string EditId,
    string ShareId,
    int Version,
    int DocSchemaVersion,
    RawJson Doc,
    string Style,
    RawJson? Snippets,
    string? SourceMarkdown,
    BrewMeta Meta,
    IReadOnlyList<BrewAuthorInfo> Authors,
    AuthorRole Role,
    int PageCount,
    int Views,
    BrewLockInfo? Lock,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>The read-only view (<c>GET /api/brews/share/{shareId}</c>).</summary>
/// <param name="EditId">Only for the brew's own authors (so the share page can link to the editor); otherwise null.</param>
/// <param name="Authors">Author handles in display order (invited users excluded).</param>
/// <param name="Views">View count, including this view when it counted.</param>
public sealed record BrewForShare(
    string ShareId,
    string? EditId,
    int DocSchemaVersion,
    RawJson Doc,
    string Style,
    BrewMeta Meta,
    IReadOnlyList<string> Authors,
    int PageCount,
    int Views,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>Body of <c>POST /api/brews</c> (a new brew, or an import). May be sent gzip-compressed.</summary>
/// <param name="Doc">The document; omitted = one empty page.</param>
/// <param name="Style">User CSS.</param>
/// <param name="Snippets">User snippets (JSON array), or null.</param>
/// <param name="Meta">Metadata; <c>meta.authors</c> invites other users (the caller is the owner).</param>
/// <param name="SourceMarkdown">For imports: the original Homebrewery markdown (kept for reference).</param>
/// <param name="DocSchemaVersion">The document's schema version; must be the server's current one when given.</param>
public sealed record CreateBrewRequest(
    JsonElement? Doc = null,
    string? Style = null,
    JsonElement? Snippets = null,
    BrewMetaInput? Meta = null,
    string? SourceMarkdown = null,
    int? DocSchemaVersion = null);

/// <summary>Body of <c>PUT /api/brews/{editId}</c> (plan §8.4). May be sent gzip-compressed.</summary>
/// <param name="BaseVersion">The version the client last loaded or saved. A different server version gives 409.</param>
/// <param name="Doc">The whole document.</param>
/// <param name="Style">User CSS (null = empty).</param>
/// <param name="Snippets">User snippets (JSON array); null clears them.</param>
/// <param name="Meta">Metadata changes; null keeps all metadata.</param>
/// <param name="DocSchemaVersion">The document's schema version; must be the server's current one when given.</param>
public sealed record SaveBrewRequest(
    [property: JsonRequired] int BaseVersion,
    JsonElement Doc,
    string? Style = null,
    JsonElement? Snippets = null,
    BrewMetaInput? Meta = null,
    int? DocSchemaVersion = null);

/// <summary>A successful save.</summary>
/// <param name="Version">The new version; send it as the next <c>baseVersion</c>.</param>
/// <param name="Title">The stored title (the first heading when the title was blank).</param>
/// <param name="Authors">The author list after the save.</param>
public sealed record SaveBrewResponse(
    int Version,
    DateTimeOffset UpdatedAt,
    string Title,
    int PageCount,
    IReadOnlyList<BrewAuthorInfo> Authors);

/// <summary>409 body: the brew changed since <c>baseVersion</c> (another tab, device or author saved).</summary>
/// <param name="ServerVersion">The version now stored.</param>
public sealed record SaveConflict(int ServerVersion);

/// <summary>Result of <c>DELETE /api/brews/{editId}</c>.</summary>
/// <param name="BrewDeleted">True when the caller was the last author and the brew is gone; false when only the
/// caller was removed from the author list.</param>
public sealed record DeleteBrewResponse(bool BrewDeleted);
