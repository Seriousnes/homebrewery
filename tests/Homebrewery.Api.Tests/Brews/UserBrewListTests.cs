using System.Net;
using System.Text.Json;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>
/// P2.6: <c>GET /api/users/{handle}/brews</c>. Everyone sees the user's published, unlocked brews (as owner or author);
/// the user themselves also sees unpublished, locked and invited brews, with edit ids and roles.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class UserBrewListTests(ApiFixture api, BrewActors actors) : IClassFixture<BrewActors>
{
    [Fact]
    public async Task Others_see_only_published_unlocked_brews_without_edit_ids()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var published = await TestBrews.CreateAsync(user.Client, ct, title: "Published");
        var draft = await TestBrews.CreateAsync(user.Client, ct, title: "Draft", published: false);
        var locked = await TestBrews.CreateAsync(user.Client, ct, title: "Locked");
        await api.Factory.LockAsync(locked.ShareId, ct);

        foreach (var client in new[] { actors.Anonymous, actors.Other.Client })
        {
            var list = await ListAsync(client, user.Handle, ct);

            Assert.Equal(user.Handle, list.GetProperty("handle").GetString());
            Assert.False(list.GetProperty("own").GetBoolean());
            Assert.Equal(1, list.GetProperty("total").GetInt32());
            var item = list.GetProperty("items").EnumerateArray().Single();
            Assert.Equal(published.ShareId, item.GetProperty("shareId").GetString());
            Assert.Equal(JsonValueKind.Null, item.GetProperty("editId").ValueKind);
            Assert.Equal(JsonValueKind.Null, item.GetProperty("role").ValueKind);
            Assert.DoesNotContain(draft.ShareId, ShareIds(list));
        }
    }

    [Fact]
    public async Task The_user_sees_every_brew_with_edit_ids_and_roles()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var published = await TestBrews.CreateAsync(user.Client, ct, title: "Published");
        var draft = await TestBrews.CreateAsync(user.Client, ct, title: "Draft", published: false);
        var locked = await TestBrews.CreateAsync(user.Client, ct, title: "Locked");
        await api.Factory.LockAsync(locked.ShareId, ct);

        var list = await ListAsync(user.Client, user.Handle, ct);

        Assert.True(list.GetProperty("own").GetBoolean());
        Assert.Equal(3, list.GetProperty("total").GetInt32());
        var items = Items(list);
        Assert.Equal(new[] { published.ShareId, draft.ShareId, locked.ShareId }.Order(), items.Keys.Order());
        Assert.Equal(draft.EditId, items[draft.ShareId].GetProperty("editId").GetString());
        Assert.False(items[draft.ShareId].GetProperty("published").GetBoolean());
        Assert.Equal("owner", items[draft.ShareId].GetProperty("role").GetString());
        Assert.True(items[locked.ShareId].GetProperty("locked").GetBoolean());
        Assert.False(items[published.ShareId].GetProperty("locked").GetBoolean());
    }

    [Fact]
    public async Task Brews_are_listed_most_recently_updated_first()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var older = await TestBrews.CreateAsync(user.Client, ct, title: "Older");
        var newer = await TestBrews.CreateAsync(user.Client, ct, title: "Newer");
        await api.Factory.UpdateAsync(older.ShareId, s => s.SetProperty(b => b.UpdatedAt, DateTimeOffset.UtcNow.AddDays(-2)), ct);

        var list = await ListAsync(actors.Anonymous, user.Handle, ct);

        Assert.Equal([newer.ShareId, older.ShareId], ShareIds(list));
    }

    [Fact]
    public async Task Co_authored_brews_are_listed_but_invitations_only_for_the_invited_user()
    {
        var ct = TestContext.Current.CancellationToken;
        var shared = await actors.CreateSharedBrewAsync(ct);
        await api.Factory.UpdateAsync(shared.ShareId, s => s.SetProperty(b => b.Published, true), ct);

        var authorPublic = await ListAsync(actors.Anonymous, actors.Author.Handle, ct);
        var authorOwn = await ListAsync(actors.Author.Client, actors.Author.Handle, ct);
        var invitedPublic = await ListAsync(actors.Anonymous, actors.Invited.Handle, ct);
        var invitedOwn = await ListAsync(actors.Invited.Client, actors.Invited.Handle, ct);

        Assert.Contains(shared.ShareId, ShareIds(authorPublic));
        Assert.Equal("author", Items(authorOwn)[shared.ShareId].GetProperty("role").GetString());
        Assert.Equal(shared.EditId, Items(authorOwn)[shared.ShareId].GetProperty("editId").GetString());
        Assert.DoesNotContain(shared.ShareId, ShareIds(invitedPublic));
        Assert.Equal("invited", Items(invitedOwn)[shared.ShareId].GetProperty("role").GetString());

        var item = Items(authorPublic)[shared.ShareId];
        Assert.Equal([actors.Owner.Handle, actors.Author.Handle], item.GetProperty("authors").EnumerateArray().Select(a => a.GetString()));
    }

    [Fact]
    public async Task Invitations_come_after_the_users_own_brews()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var own = await TestBrews.CreateAsync(user.Client, ct, title: "Mine", published: false);
        await api.Factory.UpdateAsync(own.ShareId, s => s.SetProperty(b => b.UpdatedAt, DateTimeOffset.UtcNow.AddDays(-30)), ct);
        var invitations = new List<string>();
        for (var i = 0; i < 3; i++)
        {
            invitations.Add((await TestBrews.CreateAsync(actors.Other.Client, ct, title: $"Invite {i}", authors: [user.Handle])).ShareId);
        }

        var list = await ListAsync(user.Client, user.Handle, ct);

        // The list is capped at MaxUserBrews, so invitations must not push the user's own brews out of it.
        var roles = list.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("role").GetString()).ToList();
        Assert.Equal(["owner", "invited", "invited", "invited"], roles);
        Assert.Equal(own.ShareId, ShareIds(list)[0]);
    }

    [Fact]
    public async Task Handles_are_case_insensitive()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(user.Client, ct, title: "Case");

        var list = await ListAsync(user.Client, $" {user.Handle.ToUpperInvariant()} ", ct);

        Assert.Equal(user.Handle, list.GetProperty("handle").GetString());
        Assert.True(list.GetProperty("own").GetBoolean());
        Assert.Equal([brew.ShareId], ShareIds(list));
    }

    [Fact]
    public async Task A_user_without_brews_has_an_empty_list()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);

        var list = await ListAsync(actors.Anonymous, user.Handle, ct);

        Assert.Equal(0, list.GetProperty("total").GetInt32());
        Assert.Empty(ShareIds(list));
    }

    [Theory]
    [InlineData("no-such-user-here")]
    [InlineData("x")]                                          // not a valid handle
    [InlineData("bad%20handle")]
    public async Task Unknown_users_are_404(string handle)
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Anonymous.GetAsync($"/api/users/{handle}/brews", ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.NotFound, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    private static async Task<JsonElement> ListAsync(HttpClient client, string handle, CancellationToken ct)
    {
        using var response = await client.GetAsync($"/api/users/{Uri.EscapeDataString(handle)}/brews", ct);
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        return await TestJson.ReadAsync<JsonElement>(response, ct);
    }

    private static List<string> ShareIds(JsonElement list) =>
        [.. list.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("shareId").GetString()!)];

    private static Dictionary<string, JsonElement> Items(JsonElement list) =>
        list.GetProperty("items").EnumerateArray().ToDictionary(i => i.GetProperty("shareId").GetString()!);
}
