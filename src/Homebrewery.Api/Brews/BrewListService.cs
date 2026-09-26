using System.Linq.Expressions;
using Homebrewery.Core;
using Homebrewery.Core.Documents;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Brews;

/// <summary>
/// Brew lists (plan §8.3): the vault search (<c>GET /api/vault</c>) and a user's brews
/// (<c>GET /api/users/{handle}/brews</c>). Both are projections: documents and search columns are never loaded.
/// Only published, unlocked brews are public; a user's own list shows everything they are an author of.
/// </summary>
public sealed class BrewListService(AppDbContext db)
{
    /// <summary>Text search configuration: brews are multilingual, so no stemming or stop words (plan §8.2).</summary>
    public const string SearchConfig = "simple";

    public const int DefaultPageSize = 20;
    public const int MaxPageSize = 60;
    public const int MaxPage = 10_000;
    public const int MaxQueryLength = 256;
    public const int MaxUserBrews = 1000;

    public const string Relevance = "relevance";
    public const string Updated = "updated";
    public const string Created = "created";
    public const string Views = "views";
    public const string Title = "title";
    public const string Asc = "asc";
    public const string Desc = "desc";

    /// <summary>The <c>sort</c> values the vault accepts.</summary>
    public static IReadOnlyList<string> Sorts { get; } = [Relevance, Updated, Created, Views, Title];

    /// <summary>The <c>dir</c> values the vault accepts.</summary>
    public static IReadOnlyList<string> Directions { get; } = [Asc, Desc];

    /// <summary><c>GET /api/vault</c>: published, unlocked brews, searched, sorted and paged (see <see cref="VaultQuery"/>).</summary>
    public async Task<BrewOutcome<VaultPage>> VaultAsync(VaultQuery query, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);

        var q = StoredText.Clean(query.Q ?? "").Trim();
        if (q.Length > MaxQueryLength) BrewRules.Add(errors, "q", $"must be at most {MaxQueryLength} characters");

        var sort = Keyword(query.Sort);
        if (sort.Length == 0) sort = q.Length > 0 ? Relevance : Updated;
        else if (!Sorts.Contains(sort)) BrewRules.Add(errors, "sort", $"must be one of: {string.Join(", ", Sorts)}");
        if (sort == Relevance && q.Length == 0) sort = Updated;           // nothing to rank by

        var dir = Keyword(query.Dir);
        if (dir.Length == 0) dir = sort == Title ? Asc : Desc;
        else if (!Directions.Contains(dir)) BrewRules.Add(errors, "dir", $"must be one of: {string.Join(", ", Directions)}");

        if (errors.Count > 0) return new BrewOutcome<VaultPage>.Invalid(errors);

        var page = Math.Clamp(query.Page ?? 1, 1, MaxPage);
        var pageSize = Math.Clamp(query.PageSize ?? DefaultPageSize, 1, MaxPageSize);

        var brews = db.Brews.AsNoTracking().Where(b => b.Published && b.Lock == null);
        if (q.Length > 0)
        {
            brews = brews.Where(b => b.SearchVector.Matches(EF.Functions.WebSearchToTsQuery(SearchConfig, q)));
        }

        var author = Handles.Normalize(StoredText.Clean(query.Author ?? ""));
        if (author.Length > 0)
        {
            brews = brews.Where(b => b.Authors.Any(a => a.User!.Handle == author && a.Role != AuthorRole.Invited));
        }

        var total = await brews.CountAsync(ct);
        var skip = (page - 1) * pageSize;
        var rows = total > skip
            ? await Order(brews, sort, dir == Desc, q).Skip(skip).Take(pageSize).Select(Summary(null)).ToListAsync(ct)
            : [];

        return new BrewOutcome<VaultPage>.Ok(
            new VaultPage([.. rows.Select(r => ToSummary(r, own: false))], total, page, pageSize, sort, dir));
    }

    /// <summary>
    /// <c>GET /api/users/{handle}/brews</c>: brews the user owns or co-authors, most recently updated first. Others see
    /// the published, unlocked ones; the user (<paramref name="callerId"/>) sees all of them, including brews they are
    /// invited to (after their own brews), with edit ids and roles.
    /// <paramref name="asOwner"/> gives that full list to anyone (<c>GET /api/admin/users/{handle}/brews</c>).
    /// </summary>
    public async Task<BrewOutcome<UserBrewList>> UserBrewsAsync(string handle, Guid? callerId, CancellationToken ct, bool asOwner = false)
    {
        var normalized = Handles.Normalize(handle);
        if (!Handles.IsValid(normalized)) return new BrewOutcome<UserBrewList>.NotFound();

        var user = await db.Users.AsNoTracking()
            .Where(u => u.Handle == normalized)
            .Select(u => new { u.Id, u.Handle })
            .SingleOrDefaultAsync(ct);
        if (user is null) return new BrewOutcome<UserBrewList>.NotFound();

        var userId = user.Id;
        var own = asOwner || callerId == userId;
        var brews = own
            ? db.Brews.AsNoTracking().Where(b => b.Authors.Any(a => a.UserId == userId))
            : db.Brews.AsNoTracking().Where(b => b.Published && b.Lock == null
                                                 && b.Authors.Any(a => a.UserId == userId && a.Role != AuthorRole.Invited));

        var total = await brews.CountAsync(ct);
        // Invitations last: anyone can invite anyone, so otherwise MaxUserBrews invitations could push the user's own
        // brews out of the list.
        var rows = await brews
            .OrderBy(b => b.Authors.Any(a => a.UserId == userId && a.Role == AuthorRole.Invited))
            .ThenByDescending(b => b.UpdatedAt).ThenBy(b => b.Id)
            .Take(MaxUserBrews)
            .Select(Summary(own ? userId : null))
            .ToListAsync(ct);

        return new BrewOutcome<UserBrewList>.Ok(
            new UserBrewList(user.Handle, own, [.. rows.Select(r => ToSummary(r, own))], total));
    }

    private static string Keyword(string? value) => (value ?? "").Trim().ToLowerInvariant();

    private static IOrderedQueryable<Brew> Order(IQueryable<Brew> brews, string sort, bool descending, string q)
    {
        var ordered = sort switch
        {
            Relevance => By(brews, b => b.SearchVector.Rank(EF.Functions.WebSearchToTsQuery(SearchConfig, q)), descending),
            Created => By(brews, b => b.CreatedAt, descending),
            Views => By(brews, b => b.Views, descending),
            Title => By(brews, b => b.Title, descending),
            _ => By(brews, b => b.UpdatedAt, descending),
        };
        return ordered.ThenByDescending(b => b.UpdatedAt).ThenBy(b => b.Id);     // stable pages
    }

    private static IOrderedQueryable<Brew> By<TKey>(IQueryable<Brew> brews, Expression<Func<Brew, TKey>> key, bool descending) =>
        descending ? brews.OrderByDescending(key) : brews.OrderBy(key);

    /// <summary>The list columns; <paramref name="viewerId"/> (own lists only) adds the viewer's role.</summary>
    private static Expression<Func<Brew, SummaryRow>> Summary(Guid? viewerId) => b => new SummaryRow(
        b.ShareId,
        b.EditId,
        b.Title,
        b.Description,
        b.Tags,
        b.Authors.Where(a => a.Role != AuthorRole.Invited).OrderBy(a => a.Position).Select(a => a.User!.Handle).ToList(),
        b.Theme,
        b.Lang,
        b.PageCount,
        b.Views,
        b.Published,
        b.ThumbnailUrl,
        b.CreatedAt,
        b.UpdatedAt,
        b.LastViewedAt,
        viewerId == null ? null : b.Authors.Where(a => a.UserId == viewerId).Select(a => (AuthorRole?)a.Role).FirstOrDefault(),
        b.Lock != null);

    private static BrewSummary ToSummary(SummaryRow r, bool own) => new(
        r.ShareId, own ? r.EditId : null, r.Title, r.Description, r.Tags, r.Authors, r.Theme, r.Lang, r.PageCount, r.Views,
        r.Published, r.ThumbnailUrl, r.CreatedAt, r.UpdatedAt, r.LastViewedAt, own ? r.Role : null, r.Locked);

    private sealed record SummaryRow(
        string ShareId, string EditId, string Title, string Description, string[] Tags, List<string> Authors, string Theme,
        string Lang, int PageCount, int Views, bool Published, string? ThumbnailUrl, DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt, DateTimeOffset? LastViewedAt, AuthorRole? Role, bool Locked);
}
