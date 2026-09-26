using Homebrewery.Api.Themes;
using Homebrewery.Core;
using Homebrewery.Core.Documents;
using Homebrewery.Data;
using Homebrewery.Data.Configurations;
using Microsoft.EntityFrameworkCore;
using NanoidDotNet;

namespace Homebrewery.Api.Brews;

/// <summary>
/// Brew use cases behind <c>/api/brews</c> (plan §8.3, §8.4). Access rules are <see cref="AccessPolicy"/>'s.
/// </summary>
/// <remarks>
/// Reads are projections, so the large <c>search_vector</c>/<c>search_text</c> columns are never loaded, and saves
/// never load the stored document. A save is one <c>UPDATE … WHERE id = @id AND version = @baseVersion</c>
/// (<c>ExecuteUpdateAsync</c>) in a transaction with the author changes: when two saves race from the same base version, PostgreSQL makes the
/// second one wait for the first and then match no row, so exactly one wins and the other gets a conflict.
/// </remarks>
public sealed class BrewService(AppDbContext db, DocInspector inspector, ThemeCatalog themes)
{
    private const int MaxInsertAttempts = 3;

    // ---- reads ---------------------------------------------------------------------------------

    /// <summary><c>GET /api/brews/edit/{editId}</c>: the full brew for one of its authors.</summary>
    public async Task<BrewOutcome<BrewForEdit>> GetForEditAsync(string editId, Guid userId, CancellationToken ct)
    {
        var row = await db.Brews.AsNoTracking()
            .Where(b => b.EditId == editId)
            .Select(b => new EditRow(
                b.EditId, b.ShareId, b.Version, b.DocSchemaVersion, b.Doc, b.Style, b.Snippets, b.SourceMarkdown,
                b.Title, b.Description, b.Tags, b.Lang, b.Theme, b.Published, b.ThumbnailUrl, b.PageCount, b.Views,
                b.Lock, b.CreatedAt, b.UpdatedAt,
                b.Authors.OrderBy(a => a.Position).Select(a => new AuthorRow(a.UserId, a.Role, a.Position, a.User!.Handle)).ToList()))
            .SingleOrDefaultAsync(ct);
        if (row is null) return new BrewOutcome<BrewForEdit>.NotFound();

        var role = RoleOf(row.Authors, userId);
        if (!AccessPolicy.CanEdit(role)) return NotAnAuthor<BrewForEdit>();

        return new BrewOutcome<BrewForEdit>.Ok(new BrewForEdit(
            row.EditId, row.ShareId, row.Version, row.DocSchemaVersion, new RawJson(row.Doc), row.Style,
            RawJson.FromNullable(row.Snippets), row.SourceMarkdown,
            new BrewMeta(row.Title, row.Description, row.Tags, row.Lang, row.Theme, row.Published, row.ThumbnailUrl),
            ToInfo(row.Authors), role!.Value, row.PageCount, row.Views,
            row.Lock is { } l ? new BrewLockInfo(l.Code, l.EditMessage, l.Applied, l.ReviewRequested) : null,
            row.CreatedAt, row.UpdatedAt));
    }

    /// <summary>
    /// <c>GET /api/brews/share/{shareId}</c>: the read-only view. A lock blocks it for everyone. Views increase by
    /// one in the database (<c>SET views = views + 1</c>) unless the caller is one of the brew's authors.
    /// </summary>
    public async Task<BrewOutcome<BrewForShare>> GetForShareAsync(string shareId, Guid? userId, CancellationToken ct)
    {
        var row = await db.Brews.AsNoTracking()
            .Where(b => b.ShareId == shareId)
            .Select(b => new ShareRow(
                b.Id, b.ShareId, b.EditId, b.DocSchemaVersion, b.Doc, b.Style,
                b.Title, b.Description, b.Tags, b.Lang, b.Theme, b.Published, b.ThumbnailUrl, b.PageCount, b.Views,
                b.Lock, b.CreatedAt, b.UpdatedAt,
                b.Authors.OrderBy(a => a.Position).Select(a => new AuthorRow(a.UserId, a.Role, a.Position, a.User!.Handle)).ToList()))
            .SingleOrDefaultAsync(ct);
        if (row is null) return new BrewOutcome<BrewForShare>.NotFound();
        if (row.Lock is { } brewLock) return new BrewOutcome<BrewForShare>.Locked(brewLock.Code, brewLock.ShareMessage);

        var role = RoleOf(row.Authors, userId);
        var views = row.Views;
        if (AccessPolicy.CountsAsView(role))
        {
            var now = UtcNow();
            await db.Brews.Where(b => b.Id == row.Id).ExecuteUpdateAsync(s => s
                .SetProperty(b => b.Views, b => b.Views + 1)
                .SetProperty(b => b.LastViewedAt, now), ct);
            views++;
        }

        return new BrewOutcome<BrewForShare>.Ok(new BrewForShare(
            row.ShareId, role is null ? null : row.EditId, row.DocSchemaVersion, new RawJson(row.Doc), row.Style,
            new BrewMeta(row.Title, row.Description, row.Tags, row.Lang, row.Theme, row.Published, row.ThumbnailUrl),
            [.. row.Authors.Where(a => AccessPolicy.IsActiveAuthor(a.Role)).Select(a => a.Handle)],
            row.PageCount, views, row.CreatedAt, row.UpdatedAt));
    }

    // ---- writes --------------------------------------------------------------------------------

    /// <summary><c>POST /api/brews</c>: a new brew owned by <paramref name="userId"/>.</summary>
    public Task<BrewOutcome<BrewForEdit>> CreateAsync(CreateBrewRequest request, Guid userId, CancellationToken ct) =>
        CreateAsync(request, userId, idempotencyKey: null, ct);

    /// <summary>
    /// <c>POST /api/brews</c> with an optional <c>Idempotency-Key</c> header value (SAVE-8). With a key, the first
    /// request that commits stores (user, key, request fingerprint, brew) in <c>brew_create_keys</c>, in the same
    /// transaction as the brew. Within 24 hours the same user sending the same key again gets:
    /// <list type="bullet">
    /// <item>the same request (<see cref="CreateIdempotency.Fingerprint"/>): <see cref="BrewOutcome{T}.Ok"/> with that
    /// brew as it is now (201 again; nothing new is created). Two such requests racing each other also create one brew:
    /// the second waits on the key's unique index, then replays.</item>
    /// <item>a different request: <see cref="BrewOutcome{T}.KeyReused"/> (422).</item>
    /// </list>
    /// A replay whose brew was deleted meanwhile creates a new one (the key row went with the brew); one the caller
    /// can no longer edit answers 403. Other users' keys never match. Expired keys are deleted here (cleanup on write).
    /// </summary>
    public async Task<BrewOutcome<BrewForEdit>> CreateAsync(
        CreateBrewRequest request, Guid userId, string? idempotencyKey, CancellationToken ct)
    {
        BrewCreateKey? createKey = null;
        if (idempotencyKey is not null)
        {
            if (CreateIdempotency.Parse(idempotencyKey) is not { } key)
            {
                return new BrewOutcome<BrewForEdit>.Invalid(new Dictionary<string, string[]>(StringComparer.Ordinal)
                {
                    [CreateIdempotency.ErrorKey] = [$"{CreateIdempotency.HeaderName} must be 1 to {BrewCreateKey.MaxKeyLength} visible ASCII characters."],
                });
            }

            var keyTime = UtcNow();
            var cutoff = keyTime - BrewCreateKey.Lifetime;
            createKey = new BrewCreateKey
            {
                UserId = userId, Key = key, RequestHash = CreateIdempotency.Fingerprint(request), CreatedAt = keyTime,
            };
            await db.BrewCreateKeys.Where(k => k.CreatedAt <= cutoff).ExecuteDeleteAsync(ct);
            if (await ReplayAsync(createKey, cutoff, ct) is { } replay) return replay;
        }

        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);
        var doc = request.Doc is { ValueKind: not (System.Text.Json.JsonValueKind.Undefined or System.Text.Json.JsonValueKind.Null) } given
            ? inspector.Inspect(given)
            : inspector.Inspect(BrewRules.EmptyDoc);
        AddAll(errors, doc.Errors);
        BrewRules.CheckDocSchemaVersion(request.DocSchemaVersion, inspector.Manifest, errors);
        var style = BrewRules.Style(request.Style, errors);
        var snippets = BrewRules.Snippets(request.Snippets, errors);
        var sourceMarkdown = BrewRules.SourceMarkdown(request.SourceMarkdown, errors);
        var meta = BrewRules.Merge(BrewRules.Defaults, request.Meta, errors);
        await CheckThemeAsync(request.Meta, BrewRules.Defaults.Theme, meta.Theme, errors, ct);

        var invited = new List<Guid>();
        if (request.Meta?.Authors is { } handles && BrewRules.NormalizeHandles(handles, errors) is { } normalized)
        {
            var users = await ResolveHandlesAsync(normalized, errors, ct);
            invited.AddRange(normalized.Where(users.ContainsKey).Select(h => users[h]).Where(id => id != userId));
        }

        if (errors.Count > 0) return new BrewOutcome<BrewForEdit>.Invalid(errors);

        var now = UtcNow();
        var brew = new Brew
        {
            Title = BrewRules.TitleOrFallback(meta.Title, doc.FirstHeading),
            Description = meta.Description,
            Tags = [.. meta.Tags],
            Lang = meta.Lang,
            Theme = meta.Theme,
            Published = meta.Published,
            ThumbnailUrl = meta.ThumbnailUrl,
            DocSchemaVersion = inspector.Manifest.DocSchemaVersion,
            Doc = doc.SanitizedJson,
            Style = style!,
            Snippets = snippets,
            SourceMarkdown = sourceMarkdown,
            SearchText = doc.PlainText,
            PageCount = doc.PageCount,
            CreatedAt = now,
            UpdatedAt = now,
        };
        AddAuthors(brew, userId, invited);
        if (createKey is null)
        {
            await InsertAsync(brew, ct);
            return await GetForEditAsync(brew.EditId, userId, ct);
        }

        createKey.BrewId = brew.Id;
        db.BrewCreateKeys.Add(createKey);
        try
        {
            await InsertAsync(brew, ct);                                // the brew and its key in one transaction
        }
        catch (DbUpdateException ex) when (DbErrors.IsUniqueViolation(ex, BrewCreateKeyConfiguration.PrimaryKeyName))
        {
            // A request with the same key committed while this one ran (its uncommitted key row made this insert
            // wait); this transaction rolled back, so nothing of it is stored. Answer with that request's brew.
            db.ChangeTracker.Clear();
            return await ReplayAsync(createKey, createKey.CreatedAt - BrewCreateKey.Lifetime, ct)
                   ?? throw new InvalidOperationException("The brew of a concurrent request with the same Idempotency-Key is gone.");
        }

        return await GetForEditAsync(brew.EditId, userId, ct);
    }

    /// <summary>
    /// The answer to a create whose key (<paramref name="attempt"/>'s user and key) is stored and newer than
    /// <paramref name="cutoff"/>: its brew, or <see cref="BrewOutcome{T}.KeyReused"/> when the request differs. Null
    /// when the key is unknown (or its brew is gone): create.
    /// </summary>
    private async Task<BrewOutcome<BrewForEdit>?> ReplayAsync(BrewCreateKey attempt, DateTimeOffset cutoff, CancellationToken ct)
    {
        var stored = await db.BrewCreateKeys.AsNoTracking()
            .Where(k => k.UserId == attempt.UserId && k.Key == attempt.Key && k.CreatedAt > cutoff)
            .Select(k => new { k.RequestHash, EditId = db.Brews.Where(b => b.Id == k.BrewId).Select(b => b.EditId).FirstOrDefault() })
            .SingleOrDefaultAsync(ct);
        if (stored?.EditId is null) return null;
        if (!stored.RequestHash.AsSpan().SequenceEqual(attempt.RequestHash)) return new BrewOutcome<BrewForEdit>.KeyReused();
        return await GetForEditAsync(stored.EditId, attempt.UserId, ct);
    }

    /// <summary><c>POST /api/brews/{shareId}/clone</c>: a private copy owned by <paramref name="userId"/>.</summary>
    public async Task<BrewOutcome<BrewForEdit>> CloneAsync(string shareId, Guid userId, CancellationToken ct)
    {
        var source = await db.Brews.AsNoTracking()
            .Where(b => b.ShareId == shareId)
            .Select(b => new
            {
                b.DocSchemaVersion, b.Doc, b.Style, b.Snippets, b.Title, b.Description, b.Tags, b.Lang, b.Theme,
                b.ThumbnailUrl, b.PageCount, b.SearchText, b.Lock,
            })
            .SingleOrDefaultAsync(ct);
        if (source is null) return new BrewOutcome<BrewForEdit>.NotFound();
        if (source.Lock is { } brewLock) return new BrewOutcome<BrewForEdit>.Locked(brewLock.Code, brewLock.ShareMessage);

        var now = UtcNow();
        var brew = new Brew
        {
            Title = CopyTitle(source.Title),
            Description = source.Description,
            Tags = source.Tags,
            Lang = source.Lang,
            Theme = source.Theme,
            Published = false,
            ThumbnailUrl = source.ThumbnailUrl,
            DocSchemaVersion = source.DocSchemaVersion,
            Doc = source.Doc,
            Style = source.Style,
            Snippets = source.Snippets,
            SearchText = source.SearchText,
            PageCount = source.PageCount,
            CreatedAt = now,
            UpdatedAt = now,
        };
        AddAuthors(brew, userId, []);
        await InsertAsync(brew, ct);
        return await GetForEditAsync(brew.EditId, userId, ct);
    }

    /// <summary>
    /// <c>PUT /api/brews/{editId}</c> (plan §8.4). Only the fields listed here are written; authors, lock,
    /// views and timestamps never come from the client (upstream copied the whole client brew with _.assign).
    /// </summary>
    public async Task<BrewOutcome<SaveBrewResponse>> SaveAsync(string editId, SaveBrewRequest request, Guid userId, CancellationToken ct)
    {
        var head = await db.Brews.AsNoTracking()
            .Where(b => b.EditId == editId)
            .Select(b => new SaveHead(
                b.Id, b.Version, b.Title, b.Description, b.Tags, b.Lang, b.Theme, b.Published, b.ThumbnailUrl,
                b.Authors.OrderBy(a => a.Position).Select(a => new AuthorRow(a.UserId, a.Role, a.Position, a.User!.Handle)).ToList()))
            .SingleOrDefaultAsync(ct);
        if (head is null) return new BrewOutcome<SaveBrewResponse>.NotFound();

        var role = RoleOf(head.Authors, userId);
        if (!AccessPolicy.CanEdit(role)) return NotAnAuthor<SaveBrewResponse>();
        if (head.Version != request.BaseVersion) return new BrewOutcome<SaveBrewResponse>.Conflict(head.Version);

        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);
        var doc = inspector.Inspect(request.Doc);
        AddAll(errors, doc.Errors);
        BrewRules.CheckDocSchemaVersion(request.DocSchemaVersion, inspector.Manifest, errors);
        var style = BrewRules.Style(request.Style, errors);
        var snippets = BrewRules.Snippets(request.Snippets, errors);
        var current = new BrewMeta(head.Title, head.Description, head.Tags, head.Lang, head.Theme, head.Published, head.ThumbnailUrl);
        var meta = BrewRules.Merge(current, request.Meta, errors);
        await CheckThemeAsync(request.Meta, current.Theme, meta.Theme, errors, ct);

        List<AuthorRow>? newAuthors = null;
        if (request.Meta?.Authors is { } handles && BrewRules.NormalizeHandles(handles, errors) is { } normalized)
        {
            if (!AccessPolicy.CanManageAuthors(role))
            {
                if (!normalized.ToHashSet().SetEquals(head.Authors.Select(a => a.Handle)))
                {
                    return new BrewOutcome<SaveBrewResponse>.Forbidden("Only the owner can change the author list.");
                }
            }
            else
            {
                newAuthors = await PlanAuthorsAsync(head.Authors, userId, normalized, errors, ct);
            }
        }

        if (errors.Count > 0) return new BrewOutcome<SaveBrewResponse>.Invalid(errors);

        var now = UtcNow();
        var title = BrewRules.TitleOrFallback(meta.Title, doc.FirstHeading);
        string[] tags = [.. meta.Tags];
        var docSchemaVersion = inspector.Manifest.DocSchemaVersion;

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var updated = await db.Brews
            .Where(b => b.Id == head.Id && b.Version == request.BaseVersion)
            .ExecuteUpdateAsync(s => s
                .SetProperty(b => b.Doc, doc.SanitizedJson)
                .SetProperty(b => b.DocSchemaVersion, docSchemaVersion)
                .SetProperty(b => b.Style, style)
                .SetProperty(b => b.Snippets, snippets)
                .SetProperty(b => b.PageCount, doc.PageCount)
                .SetProperty(b => b.SearchText, doc.PlainText)
                .SetProperty(b => b.Title, title)
                .SetProperty(b => b.Description, meta.Description)
                .SetProperty(b => b.Tags, tags)
                .SetProperty(b => b.Lang, meta.Lang)
                .SetProperty(b => b.Theme, meta.Theme)
                .SetProperty(b => b.Published, meta.Published)
                .SetProperty(b => b.ThumbnailUrl, meta.ThumbnailUrl)
                .SetProperty(b => b.Version, b => b.Version + 1)
                .SetProperty(b => b.UpdatedAt, now), ct);

        if (updated == 0)
        {
            // Another save (or a delete) got there first; its transaction has committed by now.
            await transaction.RollbackAsync(ct);
            var serverVersion = await db.Brews.Where(b => b.Id == head.Id).Select(b => (int?)b.Version).SingleOrDefaultAsync(ct);
            return serverVersion is { } v
                ? new BrewOutcome<SaveBrewResponse>.Conflict(v)
                : new BrewOutcome<SaveBrewResponse>.NotFound();
        }

        var authors = head.Authors;
        if (newAuthors is not null)
        {
            // The plan was made from the list read before the transaction. The UPDATE above now holds the row lock
            // that DELETE (leave) also takes, so the list can no longer change under us; if it already did (someone
            // left meanwhile), writing the stale plan could resurrect them or drop the owner, so treat it as a conflict.
            var stored = await db.BrewAuthors.AsNoTracking().Where(a => a.BrewId == head.Id)
                .Select(a => new { a.UserId, a.Role }).ToListAsync(ct);
            if (stored.Count != head.Authors.Count
                || !stored.All(a => head.Authors.Any(h => h.UserId == a.UserId && h.Role == a.Role)))
            {
                await transaction.RollbackAsync(ct);
                return new BrewOutcome<SaveBrewResponse>.Conflict(head.Version);
            }

            await ReplaceCoAuthorsAsync(head.Id, userId, newAuthors, ct);
            authors = newAuthors;
        }
        else if (role is { } before && AccessPolicy.RoleAfterSave(before) is var promoted && promoted != before)
        {
            // An invited author accepts the invitation by saving.
            await db.BrewAuthors
                .Where(a => a.BrewId == head.Id && a.UserId == userId && a.Role == before)
                .ExecuteUpdateAsync(s => s.SetProperty(a => a.Role, promoted), ct);
            authors = [.. authors.Select(a => a.UserId == userId ? a with { Role = promoted } : a)];
        }

        await transaction.CommitAsync(ct);
        return new BrewOutcome<SaveBrewResponse>.Ok(
            new SaveBrewResponse(request.BaseVersion + 1, now, title, doc.PageCount, ToInfo(authors)));
    }

    /// <summary>
    /// <c>DELETE /api/brews/{editId}</c>: removes the caller from the authors. When no Owner or Author remains the
    /// brew is deleted; when the owner leaves, the first remaining author becomes the owner.
    /// </summary>
    public async Task<BrewOutcome<DeleteBrewResponse>> DeleteAsync(string editId, Guid userId, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);

        // Lock the brew row so concurrent leaves (and saves changing authors) are serialized: without it, the
        // last two authors leaving at once could each see the other remain and leave an authorless brew behind.
        var ids = await db.Database
            .SqlQuery<Guid>($"SELECT id AS \"Value\" FROM brews WHERE edit_id = {editId} FOR UPDATE")
            .ToListAsync(ct);                                           // not composed: runs exactly this SQL
        if (ids is not [var id]) return new BrewOutcome<DeleteBrewResponse>.NotFound();

        var authors = await db.BrewAuthors.Where(a => a.BrewId == id).OrderBy(a => a.Position).ToListAsync(ct);
        var mine = authors.FirstOrDefault(a => a.UserId == userId);
        if (mine is null) return NotAnAuthor<DeleteBrewResponse>();

        var remaining = authors.Where(a => a != mine && AccessPolicy.IsActiveAuthor(a.Role)).ToList();
        if (remaining.Count == 0)
        {
            await db.Brews.Where(b => b.Id == id).ExecuteDeleteAsync(ct);        // brew_authors cascade
            await transaction.CommitAsync(ct);
            return new BrewOutcome<DeleteBrewResponse>.Ok(new DeleteBrewResponse(BrewDeleted: true));
        }

        db.BrewAuthors.Remove(mine);
        if (mine.Role == AuthorRole.Owner)
        {
            // The new owner moves to the front: author lists are shown by position, owner first (an invited user
            // may sit between the old owner and the next author).
            var owner = remaining[0];
            owner.Role = AuthorRole.Owner;
            short position = 0;
            foreach (var author in authors.Where(a => a != mine).OrderBy(a => a == owner ? 0 : 1).ThenBy(a => a.Position))
            {
                author.Position = position++;
            }
        }

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return new BrewOutcome<DeleteBrewResponse>.Ok(new DeleteBrewResponse(BrewDeleted: false));
    }

    // ---- helpers -------------------------------------------------------------------------------

    /// <summary>
    /// The author list the owner asked for: the owner first, then <paramref name="handles"/> in order. Existing
    /// authors keep their role; new ones are Invited. Null (with errors) when a handle has no account.
    /// </summary>
    private async Task<List<AuthorRow>?> PlanAuthorsAsync(
        List<AuthorRow> current, Guid ownerId, IReadOnlyList<string> handles, Dictionary<string, string[]> errors, CancellationToken ct)
    {
        var owner = current.Single(a => a.UserId == ownerId);
        var existing = current.ToDictionary(a => a.Handle, StringComparer.Ordinal);
        var wanted = handles.Where(h => h != owner.Handle).ToList();
        var users = await ResolveHandlesAsync(wanted.Where(h => !existing.ContainsKey(h)).ToList(), errors, ct);
        if (errors.Count > 0) return null;

        var result = new List<AuthorRow> { owner with { Position = 0 } };
        foreach (var handle in wanted)
        {
            var position = (short)result.Count;
            result.Add(existing.TryGetValue(handle, out var author)
                ? author with { Position = position }
                : new AuthorRow(users[handle], AuthorRole.Invited, position, handle));
        }

        return result;
    }

    /// <summary>Rewrites every author row except the owner's (inside the save's transaction).</summary>
    private async Task ReplaceCoAuthorsAsync(Guid brewId, Guid ownerId, List<AuthorRow> authors, CancellationToken ct)
    {
        await db.BrewAuthors.Where(a => a.BrewId == brewId && a.UserId != ownerId).ExecuteDeleteAsync(ct);
        await db.BrewAuthors.Where(a => a.BrewId == brewId && a.UserId == ownerId)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.Position, (short)0), ct);
        db.BrewAuthors.AddRange(authors.Where(a => a.UserId != ownerId).Select(a => new BrewAuthor
        {
            BrewId = brewId, UserId = a.UserId, Role = a.Role, Position = a.Position,
        }));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Account ids by handle; adds <c>meta.authors</c> errors for handles without an account.</summary>
    private async Task<Dictionary<string, Guid>> ResolveHandlesAsync(
        IReadOnlyList<string> handles, Dictionary<string, string[]> errors, CancellationToken ct)
    {
        if (handles.Count == 0) return [];
        var found = await db.Users.AsNoTracking()
            .Where(u => handles.Contains(u.Handle))
            .Select(u => new { u.Handle, u.Id })
            .ToDictionaryAsync(u => u.Handle, u => u.Id, StringComparer.Ordinal, ct);
        foreach (var missing in handles.Where(h => !found.ContainsKey(h)))
        {
            BrewRules.Add(errors, "meta.authors", $"No user has the handle '{missing}'.");
        }

        return found;
    }

    private static void AddAuthors(Brew brew, Guid ownerId, IEnumerable<Guid> invited)
    {
        brew.Authors.Add(new BrewAuthor { BrewId = brew.Id, UserId = ownerId, Role = AuthorRole.Owner, Position = 0 });
        foreach (var userId in invited.Distinct())
        {
            brew.Authors.Add(new BrewAuthor
            {
                BrewId = brew.Id, UserId = userId, Role = AuthorRole.Invited, Position = (short)brew.Authors.Count,
            });
        }
    }

    /// <summary>Inserts a new brew; on the (unlikely) share or edit id collision, draws new ids and retries.</summary>
    private async Task InsertAsync(Brew brew, CancellationToken ct)
    {
        db.Brews.Add(brew);
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateException ex) when (attempt < MaxInsertAttempts
                                               && (DbErrors.IsUniqueViolation(ex, "ix_brews_share_id")
                                                   || DbErrors.IsUniqueViolation(ex, "ix_brews_edit_id")))
            {
                brew.ShareId = Nanoid.Generate(size: 12);
                brew.EditId = Nanoid.Generate(size: 12);
            }
        }
    }

    private static string CopyTitle(string title) =>
        StoredText.Truncate(string.IsNullOrWhiteSpace(title) ? "Copy" : $"Copy of {title}", BrewRules.MaxTitle);

    /// <summary>
    /// Adds a <c>meta.theme</c> error when the request sets a theme that does not exist: neither a static theme key
    /// nor the share id of a brew tagged as a theme. A theme equal to <paramref name="current"/> always passes, so a
    /// stored theme that was deleted or untagged later never blocks saves.
    /// </summary>
    private async Task CheckThemeAsync(
        BrewMetaInput? input, string current, string theme, Dictionary<string, string[]> errors, CancellationToken ct)
    {
        if (input?.Theme is null || theme == current || errors.ContainsKey("meta.theme") || themes.Contains(theme)) return;

        string[] themeTags = [.. BrewTags.ThemeVariants];
        if (await db.Brews.AnyAsync(b => b.ShareId == theme && b.Tags.Any(t => themeTags.Contains(t)), ct)) return;
        BrewRules.Add(errors, "meta.theme", $"'{theme}' is not a theme key or a user theme's share id");
    }

    private static AuthorRole? RoleOf(IEnumerable<AuthorRow> authors, Guid? userId) =>
        userId is { } id ? authors.FirstOrDefault(a => a.UserId == id)?.Role : null;

    private static List<BrewAuthorInfo> ToInfo(IEnumerable<AuthorRow> authors) =>
        [.. authors.OrderBy(a => a.Position).Select(a => new BrewAuthorInfo(a.Handle, a.Role))];

    private static BrewOutcome<T> NotAnAuthor<T>() =>
        new BrewOutcome<T>.Forbidden("You are not an author of this brew.");

    private static void AddAll(Dictionary<string, string[]> errors, IReadOnlyDictionary<string, string[]> more)
    {
        foreach (var (key, messages) in more)
        {
            foreach (var message in messages) BrewRules.Add(errors, key, message);
        }
    }

    /// <summary>Now, truncated to PostgreSQL's microsecond precision so responses match what is stored.</summary>
    private static DateTimeOffset UtcNow()
    {
        var now = DateTimeOffset.UtcNow;
        return now.AddTicks(-(now.Ticks % 10));
    }

    private sealed record AuthorRow(Guid UserId, AuthorRole Role, short Position, string Handle);

    private sealed record EditRow(
        string EditId, string ShareId, int Version, int DocSchemaVersion, string Doc, string Style, string? Snippets,
        string? SourceMarkdown, string Title, string Description, string[] Tags, string Lang, string Theme, bool Published,
        string? ThumbnailUrl, int PageCount, int Views, BrewLock? Lock, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        List<AuthorRow> Authors);

    private sealed record ShareRow(
        Guid Id, string ShareId, string EditId, int DocSchemaVersion, string Doc, string Style,
        string Title, string Description, string[] Tags, string Lang, string Theme, bool Published,
        string? ThumbnailUrl, int PageCount, int Views, BrewLock? Lock, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt,
        List<AuthorRow> Authors);

    private sealed record SaveHead(
        Guid Id, int Version, string Title, string Description, string[] Tags, string Lang, string Theme, bool Published,
        string? ThumbnailUrl, List<AuthorRow> Authors);
}

/// <summary>What a <see cref="BrewService"/> call produced; the endpoints map each case to a status code.</summary>
public abstract record BrewOutcome<T>
{
    private BrewOutcome()
    {
    }

    /// <summary>200/201.</summary>
    public sealed record Ok(T Value) : BrewOutcome<T>;

    /// <summary>404: no brew with that id.</summary>
    public sealed record NotFound : BrewOutcome<T>;

    /// <summary>403: signed in, but not allowed.</summary>
    public sealed record Forbidden(string Detail) : BrewOutcome<T>;

    /// <summary>400: validation errors keyed by field or JSON path.</summary>
    public sealed record Invalid(IDictionary<string, string[]> Errors) : BrewOutcome<T>;

    /// <summary>409: stale <c>baseVersion</c>.</summary>
    public sealed record Conflict(int ServerVersion) : BrewOutcome<T>;

    /// <summary>423: a moderation lock blocks the share view.</summary>
    public sealed record Locked(int Code, string Message) : BrewOutcome<T>;

    /// <summary>422: the <c>Idempotency-Key</c> of a create was used for a different request (SAVE-8).</summary>
    public sealed record KeyReused : BrewOutcome<T>;
}
