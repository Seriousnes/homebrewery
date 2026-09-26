using Homebrewery.Core;

namespace Homebrewery.Api.Tests;

/// <summary>P2.3: the role rules in <see cref="AccessPolicy"/>.</summary>
public sealed class AccessPolicyTests
{
    private static readonly Guid Owner = Guid.CreateVersion7(), Author = Guid.CreateVersion7(), Invited = Guid.CreateVersion7(), Other = Guid.CreateVersion7();

    private static Brew NewBrew()
    {
        var brew = new Brew();
        brew.Authors.AddRange([
            new BrewAuthor { BrewId = brew.Id, UserId = Owner, Role = AuthorRole.Owner, Position = 0 },
            new BrewAuthor { BrewId = brew.Id, UserId = Author, Role = AuthorRole.Author, Position = 1 },
            new BrewAuthor { BrewId = brew.Id, UserId = Invited, Role = AuthorRole.Invited, Position = 2 },
        ]);
        return brew;
    }

    [Fact]
    public void Owners_authors_and_invited_users_can_edit()
    {
        var brew = NewBrew();

        Assert.True(AccessPolicy.CanEdit(brew, Owner));
        Assert.True(AccessPolicy.CanEdit(brew, Author));
        Assert.True(AccessPolicy.CanEdit(brew, Invited));
        Assert.False(AccessPolicy.CanEdit(brew, Other));
        Assert.False(AccessPolicy.CanEdit(brew, null));
    }

    [Fact]
    public void Only_the_owner_manages_authors()
    {
        var brew = NewBrew();

        Assert.True(AccessPolicy.CanManageAuthors(AccessPolicy.RoleOf(brew.Authors, Owner)));
        Assert.False(AccessPolicy.CanManageAuthors(AccessPolicy.RoleOf(brew.Authors, Author)));
        Assert.False(AccessPolicy.CanManageAuthors(AccessPolicy.RoleOf(brew.Authors, Invited)));
        Assert.False(AccessPolicy.CanManageAuthors(null));
    }

    [Fact]
    public void Views_count_for_readers_only()
    {
        var brew = NewBrew();

        Assert.False(AccessPolicy.CountsAsView(AccessPolicy.RoleOf(brew.Authors, Owner)));
        Assert.False(AccessPolicy.CountsAsView(AccessPolicy.RoleOf(brew.Authors, Invited)));
        Assert.True(AccessPolicy.CountsAsView(AccessPolicy.RoleOf(brew.Authors, Other)));
        Assert.True(AccessPolicy.CountsAsView(AccessPolicy.RoleOf(brew.Authors, null)));
    }

    [Fact]
    public void Invited_users_are_promoted_once()
    {
        var brew = NewBrew();

        Assert.True(AccessPolicy.PromoteInvited(brew, Invited));
        Assert.False(AccessPolicy.PromoteInvited(brew, Invited));
        Assert.False(AccessPolicy.PromoteInvited(brew, Owner));
        Assert.False(AccessPolicy.PromoteInvited(brew, Other));
        Assert.Equal(AuthorRole.Author, AccessPolicy.RoleOf(brew.Authors, Invited));
        Assert.Equal(AuthorRole.Owner, AccessPolicy.RoleOf(brew.Authors, Owner));
    }
}
