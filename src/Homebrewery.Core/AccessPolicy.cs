namespace Homebrewery.Core;

/// <summary>
/// Who may do what with a brew. A user's <see cref="AuthorRole"/> in <c>brew_authors</c> decides; a user without a
/// row (or an anonymous caller, <c>null</c>) is a reader.
/// <list type="table">
/// <listheader><term>Action</term><description>Allowed for</description></listheader>
/// <item><term>open for editing, save, remove yourself (DELETE)</term><description>Owner, Author, Invited</description></item>
/// <item><term>change the author list (<c>meta.authors</c>)</term><description>Owner</description></item>
/// <item><term>read the share view, clone</term><description>everyone (a lock blocks both, for everyone)</description></item>
/// <item><term>count as a view</term><description>everyone except Owner, Author and Invited</description></item>
/// </list>
/// An Invited user becomes an Author on their first save (<see cref="PromoteInvited"/>). When the owner leaves,
/// the first remaining author (by position) becomes the owner; when no Owner or Author remains, the brew is deleted.
/// </summary>
public static class AccessPolicy
{
    /// <summary>The role of <paramref name="userId"/> among <paramref name="authors"/>, or null.</summary>
    public static AuthorRole? RoleOf(IEnumerable<BrewAuthor> authors, Guid? userId) =>
        userId is { } id ? authors.FirstOrDefault(a => a.UserId == id)?.Role : null;

    public static bool CanEdit(AuthorRole? role) => role is AuthorRole.Owner or AuthorRole.Author or AuthorRole.Invited;

    public static bool CanEdit(Brew brew, Guid? userId) => CanEdit(RoleOf(brew.Authors, userId));

    public static bool CanManageAuthors(AuthorRole? role) => role is AuthorRole.Owner;

    /// <summary>Whether a share view by a user with <paramref name="role"/> increments the view count.</summary>
    public static bool CountsAsView(AuthorRole? role) => role is null;

    /// <summary>Whether a role keeps a brew alive (an Invited user who never saved does not).</summary>
    public static bool IsActiveAuthor(AuthorRole role) => role is AuthorRole.Owner or AuthorRole.Author;

    /// <summary>The role a user has after saving the brew: an Invited user becomes an Author, others keep theirs.</summary>
    public static AuthorRole RoleAfterSave(AuthorRole role) => role == AuthorRole.Invited ? AuthorRole.Author : role;

    /// <summary>
    /// Applies <see cref="RoleAfterSave"/> to <paramref name="userId"/> (called on save). Returns true when the role
    /// changed.
    /// </summary>
    public static bool PromoteInvited(Brew brew, Guid userId)
    {
        var author = brew.Authors.FirstOrDefault(a => a.UserId == userId);
        if (author is null || RoleAfterSave(author.Role) == author.Role) return false;
        author.Role = RoleAfterSave(author.Role);
        return true;
    }
}
