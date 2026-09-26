using Homebrewery.Api.Brews;

namespace Homebrewery.Api.Admin;

/// <summary>Site totals (<c>GET /api/admin/stats</c>).</summary>
/// <param name="Brews">All brews.</param>
/// <param name="PublishedBrews">Published brews (locked ones included).</param>
/// <param name="Users">Registered accounts.</param>
/// <param name="LockedBrews">Brews with a moderation lock.</param>
/// <param name="PendingReviews">Locked brews whose authors asked for a review.</param>
public sealed record AdminStats(int Brews, int PublishedBrews, int Users, int LockedBrews, int PendingReviews);

/// <summary>An account found by <c>GET /api/admin/users?q=</c>.</summary>
/// <param name="Roles">Role names, e.g. <c>["Admin"]</c>.</param>
/// <param name="BrewCount">Brews the user is an author of, in any role.</param>
/// <param name="LockoutEnd">Set while Identity's lockout (failed sign-ins) blocks the account.</param>
public sealed record AdminUserInfo(
    Guid Id,
    string Handle,
    string? Email,
    bool EmailConfirmed,
    IReadOnlyList<string> Roles,
    int BrewCount,
    DateTimeOffset? LockoutEnd);

/// <summary>A moderation lock as stored (both messages).</summary>
/// <param name="Code">Reason code (100-999), shown to authors and readers.</param>
/// <param name="EditMessage">Shown to the authors in the editor.</param>
/// <param name="ShareMessage">Shown instead of the brew on its share page.</param>
/// <param name="Applied">When the lock was set.</param>
/// <param name="ReviewRequested">When an author asked for a review, or null.</param>
public sealed record AdminLockInfo(
    int Code,
    string EditMessage,
    string ShareMessage,
    DateTimeOffset Applied,
    DateTimeOffset? ReviewRequested);

/// <summary>A brew for the admin pages (<c>GET /api/admin/brews/{id}</c>, lock changes). Never contains the document.</summary>
/// <param name="Id">The internal brew id.</param>
/// <param name="Authors">All authors in display order, owner first (invited users included).</param>
/// <param name="Lock">The moderation lock, or null.</param>
public sealed record AdminBrewInfo(
    Guid Id,
    string ShareId,
    string EditId,
    string Title,
    string Description,
    IReadOnlyList<string> Tags,
    string Lang,
    string Theme,
    bool Published,
    string? ThumbnailUrl,
    int PageCount,
    int Views,
    int Version,
    int DocSchemaVersion,
    IReadOnlyList<BrewAuthorInfo> Authors,
    AdminLockInfo? Lock,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? LastViewedAt);

/// <summary>A locked brew in <c>GET /api/admin/locks</c> and the review queue.</summary>
/// <param name="Authors">Handles of the owner and authors in display order.</param>
public sealed record LockedBrewInfo(
    string ShareId,
    string EditId,
    string Title,
    IReadOnlyList<string> Authors,
    AdminLockInfo Lock);

/// <summary>Body of <c>PUT /api/admin/brews/{shareId}/lock</c>. Replaces any existing lock (and clears its review request).</summary>
/// <param name="Code">Reason code, 100-999 (upstream's lock tool defaults to 455).</param>
/// <param name="EditMessage">Required; shown to the authors in the editor. At most 1000 characters.</param>
/// <param name="ShareMessage">Required; shown instead of the brew on its share page. At most 1000 characters.</param>
public sealed record LockRequest(int? Code, string? EditMessage, string? ShareMessage);
