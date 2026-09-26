using System.Globalization;
using System.Linq.Expressions;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Core;
using Homebrewery.Core.Documents;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Admin;

/// <summary>
/// Admin use cases (plan §8.3, P7.4): stats, user and brew lookup, and moderation locks. The endpoints are behind the
/// Admin policy, except <see cref="RequestReviewAsync"/>, which the brew's authors call.
/// </summary>
/// <remarks>
/// Lock changes are single <c>UPDATE</c> statements on the <c>lock</c> jsonb column (camelCase keys, as
/// <c>BrewConfiguration</c> maps them). They change neither <c>version</c> nor <c>updated_at</c>, so an author's editor
/// keeps saving against the same base version.
/// </remarks>
public sealed class AdminService(AppDbContext db, TimeProvider clock)
{
    public const int MinLockCode = 100;
    public const int MaxLockCode = 999;
    public const int MaxLockMessage = 1000;
    public const int MaxUserQuery = 256;
    public const int MaxUserResults = 50;
    public const int MaxLockedBrews = 1000;
    public const string BrewNotFound = "Brew not found";

    // ---- stats and lookups ---------------------------------------------------------------------

    public async Task<AdminStats> GetStatsAsync(CancellationToken ct)
    {
        var brews = await db.Brews.CountAsync(ct);
        var published = await db.Brews.CountAsync(b => b.Published, ct);
        var users = await db.Users.CountAsync(ct);
        var locked = await db.Brews.CountAsync(b => b.Lock != null, ct);
        var reviews = await db.Brews.CountAsync(b => b.Lock != null && b.Lock.ReviewRequested != null, ct);
        return new AdminStats(brews, published, users, locked, reviews);
    }

    /// <summary>
    /// Accounts whose handle or email contains <paramref name="q"/> (case-insensitive), or whose id is
    /// <paramref name="q"/>; exact matches first, then by handle. At most <see cref="MaxUserResults"/>.
    /// </summary>
    public async Task<ServiceOutcome<List<AdminUserInfo>>> FindUsersAsync(string? q, CancellationToken ct)
    {
        var query = StoredText.Clean(q ?? "").Trim();
        if (query.Length == 0 || query.Length > MaxUserQuery)
        {
            return new ServiceOutcome<List<AdminUserInfo>>.Invalid(new Dictionary<string, string[]>
            {
                ["q"] = [$"must be 1-{MaxUserQuery} characters: part of a handle or email, or a user id"],
            });
        }

        var handle = query.ToLowerInvariant();
        var email = query.ToUpperInvariant();
        var id = Guid.TryParse(query, out var parsed) ? parsed : Guid.Empty;

        var rows = await db.Users.AsNoTracking()
            .Where(u => u.Id == id || u.Handle.Contains(handle) || (u.NormalizedEmail != null && u.NormalizedEmail.Contains(email)))
            .OrderByDescending(u => u.Id == id || u.Handle == handle || u.NormalizedEmail == email)
            .ThenBy(u => u.Handle)
            .Take(MaxUserResults)
            .Select(u => new
            {
                u.Id,
                u.Handle,
                u.Email,
                u.EmailConfirmed,
                u.LockoutEnd,
                Roles = db.UserRoles.Where(ur => ur.UserId == u.Id)
                    .Join(db.Roles, ur => ur.RoleId, r => r.Id, (_, r) => r.Name)
                    .ToList(),
                BrewCount = db.BrewAuthors.Count(a => a.UserId == u.Id),
            })
            .ToListAsync(ct);

        return new ServiceOutcome<List<AdminUserInfo>>.Ok([
            .. rows.Select(r => new AdminUserInfo(r.Id, r.Handle, r.Email, r.EmailConfirmed,
                [.. r.Roles.OfType<string>().Order(StringComparer.Ordinal)], r.BrewCount, r.LockoutEnd)),
        ]);
    }

    /// <summary>A brew by its internal id (a GUID), share id or edit id; a share id wins over an edit id.</summary>
    public async Task<AdminBrewInfo?> FindBrewAsync(string id, CancellationToken ct)
    {
        var brews = db.Brews.AsNoTracking();
        brews = Guid.TryParse(id, out var guid)
            ? brews.Where(b => b.Id == guid)
            : brews.Where(b => b.ShareId == id || b.EditId == id).OrderBy(b => b.ShareId == id ? 0 : 1);
        return await ProjectAsync(brews, ct);
    }

    // ---- locks ---------------------------------------------------------------------------------

    /// <summary>Every locked brew, most recently locked first (at most <see cref="MaxLockedBrews"/>).</summary>
    public Task<List<LockedBrewInfo>> ListLocksAsync(CancellationToken ct) =>
        ListLockedAsync(db.Brews.Where(b => b.Lock != null).OrderByDescending(b => b.Lock!.Applied), ct);

    /// <summary>Locked brews whose authors asked for a review, oldest request first.</summary>
    public Task<List<LockedBrewInfo>> ReviewQueueAsync(CancellationToken ct) =>
        ListLockedAsync(db.Brews.Where(b => b.Lock != null && b.Lock.ReviewRequested != null)
            .OrderBy(b => b.Lock!.ReviewRequested), ct);

    /// <summary>Sets (or replaces) the lock of the brew with this share id; any review request is cleared.</summary>
    public async Task<ServiceOutcome<AdminBrewInfo>> LockAsync(string shareId, LockRequest request, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);
        if (request.Code is not (>= MinLockCode and <= MaxLockCode))
        {
            BrewRules.Add(errors, "code", $"must be a number from {MinLockCode} to {MaxLockCode}");
        }

        var editMessage = LockMessage(request.EditMessage, "editMessage", errors);
        var shareMessage = LockMessage(request.ShareMessage, "shareMessage", errors);
        if (errors.Count > 0) return new ServiceOutcome<AdminBrewInfo>.Invalid(errors);

        var code = request.Code ?? MinLockCode;
        var applied = Timestamp(UtcNow());
        var updated = await db.Database.ExecuteSqlAsync($"""
            UPDATE brews SET lock = jsonb_build_object(
                'code', {code}, 'editMessage', {editMessage}::text, 'shareMessage', {shareMessage}::text,
                'applied', {applied}::text, 'reviewRequested', NULL)
            WHERE share_id = {shareId}
            """, ct);
        return updated == 0 ? NotFound<AdminBrewInfo>() : await FoundAsync(shareId, ct);
    }

    /// <summary>Removes the lock of the brew with this share id (nothing to do when it is not locked).</summary>
    public async Task<ServiceOutcome<AdminBrewInfo>> UnlockAsync(string shareId, CancellationToken ct)
    {
        var updated = await db.Database.ExecuteSqlAsync($"UPDATE brews SET lock = NULL WHERE share_id = {shareId}", ct);
        return updated == 0 ? NotFound<AdminBrewInfo>() : await FoundAsync(shareId, ct);
    }

    /// <summary>Dismisses the review request of a locked brew without unlocking it.</summary>
    public async Task<ServiceOutcome<AdminBrewInfo>> DismissReviewAsync(string shareId, CancellationToken ct)
    {
        var updated = await db.Database.ExecuteSqlAsync($$"""
            UPDATE brews SET lock = lock || '{"reviewRequested": null}'::jsonb
            WHERE share_id = {{shareId}} AND lock IS NOT NULL
            """, ct);
        if (updated > 0) return await FoundAsync(shareId, ct);
        return await db.Brews.AnyAsync(b => b.ShareId == shareId, ct) ? NotLocked<AdminBrewInfo>() : NotFound<AdminBrewInfo>();
    }

    /// <summary>
    /// <c>POST /api/brews/{editId}/lock/review</c>: one of the brew's authors (any role) asks the moderators to review the
    /// lock. Asking again keeps the first request time.
    /// </summary>
    public async Task<ServiceOutcome<BrewLockInfo>> RequestReviewAsync(string editId, Guid userId, CancellationToken ct)
    {
        var brew = await db.Brews.AsNoTracking()
            .Where(b => b.EditId == editId)
            .Select(b => new { b.Id, b.Lock, IsAuthor = b.Authors.Any(a => a.UserId == userId) })
            .SingleOrDefaultAsync(ct);
        if (brew is null) return NotFound<BrewLockInfo>();
        if (!brew.IsAuthor) return new ServiceOutcome<BrewLockInfo>.Forbidden("You are not an author of this brew.");
        if (brew.Lock is not { } current) return NotLocked<BrewLockInfo>();
        if (current.ReviewRequested is not null) return Ok(current);

        var requested = UtcNow();
        var updated = await db.Database.ExecuteSqlAsync($$"""
            UPDATE brews SET lock = jsonb_set(lock, '{reviewRequested}', to_jsonb({{Timestamp(requested)}}::text))
            WHERE id = {{brew.Id}} AND lock IS NOT NULL AND lock ->> 'reviewRequested' IS NULL
            """, ct);
        if (updated > 0)
        {
            current.ReviewRequested = requested;
            return Ok(current);
        }

        // Unlocked, or another author asked, since the read above.
        var now = await db.Brews.AsNoTracking().Where(b => b.Id == brew.Id).Select(b => new { b.Lock }).SingleOrDefaultAsync(ct);
        return now is null ? NotFound<BrewLockInfo>() : now.Lock is { } l ? Ok(l) : NotLocked<BrewLockInfo>();

        static ServiceOutcome<BrewLockInfo> Ok(BrewLock l) =>
            new ServiceOutcome<BrewLockInfo>.Ok(new BrewLockInfo(l.Code, l.EditMessage, l.Applied, l.ReviewRequested));
    }

    // ---- helpers -------------------------------------------------------------------------------

    private async Task<List<LockedBrewInfo>> ListLockedAsync(IQueryable<Brew> brews, CancellationToken ct)
    {
        var rows = await brews.AsNoTracking()
            .Take(MaxLockedBrews)
            .Select(b => new
            {
                b.ShareId,
                b.EditId,
                b.Title,
                b.Lock,
                Authors = b.Authors.Where(a => a.Role != AuthorRole.Invited).OrderBy(a => a.Position).Select(a => a.User!.Handle).ToList(),
            })
            .ToListAsync(ct);
        return [.. rows.Select(r => new LockedBrewInfo(r.ShareId, r.EditId, r.Title, r.Authors, ToInfo(r.Lock!)))];
    }

    private async Task<ServiceOutcome<AdminBrewInfo>> FoundAsync(string shareId, CancellationToken ct) =>
        await ProjectAsync(db.Brews.AsNoTracking().Where(b => b.ShareId == shareId), ct) is { } brew
            ? new ServiceOutcome<AdminBrewInfo>.Ok(brew)
            : NotFound<AdminBrewInfo>();                                          // deleted in between

    private static async Task<AdminBrewInfo?> ProjectAsync(IQueryable<Brew> brews, CancellationToken ct)
    {
        var row = await brews.Select(Row).FirstOrDefaultAsync(ct);
        return row is null
            ? null
            : new AdminBrewInfo(
                row.Id, row.ShareId, row.EditId, row.Title, row.Description, row.Tags, row.Lang, row.Theme, row.Published,
                row.ThumbnailUrl, row.PageCount, row.Views, row.Version, row.DocSchemaVersion,
                [.. row.Authors.Select(a => new BrewAuthorInfo(a.Handle, a.Role))],
                row.Lock is { } l ? ToInfo(l) : null,
                row.CreatedAt, row.UpdatedAt, row.LastViewedAt);
    }

    private static readonly Expression<Func<Brew, BrewRow>> Row = b => new BrewRow(
        b.Id, b.ShareId, b.EditId, b.Title, b.Description, b.Tags, b.Lang, b.Theme, b.Published, b.ThumbnailUrl,
        b.PageCount, b.Views, b.Version, b.DocSchemaVersion, b.Lock, b.CreatedAt, b.UpdatedAt, b.LastViewedAt,
        b.Authors.OrderBy(a => a.Position).Select(a => new AuthorRow(a.User!.Handle, a.Role)).ToList());

    private static AdminLockInfo ToInfo(BrewLock l) => new(l.Code, l.EditMessage, l.ShareMessage, l.Applied, l.ReviewRequested);

    private static string? LockMessage(string? value, string key, Dictionary<string, string[]> errors)
    {
        var message = StoredText.Clean(value ?? "").Trim();
        if (message.Length == 0) BrewRules.Add(errors, key, "is required");
        else if (message.Length > MaxLockMessage) BrewRules.Add(errors, key, $"must be at most {MaxLockMessage} characters");
        return message;
    }

    private static ServiceOutcome<T> NotFound<T>() => new ServiceOutcome<T>.NotFound(BrewNotFound);

    private static ServiceOutcome<T> NotLocked<T>() =>
        new ServiceOutcome<T>.Conflict("Brew not locked", "The brew has no moderation lock.");

    /// <summary>The JSON text EF Core reads back for a <see cref="DateTimeOffset"/> in the lock column.</summary>
    private static string Timestamp(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);

    /// <summary>Now in UTC, truncated to microseconds (PostgreSQL's precision elsewhere).</summary>
    private DateTimeOffset UtcNow()
    {
        var now = clock.GetUtcNow();
        return now.AddTicks(-(now.Ticks % 10));
    }

    private sealed record AuthorRow(string Handle, AuthorRole Role);

    private sealed record BrewRow(
        Guid Id, string ShareId, string EditId, string Title, string Description, string[] Tags, string Lang, string Theme,
        bool Published, string? ThumbnailUrl, int PageCount, int Views, int Version, int DocSchemaVersion, BrewLock? Lock,
        DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? LastViewedAt, List<AuthorRow> Authors);
}
