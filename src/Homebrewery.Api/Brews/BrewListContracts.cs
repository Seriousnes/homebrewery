using Homebrewery.Core;
using Microsoft.AspNetCore.Mvc;

namespace Homebrewery.Api.Brews;

/// <summary>A brew in a list (the vault, a user's page). Never contains the document.</summary>
/// <param name="EditId">Only in the caller's own list (<c>GET /api/users/{handle}/brews</c> as that user); otherwise null.</param>
/// <param name="Authors">Handles of the owner and authors in display order (invited users excluded).</param>
/// <param name="Theme">A static theme key or a user theme's share id.</param>
/// <param name="Published">Always true in the vault and in other people's lists.</param>
/// <param name="LastViewedAt">When the share page last counted a view, or null.</param>
/// <param name="Role">The caller's role; only in the caller's own list, otherwise null.</param>
/// <param name="Locked">Whether a moderation lock blocks the share page. Locked brews appear only in their authors'
/// own lists.</param>
public sealed record BrewSummary(
    string ShareId,
    string? EditId,
    string Title,
    string Description,
    IReadOnlyList<string> Tags,
    IReadOnlyList<string> Authors,
    string Theme,
    string Lang,
    int PageCount,
    int Views,
    bool Published,
    string? ThumbnailUrl,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? LastViewedAt,
    AuthorRole? Role,
    bool Locked);

/// <summary>Query of <c>GET /api/vault</c>. Every parameter is optional.</summary>
/// <param name="Q">Search text in web search syntax (<c>websearch_to_tsquery('simple', q)</c>): words must all match
/// (in the title, description or document text), <c>"quoted phrases"</c>, <c>or</c>, and <c>-word</c> to exclude. The
/// <c>simple</c> configuration lower-cases but does not stem or drop stop words, so it works for any language. At most
/// 256 characters.</param>
/// <param name="Page">1-based page number (default 1; values below 1 count as 1, the maximum is 10000).</param>
/// <param name="PageSize">Results per page (default 20, clamped to 1–60).</param>
/// <param name="Sort"><c>relevance</c> (default when <c>q</c> is given; without <c>q</c> it sorts like
/// <c>updated</c>), <c>updated</c> (default without <c>q</c>), <c>created</c>, <c>views</c> or <c>title</c>. Anything
/// else is a 400.</param>
/// <param name="Dir"><c>asc</c> or <c>desc</c>. Default: <c>asc</c> for <c>title</c>, <c>desc</c> otherwise. Anything
/// else is a 400.</param>
/// <param name="Author">Only brews by this handle (owner or author; case-insensitive).</param>
public sealed record VaultQuery(
    [property: FromQuery(Name = "q")] string? Q = null,
    [property: FromQuery(Name = "page")] int? Page = null,
    [property: FromQuery(Name = "pageSize")] int? PageSize = null,
    [property: FromQuery(Name = "sort")] string? Sort = null,
    [property: FromQuery(Name = "dir")] string? Dir = null,
    [property: FromQuery(Name = "author")] string? Author = null);

/// <summary>A page of vault results (<c>GET /api/vault</c>).</summary>
/// <param name="Total">Matching brews over all pages.</param>
/// <param name="Page">The page returned (after clamping).</param>
/// <param name="PageSize">The page size used (after clamping).</param>
/// <param name="Sort">The sort applied (<c>relevance</c> without <c>q</c> reports <c>updated</c>).</param>
/// <param name="Dir">The direction applied.</param>
public sealed record VaultPage(
    IReadOnlyList<BrewSummary> Items,
    int Total,
    int Page,
    int PageSize,
    string Sort,
    string Dir);

/// <summary>A user's brews (<c>GET /api/users/{handle}/brews</c>), most recently updated first.</summary>
/// <param name="Handle">The user's handle.</param>
/// <param name="Own">True when the caller is this user: the list then includes unpublished and locked brews and brews
/// the user is invited to, with edit ids and roles.</param>
/// <param name="Items">At most 1000 brews. In the user's own list, brews they are only invited to come after the others.</param>
/// <param name="Total">All brews the caller may see in this list (may exceed the items returned).</param>
public sealed record UserBrewList(
    string Handle,
    bool Own,
    IReadOnlyList<BrewSummary> Items,
    int Total);
