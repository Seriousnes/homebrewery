using System.Net;
using System.Text.Json;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>
/// P2.6: <c>GET /api/vault</c> searches published, unlocked brews with <c>websearch_to_tsquery('simple', q)</c> over title,
/// description and document text, with a sort whitelist and clamped paging. Every test searches for its own
/// <see cref="TestBrews.Token"/>, because the shared database holds other tests' brews.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class VaultTests(ApiFixture api, BrewActors actors) : IClassFixture<BrewActors>
{
    // ---- search ------------------------------------------------------------------------------------

    [Fact]
    public async Task Search_matches_title_description_and_document_text()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var inTitle = await Create($"Lair of {t}", ct);
        var inDescription = await Create("Plain title", ct, description: $"All about {t} here");
        var inBody = await Create("Another title", ct, body: $"Deep in the text: {t}.");
        await Create("Unrelated", ct, body: "nothing to see");

        var page = await SearchAsync($"q={t}", ct);

        Assert.Equal(3, page.GetProperty("total").GetInt32());
        Assert.Equal(
            new[] { inTitle.ShareId, inDescription.ShareId, inBody.ShareId }.Order(),
            ShareIds(page).Order());
    }

    [Fact]
    public async Task Search_is_case_insensitive_and_needs_every_word()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var both = await Create($"Red Dragon {t}", ct);
        await Create($"Blue Dragon {t}", ct);

        var page = await SearchAsync($"q={Uri.EscapeDataString($"RED {t.ToUpperInvariant()}")}", ct);

        Assert.Equal([both.ShareId], ShareIds(page));
    }

    [Fact]
    public async Task Search_uses_the_simple_configuration_for_any_language()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var russian = await Create($"Подземелье {t}", ct);
        var german = await Create($"Drachenhöhle der Größe {t}", ct);
        var greek = await Create($"Δράκος {t}", ct);
        var english = await Create($"The Dragons of {t}", ct);
        await Create($"Dragon {t}", ct);

        // Lower-casing works outside ASCII.
        Assert.Equal([russian.ShareId], ShareIds(await SearchAsync(Q($"подземелье {t}"), ct)));
        Assert.Equal([german.ShareId], ShareIds(await SearchAsync(Q($"DRACHENHÖHLE {t}"), ct)));
        Assert.Equal([german.ShareId], ShareIds(await SearchAsync(Q($"größe {t}"), ct)));
        Assert.Equal([greek.ShareId], ShareIds(await SearchAsync(Q($"δράκος {t}"), ct)));

        // No English stop words: 'the' must match too (the 'english' config would drop it and also match "Dragon").
        Assert.Equal([english.ShareId], ShareIds(await SearchAsync(Q($"the {t}"), ct)));

        // No stemming: 'dragon' does not match 'Dragons' (the 'english' config would stem both to 'dragon').
        Assert.DoesNotContain(english.ShareId, ShareIds(await SearchAsync(Q($"dragon {t}"), ct)));
    }

    [Fact]
    public async Task Search_accepts_web_search_syntax()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var redDragon = await Create($"{t} red dragon", ct);
        var dragonRed = await Create($"{t} dragon red", ct);
        var blue = await Create($"{t} blue wyvern", ct);

        Assert.Equal([redDragon.ShareId], ShareIds(await SearchAsync(Q($"{t} \"red dragon\""), ct)));
        Assert.Equal([blue.ShareId], ShareIds(await SearchAsync(Q($"{t} -dragon"), ct)));
        Assert.Equal(
            new[] { redDragon.ShareId, dragonRed.ShareId, blue.ShareId }.Order(),
            ShareIds(await SearchAsync(Q($"{t} red or wyvern"), ct)).Order());
    }

    [Fact]
    public async Task A_query_without_words_matches_nothing()
    {
        var ct = TestContext.Current.CancellationToken;

        var page = await SearchAsync(Q("!!! ---"), ct);

        Assert.Equal(0, page.GetProperty("total").GetInt32());
        Assert.Empty(ShareIds(page));
    }

    [Fact]
    public async Task Relevance_ranks_more_frequent_matches_first_and_is_the_default_with_q()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var once = await Create($"{t} once", ct);
        var often = await Create($"{t} often", ct, description: $"{t} {t} {t}", body: $"{t} and {t} again");
        await api.Factory.UpdateAsync(once.ShareId, s => s.SetProperty(b => b.UpdatedAt, DateTimeOffset.UtcNow.AddDays(1)), ct);

        var page = await SearchAsync($"q={t}", ct);

        Assert.Equal("relevance", page.GetProperty("sort").GetString());
        Assert.Equal("desc", page.GetProperty("dir").GetString());
        Assert.Equal([often.ShareId, once.ShareId], ShareIds(page));
    }

    // ---- hidden brews ------------------------------------------------------------------------------

    [Fact]
    public async Task Unpublished_and_locked_brews_are_hidden()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var visible = await Create($"Visible {t}", ct);
        var draft = await Create($"Draft {t}", ct, published: false);
        var locked = await Create($"Locked {t}", ct);
        await api.Factory.LockAsync(locked.ShareId, ct);

        var page = await SearchAsync($"q={t}", ct);
        var owners = await SearchAsync($"q={t}", ct, actors.Owner.Client);       // not even for the owner

        Assert.Equal([visible.ShareId], ShareIds(page));
        Assert.Equal(1, page.GetProperty("total").GetInt32());
        Assert.Equal([visible.ShareId], ShareIds(owners));
        Assert.DoesNotContain(draft.ShareId, ShareIds(owners));
    }

    // ---- items --------------------------------------------------------------------------------------

    [Fact]
    public async Task Items_are_list_summaries_without_edit_ids()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var shared = await actors.CreateSharedBrewAsync(ct);
        await api.Factory.UpdateAsync(shared.ShareId, s => s
            .SetProperty(b => b.Title, $"Shared {t}")
            .SetProperty(b => b.Description, "A description")
            .SetProperty(b => b.Tags, new[] { "type:adventure", "dragons" })
            .SetProperty(b => b.Theme, "5eDMG")
            .SetProperty(b => b.ThumbnailUrl, "https://example.com/t.png")
            .SetProperty(b => b.Views, 7)
            .SetProperty(b => b.Published, true), ct);

        var item = (await SearchAsync($"q={t}", ct, actors.Owner.Client)).GetProperty("items").EnumerateArray().Single();

        Assert.Equal(shared.ShareId, item.GetProperty("shareId").GetString());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("editId").ValueKind);
        Assert.Equal($"Shared {t}", item.GetProperty("title").GetString());
        Assert.Equal("A description", item.GetProperty("description").GetString());
        Assert.Equal(["type:adventure", "dragons"], item.GetProperty("tags").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal([actors.Owner.Handle, actors.Author.Handle], item.GetProperty("authors").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("5eDMG", item.GetProperty("theme").GetString());
        Assert.Equal("en", item.GetProperty("lang").GetString());
        Assert.Equal(1, item.GetProperty("pageCount").GetInt32());
        Assert.Equal(7, item.GetProperty("views").GetInt32());
        Assert.True(item.GetProperty("published").GetBoolean());
        Assert.Equal("https://example.com/t.png", item.GetProperty("thumbnailUrl").GetString());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("role").ValueKind);
        Assert.False(item.GetProperty("locked").GetBoolean());
        Assert.True(item.TryGetProperty("updatedAt", out _));
        Assert.True(item.TryGetProperty("createdAt", out _));
        Assert.False(item.TryGetProperty("doc", out _));
    }

    [Fact]
    public async Task The_author_filter_matches_owners_and_authors_but_not_invited_users()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var shared = await actors.CreateSharedBrewAsync(ct);
        await api.Factory.UpdateAsync(shared.ShareId, s => s.SetProperty(b => b.Title, $"Shared {t}").SetProperty(b => b.Published, true), ct);
        var others = await Create($"Other's {t}", ct, client: actors.Other.Client);

        Assert.Equal([shared.ShareId], ShareIds(await SearchAsync($"q={t}&author={actors.Author.Handle.ToUpperInvariant()}", ct)));
        Assert.Empty(ShareIds(await SearchAsync($"q={t}&author={actors.Invited.Handle}", ct)));
        Assert.Equal([others.ShareId], ShareIds(await SearchAsync($"q={t}&author={actors.Other.Handle}", ct)));
        Assert.Empty(ShareIds(await SearchAsync($"q={t}&author=no-such-user", ct)));
    }

    // ---- paging -------------------------------------------------------------------------------------

    [Fact]
    public async Task Pages_split_the_results_without_overlap()
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var created = new List<string>();
        for (var i = 0; i < 5; i++) created.Add((await Create($"{t} {i}", ct)).ShareId);

        var pages = new List<JsonElement>();
        for (var p = 1; p <= 4; p++) pages.Add(await SearchAsync($"q={t}&sort=title&pageSize=2&page={p}", ct));

        Assert.All(pages, page => Assert.Equal(5, page.GetProperty("total").GetInt32()));
        Assert.All(pages, page => Assert.Equal(2, page.GetProperty("pageSize").GetInt32()));
        Assert.Equal([1, 2, 3, 4], pages.Select(page => page.GetProperty("page").GetInt32()));
        Assert.Equal([2, 2, 1, 0], pages.Select(page => ShareIds(page).Count));
        Assert.Equal(created, pages.SelectMany(ShareIds));                    // titles "{t} 0" .. "{t} 4", in order
    }

    [Theory]
    [InlineData("pageSize=0", 1, 1)]
    [InlineData("pageSize=-3", 1, 1)]
    [InlineData("pageSize=61", 1, 60)]
    [InlineData("pageSize=100000", 1, 60)]
    [InlineData("page=0", 1, 20)]
    [InlineData("page=-2&pageSize=5", 1, 5)]
    [InlineData("page=2147483647", 10_000, 20)]
    [InlineData("", 1, 20)]
    public async Task Page_and_page_size_are_clamped(string query, int page, int pageSize)
    {
        var ct = TestContext.Current.CancellationToken;

        var result = await SearchAsync($"{query}&q={TestBrews.Token()}", ct);

        Assert.Equal(page, result.GetProperty("page").GetInt32());
        Assert.Equal(pageSize, result.GetProperty("pageSize").GetInt32());
    }

    [Fact]
    public async Task Without_q_the_newest_updates_come_first()
    {
        var ct = TestContext.Current.CancellationToken;
        var newest = await Create($"Newest {TestBrews.Token()}", ct);
        await api.Factory.UpdateAsync(newest.ShareId, s => s.SetProperty(b => b.UpdatedAt, DateTimeOffset.UtcNow.AddYears(1)), ct);

        var page = await SearchAsync("pageSize=1", ct);

        Assert.Equal("updated", page.GetProperty("sort").GetString());
        Assert.Equal("desc", page.GetProperty("dir").GetString());
        Assert.Equal([newest.ShareId], ShareIds(page));
        Assert.True(page.GetProperty("total").GetInt32() >= 1);
    }

    // ---- sorting ------------------------------------------------------------------------------------

    [Theory]
    [InlineData("title", null, new[] { "a", "b", "c" })]
    [InlineData("title", "desc", new[] { "c", "b", "a" })]
    [InlineData("views", null, new[] { "b", "c", "a" })]
    [InlineData("views", "asc", new[] { "a", "c", "b" })]
    [InlineData("created", null, new[] { "c", "a", "b" })]
    [InlineData("created", "asc", new[] { "b", "a", "c" })]
    [InlineData("updated", null, new[] { "a", "b", "c" })]
    [InlineData("updated", "asc", new[] { "c", "b", "a" })]
    [InlineData("UPDATED", "DESC", new[] { "a", "b", "c" })]                   // case-insensitive
    public async Task Sorts_order_the_results(string sort, string? dir, string[] expected)
    {
        var ct = TestContext.Current.CancellationToken;
        var t = TestBrews.Token();
        var now = DateTimeOffset.UtcNow;
        //        title  views created     updated
        var brews = new Dictionary<string, (string Title, int Views, int CreatedDays, int UpdatedDays)>
        {
            ["a"] = ("alpha", 1, -2, 3),
            ["b"] = ("bravo", 30, -3, 2),
            ["c"] = ("charlie", 20, -1, 1),
        };
        var ids = new Dictionary<string, string>();
        foreach (var (name, (title, views, createdDays, updatedDays)) in brews)
        {
            var brew = await Create($"{title} {t}", ct);
            ids[brew.ShareId] = name;
            await api.Factory.UpdateAsync(brew.ShareId, s => s
                .SetProperty(b => b.Views, views)
                .SetProperty(b => b.CreatedAt, now.AddDays(createdDays))
                .SetProperty(b => b.UpdatedAt, now.AddDays(updatedDays)), ct);
        }

        var page = await SearchAsync($"q={t}&sort={sort}" + (dir is null ? "" : $"&dir={dir}"), ct);

        Assert.Equal(expected, ShareIds(page).Select(id => ids[id]));
        Assert.Equal(sort.ToLowerInvariant(), page.GetProperty("sort").GetString());
        Assert.Equal(dir?.ToLowerInvariant() ?? (sort == "title" ? "asc" : "desc"), page.GetProperty("dir").GetString());
    }

    [Fact]
    public async Task Relevance_without_q_sorts_by_update_time()
    {
        var ct = TestContext.Current.CancellationToken;

        var page = await SearchAsync("sort=relevance&pageSize=1", ct);

        Assert.Equal("updated", page.GetProperty("sort").GetString());
    }

    [Theory]
    [InlineData("sort=popularity", "sort")]
    [InlineData("sort=createdAt", "sort")]                                    // upstream's field names are not accepted
    [InlineData("sort=title;drop", "sort")]
    [InlineData("dir=up", "dir")]
    [InlineData("sort=views&dir=sideways", "dir")]
    public async Task Unknown_sorts_and_directions_are_400(string query, string field)
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Anonymous.GetAsync($"/api/vault?{query}", ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await TestJson.ReadAsync<JsonElement>(response, ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task An_overlong_query_is_400()
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Anonymous.GetAsync($"/api/vault?q={new string('a', 257)}", ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await TestJson.ReadAsync<JsonElement>(response, ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("q", out _));
    }

    [Fact]
    public async Task A_non_numeric_page_is_400()
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Anonymous.GetAsync("/api/vault?page=two", ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ---- helpers ------------------------------------------------------------------------------------

    private Task<Api.Brews.BrewForEdit> Create(
        string title, CancellationToken ct, string description = "", string body = "Some text.", bool published = true,
        HttpClient? client = null) =>
        TestBrews.CreateAsync(client ?? actors.Owner.Client, ct, title: title, description: description, body: body, published: published);

    private static string Q(string q) => $"q={Uri.EscapeDataString(q)}";

    private async Task<JsonElement> SearchAsync(string query, CancellationToken ct, HttpClient? client = null)
    {
        using var response = await (client ?? actors.Anonymous).GetAsync($"/api/vault?{query}", ct);
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        return await TestJson.ReadAsync<JsonElement>(response, ct);
    }

    private static List<string> ShareIds(JsonElement page) =>
        [.. page.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("shareId").GetString()!)];
}
