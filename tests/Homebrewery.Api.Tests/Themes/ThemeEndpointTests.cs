using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Api.Themes;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Tests.Themes;

/// <summary>
/// P2.5: <c>GET /api/themes</c> and <c>GET /api/themes/{theme}/bundle</c> (plan §8.7): static chains walk baseTheme, user
/// themes walk their theme field, root first; cycles and chains over 8 themes are 422.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ThemeEndpointTests(ApiFixture api, BrewActors actors) : IClassFixture<BrewActors>
{
    private const string Blank = "/themes/V3/Blank/style.scoped.css";
    private const string Phb = "/themes/V3/5ePHB/style.scoped.css";
    private const string Dmg = "/themes/V3/5eDMG/style.scoped.css";

    private static readonly object[] UserSnippets = [new { group = "Theme bits", name = "Box", gen = "{{box}}" }];

    // ---- static themes ---------------------------------------------------------------------------

    [Fact]
    public async Task The_5eDMG_bundle_is_Blank_then_5ePHB_then_5eDMG()
    {
        var ct = TestContext.Current.CancellationToken;

        var bundle = await GetBundleAsync(actors.Anonymous, "5eDMG", ct);

        Assert.Equal("5eDMG", bundle.GetProperty("theme").GetString());
        Assert.Equal("5e DMG", bundle.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, bundle.GetProperty("author").ValueKind);
        Assert.Equal(
            """[{"kind":"url","href":"/themes/V3/Blank/style.scoped.css"},{"kind":"url","href":"/themes/V3/5ePHB/style.scoped.css"},{"kind":"url","href":"/themes/V3/5eDMG/style.scoped.css"}]""",
            bundle.GetProperty("styles").GetRawText());
        Assert.Equal("""["V3_Blank","V3_5ePHB","V3_5eDMG"]""", bundle.GetProperty("snippets").GetRawText());
    }

    [Theory]
    [InlineData("Blank", new[] { "Blank" })]
    [InlineData("5ePHB", new[] { "Blank", "5ePHB" })]
    [InlineData("Journal", new[] { "Blank", "Journal" })]
    [InlineData("UnearthedArcana", new[] { "Blank", "UnearthedArcana" })]
    public async Task Static_bundles_walk_baseTheme(string theme, string[] chain)
    {
        var ct = TestContext.Current.CancellationToken;

        var bundle = await GetBundleAsync(actors.Anonymous, theme, ct);

        Assert.Equal(chain.Select(k => $"/themes/V3/{k}/style.scoped.css"), Hrefs(bundle));
        Assert.Equal(chain.Select(k => $"V3_{k}"), bundle.GetProperty("snippets").EnumerateArray().Select(s => s.GetString()));
    }

    [Theory]
    [InlineData("NoSuchTheme")]
    [InlineData("5edmg")]                                   // static keys are case-sensitive
    [InlineData("zzzzzzzzzzzz")]                            // looks like a share id, no such brew
    [InlineData("bad.id")]                                  // not a theme id at all
    public async Task Unknown_themes_are_404(string theme)
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Anonymous.GetAsync($"/api/themes/{Uri.EscapeDataString(theme)}/bundle", ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.NotFound, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    // ---- user themes -----------------------------------------------------------------------------

    [Fact]
    public async Task A_user_theme_chain_ends_in_its_static_root()
    {
        var ct = TestContext.Current.CancellationToken;
        var parent = await CreateThemeAsync("Parent theme", "5eDMG", ".page { color: red; }", ct, snippets: UserSnippets);
        var child = await CreateThemeAsync("Child theme", parent.ShareId, ".page h1 { color: blue; }", ct);

        var bundle = await GetBundleAsync(actors.Anonymous, child.ShareId, ct);

        Assert.Equal("Child theme", bundle.GetProperty("name").GetString());
        Assert.Equal(actors.Owner.Handle, bundle.GetProperty("author").GetString());
        var styles = JsonNode.Parse(bundle.GetProperty("styles").GetRawText())!.AsArray();
        Assert.Equal(
            JsonNode.Parse($$"""
                [
                  {"kind":"url","href":"{{Blank}}"},
                  {"kind":"url","href":"{{Phb}}"},
                  {"kind":"url","href":"{{Dmg}}"},
                  {"kind":"css","css":".page { color: red; }","shareId":"{{parent.ShareId}}"},
                  {"kind":"css","css":".page h1 { color: blue; }","shareId":"{{child.ShareId}}"}
                ]
                """)!.ToJsonString(),
            styles.ToJsonString());
        var snippets = bundle.GetProperty("snippets");
        Assert.Equal(["V3_Blank", "V3_5ePHB", "V3_5eDMG"], snippets.EnumerateArray().Take(3).Select(s => s.GetString()));
        var userSnippets = snippets[3];                                  // the child has none, so it adds nothing
        Assert.Equal(4, snippets.GetArrayLength());
        Assert.Equal("Parent theme", userSnippets.GetProperty("name").GetString());
        Assert.Equal("{{box}}", userSnippets.GetProperty("snippets")[0].GetProperty("gen").GetString());
    }

    [Fact]
    public async Task User_theme_css_is_returned_raw_for_the_client_to_scope()
    {
        var ct = TestContext.Current.CancellationToken;
        const string css = ":root { --accent: red; }\nbody .page { color: var(--accent); }\n@media print { .page { margin: 0; } }";
        var theme = await CreateThemeAsync("Raw CSS theme", "Blank", css, ct);

        var bundle = await GetBundleAsync(actors.Anonymous, theme.ShareId, ct);

        Assert.Equal(css, bundle.GetProperty("styles")[1].GetProperty("css").GetString());
    }

    [Fact]
    public async Task A_theme_without_css_or_snippets_adds_only_its_parents()
    {
        var ct = TestContext.Current.CancellationToken;
        var theme = await CreateThemeAsync("Empty theme", "5ePHB", "", ct);

        var bundle = await GetBundleAsync(actors.Anonymous, theme.ShareId, ct);

        Assert.Equal([Blank, Phb], Hrefs(bundle));
        Assert.Equal(2, bundle.GetProperty("styles").GetArrayLength());
        Assert.Equal("Empty theme", bundle.GetProperty("name").GetString());
    }

    [Fact]
    public async Task Unpublished_themes_can_be_bundled_by_share_id()
    {
        var ct = TestContext.Current.CancellationToken;
        var theme = await CreateThemeAsync("Private theme", "Blank", ".x{}", ct, published: false);

        var bundle = await GetBundleAsync(actors.Other.Client, theme.ShareId, ct);

        Assert.Equal("Private theme", bundle.GetProperty("name").GetString());
    }

    [Fact]
    public async Task The_upstream_meta_Theme_spelling_counts()
    {
        var ct = TestContext.Current.CancellationToken;
        var theme = await CreateThemeAsync("Capital T", "Blank", ".x{}", ct, tag: "meta:Theme");

        var bundle = await GetBundleAsync(actors.Anonymous, theme.ShareId, ct);

        Assert.Equal("Capital T", bundle.GetProperty("name").GetString());
    }

    [Fact]
    public async Task A_brew_that_is_not_tagged_as_a_theme_is_422()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await TestBrews.CreateAsync(actors.Owner.Client, ct, title: "Just a brew", tags: ["theme"]);

        var problem = await GetProblemAsync(brew.ShareId, HttpStatusCode.UnprocessableEntity, ct);

        Assert.Contains("not tagged meta:theme", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_parent_that_is_not_a_theme_is_422()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await TestBrews.CreateAsync(actors.Owner.Client, ct, title: "Not a theme");
        var theme = await CreateThemeAsync("Child of a brew", "Blank", ".x{}", ct);
        // Saves refuse a parent that is not a theme; stored references can still go stale (the parent gets untagged).
        await api.Factory.UpdateAsync(theme.ShareId, s => s.SetProperty(x => x.Theme, brew.ShareId), ct);

        var problem = await GetProblemAsync(theme.ShareId, HttpStatusCode.UnprocessableEntity, ct);

        Assert.Equal([theme.ShareId, brew.ShareId], Chain(problem));
    }

    [Fact]
    public async Task A_missing_parent_is_422()
    {
        var ct = TestContext.Current.CancellationToken;
        var theme = await CreateThemeAsync("Orphan", "Blank", ".x{}", ct);
        await api.Factory.UpdateAsync(theme.ShareId, s => s.SetProperty(x => x.Theme, "gone00000000"), ct);   // parent deleted

        var problem = await GetProblemAsync(theme.ShareId, HttpStatusCode.UnprocessableEntity, ct);

        Assert.Contains("'gone00000000'", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
        Assert.Equal([theme.ShareId, "gone00000000"], Chain(problem));
    }

    [Fact]
    public async Task User_themes_that_reference_each_other_are_a_cycle_422()
    {
        var ct = TestContext.Current.CancellationToken;
        var a = await CreateThemeAsync("Cycle A", "Blank", ".a{}", ct);
        var b = await CreateThemeAsync("Cycle B", a.ShareId, ".b{}", ct);
        await api.Factory.UpdateAsync(a.ShareId, s => s.SetProperty(x => x.Theme, b.ShareId), ct);   // A -> B -> A

        var fromA = await GetProblemAsync(a.ShareId, HttpStatusCode.UnprocessableEntity, ct);
        var fromB = await GetProblemAsync(b.ShareId, HttpStatusCode.UnprocessableEntity, ct);

        Assert.Equal("Invalid theme chain", fromA.GetProperty("title").GetString());
        Assert.Contains("cycle", fromA.GetProperty("detail").GetString(), StringComparison.Ordinal);
        Assert.Equal([a.ShareId, b.ShareId, a.ShareId], Chain(fromA));
        Assert.Equal([b.ShareId, a.ShareId, b.ShareId], Chain(fromB));
    }

    [Fact]
    public async Task A_theme_that_is_its_own_parent_is_a_cycle_422()
    {
        var ct = TestContext.Current.CancellationToken;
        var theme = await CreateThemeAsync("Ouroboros", "Blank", ".x{}", ct);
        await api.Factory.UpdateAsync(theme.ShareId, s => s.SetProperty(x => x.Theme, theme.ShareId), ct);

        var problem = await GetProblemAsync(theme.ShareId, HttpStatusCode.UnprocessableEntity, ct);

        Assert.Equal([theme.ShareId, theme.ShareId], Chain(problem));
    }

    [Fact]
    public async Task Chains_are_limited_to_eight_themes()
    {
        var ct = TestContext.Current.CancellationToken;
        // Blank <- U1 <- U2 <- ... <- U8: U7's chain has 8 themes, U8's has 9.
        var themes = new List<BrewForEdit>();
        for (var i = 1; i <= 8; i++)
        {
            themes.Add(await CreateThemeAsync($"Level {i}", i == 1 ? "Blank" : themes[^1].ShareId, $".l{i}{{}}", ct));
        }

        var eight = await GetBundleAsync(actors.Anonymous, themes[6].ShareId, ct);
        var nine = await GetProblemAsync(themes[7].ShareId, HttpStatusCode.UnprocessableEntity, ct);

        Assert.Equal(8, eight.GetProperty("styles").GetArrayLength());
        Assert.Equal(Blank, eight.GetProperty("styles")[0].GetProperty("href").GetString());
        Assert.Equal(".l1{}", eight.GetProperty("styles")[1].GetProperty("css").GetString());
        Assert.Contains("longer than 8", nine.GetProperty("detail").GetString(), StringComparison.Ordinal);
        Assert.Equal(9, Chain(nine).Count);
    }

    [Fact]
    public async Task A_locked_theme_in_the_chain_is_423()
    {
        var ct = TestContext.Current.CancellationToken;
        var parent = await CreateThemeAsync("Locked parent", "Blank", ".x{}", ct);
        var child = await CreateThemeAsync("Child of locked", parent.ShareId, ".y{}", ct);
        await api.Factory.LockAsync(parent.ShareId, ct);

        var problem = await GetProblemAsync(child.ShareId, HttpStatusCode.Locked, ct);

        Assert.Equal("This brew is under review.", problem.GetProperty("detail").GetString());
        Assert.Equal(455, problem.GetProperty("code").GetInt32());
    }

    // ---- GET /api/themes ---------------------------------------------------------------------------

    [Fact]
    public async Task The_theme_list_has_the_static_catalog()
    {
        var ct = TestContext.Current.CancellationToken;

        var list = await GetListAsync(actors.Anonymous, ct);

        var statics = list.GetProperty("static");
        Assert.Equal(["5eDMG", "5ePHB", "Blank", "Journal", "UnearthedArcana"], statics.EnumerateArray().Select(t => t.GetProperty("key").GetString()));
        var phb = statics[1];
        Assert.Equal("Blank", phb.GetProperty("baseTheme").GetString());
        Assert.Equal(Phb, phb.GetProperty("scopedStyle").GetString());
        Assert.Equal("/themes/V3/5ePHB/dropdownPreview.png", phb.GetProperty("preview").GetString());
        Assert.True(phb.GetProperty("hasSnippets").GetBoolean());
    }

    [Fact]
    public async Task Published_user_themes_are_listed_for_everyone_and_own_themes_for_their_authors()
    {
        var ct = TestContext.Current.CancellationToken;
        var published = await CreateThemeAsync("Listed theme", "5ePHB", ".x{}", ct);
        var draft = await CreateThemeAsync("Draft theme", "Blank", ".x{}", ct, published: false);
        var lockedTheme = await CreateThemeAsync("Locked theme", "Blank", ".x{}", ct);
        await api.Factory.LockAsync(lockedTheme.ShareId, ct);
        var notATheme = await TestBrews.CreateAsync(actors.Owner.Client, ct, title: "Published brew, no tag");

        var anonymous = UserThemes(await GetListAsync(actors.Anonymous, ct));
        var other = UserThemes(await GetListAsync(actors.Other.Client, ct));
        var owner = UserThemes(await GetListAsync(actors.Owner.Client, ct));

        Assert.Contains(published.ShareId, anonymous.Keys);
        Assert.DoesNotContain(draft.ShareId, anonymous.Keys);
        Assert.DoesNotContain(lockedTheme.ShareId, anonymous.Keys);
        Assert.DoesNotContain(notATheme.ShareId, anonymous.Keys);
        Assert.DoesNotContain(draft.ShareId, other.Keys);
        Assert.False(other[published.ShareId].GetProperty("mine").GetBoolean());

        Assert.Contains(draft.ShareId, owner.Keys);
        Assert.Contains(lockedTheme.ShareId, owner.Keys);
        var mine = owner[published.ShareId];
        Assert.True(mine.GetProperty("mine").GetBoolean());
        Assert.Equal("Listed theme", mine.GetProperty("name").GetString());
        Assert.Equal(actors.Owner.Handle, mine.GetProperty("author").GetString());
        Assert.Equal("5ePHB", mine.GetProperty("baseTheme").GetString());
        Assert.True(mine.GetProperty("published").GetBoolean());
        Assert.False(owner[draft.ShareId].GetProperty("published").GetBoolean());
    }

    [Fact]
    public async Task Co_authors_see_their_unpublished_themes_but_invited_users_do_not()
    {
        var ct = TestContext.Current.CancellationToken;
        var shared = await actors.CreateSharedBrewAsync(ct);
        await api.Factory.UpdateAsync(shared.ShareId, s => s
            .SetProperty(b => b.Tags, new[] { "meta:theme" })
            .SetProperty(b => b.Published, false), ct);

        Assert.Contains(shared.ShareId, UserThemes(await GetListAsync(actors.Author.Client, ct)).Keys);
        Assert.DoesNotContain(shared.ShareId, UserThemes(await GetListAsync(actors.Invited.Client, ct)).Keys);
    }

    [Fact]
    public async Task Own_themes_come_first()
    {
        var ct = TestContext.Current.CancellationToken;
        await CreateThemeAsync("Somebody else's theme", "Blank", ".x{}", ct, client: actors.Other.Client);
        await CreateThemeAsync("My theme", "Blank", ".x{}", ct);

        var list = (await GetListAsync(actors.Owner.Client, ct)).GetProperty("user").EnumerateArray()
            .Select(t => t.GetProperty("mine").GetBoolean()).ToList();

        Assert.Contains(false, list);
        Assert.Equal(list.OrderByDescending(m => m), list);
    }

    // ---- helpers ----------------------------------------------------------------------------------

    private Task<BrewForEdit> CreateThemeAsync(
        string title, string parent, string css, CancellationToken ct,
        bool published = true, string tag = "meta:theme", object? snippets = null, HttpClient? client = null) =>
        TestBrews.CreateAsync(client ?? actors.Owner.Client, ct,
            title: title, tags: [tag], theme: parent, style: css, published: published, snippets: snippets);

    private static async Task<JsonElement> GetBundleAsync(HttpClient client, string theme, CancellationToken ct)
    {
        using var response = await client.GetAsync($"/api/themes/{theme}/bundle", ct);
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        return await TestJson.ReadAsync<JsonElement>(response, ct);
    }

    private async Task<JsonElement> GetProblemAsync(string theme, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await actors.Anonymous.GetAsync($"/api/themes/{theme}/bundle", ct);
        await BrewApi.EnsureStatusAsync(response, status, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        return await TestJson.ReadAsync<JsonElement>(response, ct);
    }

    private static async Task<JsonElement> GetListAsync(HttpClient client, CancellationToken ct)
    {
        using var response = await client.GetAsync("/api/themes", ct);
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        return await TestJson.ReadAsync<JsonElement>(response, ct);
    }

    private static Dictionary<string, JsonElement> UserThemes(JsonElement list) =>
        list.GetProperty("user").EnumerateArray().ToDictionary(t => t.GetProperty("shareId").GetString()!);

    private static List<string?> Hrefs(JsonElement bundle) =>
        [.. bundle.GetProperty("styles").EnumerateArray()
            .Where(s => s.GetProperty("kind").GetString() == "url")
            .Select(s => s.GetProperty("href").GetString())];

    private static List<string?> Chain(JsonElement problem) =>
        [.. problem.GetProperty("chain").EnumerateArray().Select(e => e.GetString())];
}
