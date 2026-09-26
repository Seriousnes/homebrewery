using System.Text.RegularExpressions;
using Homebrewery.Api.Brews;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Themes;

/// <summary>
/// Theme use cases behind <c>/api/themes</c> (plan §8.7). A theme id is a static theme key from
/// <see cref="ThemeCatalog"/> (looked up first, case-sensitive) or the share id of a user theme: a brew tagged
/// <c>meta:theme</c> (<see cref="BrewTags"/>). A user theme builds on its own <c>theme</c> field.
/// </summary>
public sealed partial class ThemeService(AppDbContext db, ThemeCatalog catalog)
{
    /// <summary>Most user themes <see cref="ListAsync"/> returns.</summary>
    public const int MaxUserThemes = 500;

    /// <summary>Theme ids: static keys and share ids (same rule as a brew's <c>meta.theme</c>).</summary>
    [GeneratedRegex(@"\A[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ThemeId();

    /// <summary>
    /// <c>GET /api/themes</c>: the static themes, published user themes, and the caller's own user themes (as owner or
    /// author, published or not). Locked brews are listed only to their own authors.
    /// </summary>
    public async Task<ThemeList> ListAsync(Guid? userId, CancellationToken ct)
    {
        string[] themeTags = [.. BrewTags.ThemeVariants];
        var themes = db.Brews.AsNoTracking().Where(b => b.Tags.Any(t => themeTags.Contains(t)));   // tags && @themeTags
        themes = userId is { } id
            ? themes.Where(b => (b.Published && b.Lock == null)
                                || b.Authors.Any(a => a.UserId == id && (a.Role == AuthorRole.Owner || a.Role == AuthorRole.Author)))
            : themes.Where(b => b.Published && b.Lock == null);

        var rows = await themes
            .Select(b => new
            {
                b.ShareId,
                b.Title,
                b.Theme,
                b.ThumbnailUrl,
                b.Published,
                b.UpdatedAt,
                Author = b.Authors.Where(a => a.Role == AuthorRole.Owner).Select(a => a.User!.Handle).FirstOrDefault(),
                Mine = userId != null
                       && b.Authors.Any(a => a.UserId == userId && (a.Role == AuthorRole.Owner || a.Role == AuthorRole.Author)),
            })
            .OrderByDescending(r => r.Mine).ThenBy(r => r.Title).ThenBy(r => r.ShareId)
            .Take(MaxUserThemes)
            .ToListAsync(ct);

        return new ThemeList(
            catalog.Themes,
            [.. rows.Select(r => new UserThemeInfo(
                r.ShareId, NameOf(r.Title, r.ShareId), r.Author, r.Theme, r.ThumbnailUrl, r.Published, r.Mine, r.UpdatedAt))]);
    }

    /// <summary>
    /// <c>GET /api/themes/{theme}/bundle</c>: walks the chain from <paramref name="theme"/> to its root (static themes
    /// through <c>baseTheme</c>, user themes through their <c>theme</c> field) and returns it root first. A theme seen
    /// twice (a cycle) or a chain of more than <see cref="ThemeCatalog.MaxChain"/> themes is a broken chain, as is a
    /// base theme that is missing or not tagged <c>meta:theme</c>. User themes need no publishing (like share links),
    /// but a moderation lock on any of them blocks the bundle.
    /// </summary>
    public async Task<ThemeOutcome> GetBundleAsync(string theme, CancellationToken ct)
    {
        var styles = new List<ThemeStyle>();
        var snippets = new List<ThemeSnippetRef>();
        var chain = new List<string>();
        string? name = null;
        string? author = null;

        for (var current = theme; !string.IsNullOrEmpty(current);)
        {
            if (chain.Contains(current, StringComparer.Ordinal))
            {
                return new ThemeOutcome.BrokenChain($"The theme chain has a cycle: {string.Join(" → ", chain)} → {current}.", [.. chain, current]);
            }

            if (chain.Count == ThemeCatalog.MaxChain)
            {
                return new ThemeOutcome.BrokenChain(
                    $"The theme chain is longer than {ThemeCatalog.MaxChain} themes.", [.. chain, current]);
            }

            chain.Add(current);
            var requested = chain.Count == 1;

            if (catalog.TryGet(current, out var entry))
            {
                styles.Add(new ThemeStyleUrl(entry.ScopedStyle));
                snippets.Add(ThemeSnippetRef.ForGroup(entry.SnippetGroup));
                name ??= entry.Name;
                current = entry.BaseTheme;
                continue;
            }

            var row = ThemeId().IsMatch(current)
                ? await db.Brews.AsNoTracking()
                    .Where(b => b.ShareId == current)
                    .Select(b => new
                    {
                        b.Title,
                        b.Theme,
                        b.Style,
                        b.Snippets,
                        b.Tags,
                        b.Lock,
                        Owner = b.Authors.Where(a => a.Role == AuthorRole.Owner).Select(a => a.User!.Handle).FirstOrDefault(),
                    })
                    .SingleOrDefaultAsync(ct)
                : null;

            if (row is null)
            {
                return requested
                    ? new ThemeOutcome.NotFound()
                    : new ThemeOutcome.BrokenChain($"The base theme '{current}' of '{chain[^2]}' does not exist.", chain);
            }

            if (row.Lock is { } brewLock) return new ThemeOutcome.Locked(brewLock.Code, brewLock.ShareMessage);
            if (!BrewTags.IsTheme(row.Tags))
            {
                return new ThemeOutcome.BrokenChain(
                    $"The brew '{current}' is not a theme: it is not tagged {BrewTags.Theme}.", chain);
            }

            var title = NameOf(row.Title, current);
            if (row.Style.Length > 0) styles.Add(new ThemeStyleCss(row.Style, current));
            if (row.Snippets is { } json && json.Trim() is not "[]") snippets.Add(ThemeSnippetRef.ForUserTheme(title, new RawJson(json)));
            name ??= title;
            author ??= requested ? row.Owner : null;
            current = row.Theme;
        }

        styles.Reverse();
        snippets.Reverse();
        return new ThemeOutcome.Ok(new ThemeBundle(theme, name ?? theme, author, styles, snippets));
    }

    private static string NameOf(string title, string shareId) => string.IsNullOrWhiteSpace(title) ? shareId : title;
}

/// <summary>What <see cref="ThemeService.GetBundleAsync"/> produced; the endpoint maps each case to a status code.</summary>
public abstract record ThemeOutcome
{
    private ThemeOutcome()
    {
    }

    /// <summary>200.</summary>
    public sealed record Ok(ThemeBundle Bundle) : ThemeOutcome;

    /// <summary>404: the requested theme is neither a static theme nor a brew.</summary>
    public sealed record NotFound : ThemeOutcome;

    /// <summary>422: a cycle, a chain over the limit, or a base theme that is missing or not a theme.</summary>
    /// <param name="Chain">The theme ids walked, in order, ending with the one that broke the chain.</param>
    public sealed record BrokenChain(string Detail, IReadOnlyList<string> Chain) : ThemeOutcome;

    /// <summary>423: a theme brew in the chain has a moderation lock.</summary>
    public sealed record Locked(int Code, string Message) : ThemeOutcome;
}
