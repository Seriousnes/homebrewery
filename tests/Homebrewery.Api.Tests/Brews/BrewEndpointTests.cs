using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>P2.3: create, get for edit, get for share (views, lock), clone and delete.</summary>
[Collection(ApiCollection.Name)]
public sealed class BrewEndpointTests(ApiFixture api, BrewActors actors) : IClassFixture<BrewActors>
{
    // ---- create --------------------------------------------------------------------------------

    [Fact]
    public async Task Create_stores_the_brew_with_the_caller_as_owner()
    {
        var ct = TestContext.Current.CancellationToken;
        var doc = BrewApi.SimpleDoc("Dragon Lairs", "A lair is a place.");

        using var response = await actors.Owner.Client.PostAsJsonAsync("/api/brews", new
        {
            doc,
            style = ".page { background: white; }",
            snippets = new[] { new { group = "Mine", name = "Box", gen = "{{box}}" } },
            sourceMarkdown = "# Dragon Lairs\n\nA lair is a place.",
            docSchemaVersion = 1,
            meta = new
            {
                title = "  Lairs  ", description = "All about lairs", tags = new[] { "type:guide", " type:guide ", "", "dragons" },
                lang = "pt-BR", theme = "5eDMG", published = true, thumbnailUrl = "https://example.com/t.png",
            },
        }, TestJson.Options, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        var brew = await TestJson.ReadAsync<BrewForEdit>(response, ct);
        Assert.Equal($"/api/brews/edit/{brew.EditId}", response.Headers.Location?.OriginalString);
        Assert.Matches("^[A-Za-z0-9_-]{12}$", brew.EditId);
        Assert.Matches("^[A-Za-z0-9_-]{12}$", brew.ShareId);
        Assert.NotEqual(brew.EditId, brew.ShareId);
        Assert.Equal(1, brew.Version);
        Assert.Equal(1, brew.DocSchemaVersion);
        Assert.True(JsonNode.DeepEquals(doc, JsonNode.Parse(brew.Doc.Json)));
        Assert.Equal(".page { background: white; }", brew.Style);
        Assert.Equal("Box", brew.Snippets!.Value.Parse()[0].GetProperty("name").GetString());
        Assert.Equal("# Dragon Lairs\n\nA lair is a place.", brew.SourceMarkdown);
        Assert.Equal(
            ("Lairs", "All about lairs", "pt-BR", "5eDMG", true, "https://example.com/t.png"),
            (brew.Meta.Title, brew.Meta.Description, brew.Meta.Lang, brew.Meta.Theme, brew.Meta.Published, brew.Meta.ThumbnailUrl));
        Assert.Equal(["type:guide", "dragons"], brew.Meta.Tags);
        Assert.Equal([new BrewAuthorInfo(actors.Owner.Handle, AuthorRole.Owner)], brew.Authors);
        Assert.Equal(AuthorRole.Owner, brew.Role);
        Assert.Equal(1, brew.PageCount);
        Assert.Equal(0, brew.Views);
        Assert.Null(brew.Lock);

        var stored = await api.Factory.WithDbAsync(db => db.Brews.AsNoTracking()
            .Where(b => b.EditId == brew.EditId)
            .Select(b => new { b.SearchText, b.Published, Authors = b.Authors.Select(a => new { a.UserId, a.Role, a.Position }).ToList() })
            .SingleAsync(ct));
        Assert.Equal("Dragon Lairs\nA lair is a place.", stored.SearchText);
        Assert.True(stored.Published);
        var owner = Assert.Single(stored.Authors);
        Assert.Equal((actors.Owner.Id, AuthorRole.Owner, (short)0), (owner.UserId, owner.Role, owner.Position));
    }

    [Fact]
    public async Task Create_without_a_document_starts_with_one_empty_page()
    {
        var ct = TestContext.Current.CancellationToken;

        var brew = await BrewApi.CreateAsync(actors.Other.Client, new { }, ct);

        Assert.Equal("""{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]}""", brew.Doc.Json.Replace(" ", ""));
        Assert.Equal("", brew.Meta.Title);
        Assert.Equal("en", brew.Meta.Lang);
        Assert.Equal("5ePHB", brew.Meta.Theme);
        Assert.False(brew.Meta.Published);
    }

    [Fact]
    public async Task A_blank_title_falls_back_to_the_first_heading()
    {
        var ct = TestContext.Current.CancellationToken;

        var brew = await BrewApi.CreateAsync(actors.Other.Client, new { doc = BrewApi.SimpleDoc("The Wandering Inn"), meta = new { title = "  " } }, ct);

        Assert.Equal("The Wandering Inn", brew.Meta.Title);
    }

    [Fact]
    public async Task Create_can_invite_authors_by_handle()
    {
        var ct = TestContext.Current.CancellationToken;

        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new
        {
            meta = new { authors = new[] { actors.Author.Handle.ToUpperInvariant(), actors.Owner.Handle, actors.Author.Handle } },
        }, ct);

        Assert.Equal(
            [new BrewAuthorInfo(actors.Owner.Handle, AuthorRole.Owner), new BrewAuthorInfo(actors.Author.Handle, AuthorRole.Invited)],
            brew.Authors);
    }

    [Fact]
    public async Task Create_rejects_invalid_documents_and_metadata()
    {
        var ct = TestContext.Current.CancellationToken;
        var doc = BrewApi.SimpleDoc("x");
        doc["content"]![0]!["content"]!.AsArray().Add(new JsonObject { ["type"] = "script" });

        using var response = await actors.Owner.Client.PostAsJsonAsync("/api/brews", new
        {
            doc,
            docSchemaVersion = 99,
            snippets = new { not = "an array" },
            meta = new
            {
                title = new string('t', 101), description = new string('d', 501), lang = "english!", theme = "../etc",
                thumbnailUrl = "javascript:alert(1)", tags = new[] { new string('x', 101) }, authors = new[] { "no such user here", "ghost-user-404" },
            },
        }, TestJson.Options, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        var errors = problem.GetProperty("errors").EnumerateObject().Select(p => p.Name).ToHashSet();
        Assert.Superset(new HashSet<string>
        {
            "doc.content[0].content[2].type", "docSchemaVersion", "snippets", "meta.title", "meta.description", "meta.lang",
            "meta.theme", "meta.thumbnailUrl", "meta.tags", "meta.authors",
        }, errors);
    }

    [Fact]
    public async Task Create_reports_unknown_handles()
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Owner.Client.PostAsJsonAsync("/api/brews", new { meta = new { authors = new[] { "ghost-user-404" } } }, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Contains("ghost-user-404", problem.GetProperty("errors").GetProperty("meta.authors")[0].GetString());
    }

    [Fact]
    public async Task A_null_author_is_a_validation_problem()
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Owner.Client.PostAsync("/api/brews",
            new StringContent("""{"meta":{"authors":[null]}}""", System.Text.Encoding.UTF8, "application/json"), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("meta.authors", out _));
    }

    [Fact]
    public async Task Deeply_nested_raw_html_is_a_validation_problem_and_the_server_stays_up()
    {
        var ct = TestContext.Current.CancellationToken;
        var doc = BrewApi.SimpleDoc("Deep");
        doc["content"]![0]!["content"]!.AsArray().Add(new JsonObject
        {
            ["type"] = "rawHtml",
            ["attrs"] = new JsonObject { ["html"] = string.Concat(Enumerable.Repeat("<span>", 30_000)) },
        });

        using var response = await actors.Owner.Client.PostAsJsonAsync("/api/brews", new { doc }, TestJson.Options, ct);
        using var health = await actors.Anonymous.GetAsync("/healthz", ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("doc.content[0].content[2].attrs.html", out _));
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
    }

    [Theory]
    [InlineData("1e131071")]                // 9 bytes that PostgreSQL's jsonb prints as 131,072 digits
    [InlineData("1e131072")]                // beyond PostgreSQL's numeric range
    [InlineData("1e-20000")]
    public async Task Numbers_postgresql_would_blow_up_or_refuse_are_not_stored(string number)
    {
        var ct = TestContext.Current.CancellationToken;
        var json = $$$"""
            {"doc":{"type":"doc","content":[{"type":"page","content":[
              {"type":"heading","attrs":{"level":{{{number}}}},"content":[{"type":"text","text":"Numbers"}]},
              {"type":"table","content":[{"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"colwidth":[{{{number}}},{{{number}}}]},"content":[{"type":"paragraph"}]}]}]}]}]},
             "snippets":[{"n":{{{number}}}}],"meta":{"published":true}}
            """;

        using var response = await actors.Owner.Client.PostAsync("/api/brews", new StringContent(json, System.Text.Encoding.UTF8, "application/json"), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        Assert.True(body.Length < 5_000, $"the response has {body.Length} characters");
        var brew = JsonSerializer.Deserialize<BrewForEdit>(body, TestJson.Options)!;
        using var share = await actors.Anonymous.GetAsync($"/api/brews/share/{brew.ShareId}", ct);
        Assert.True((await share.Content.ReadAsStringAsync(ct)).Length < 5_000);
    }

    [Theory]
    [InlineData("NoSuchTheme")]
    [InlineData("5ephb")]                   // static keys are case-sensitive
    public async Task Create_rejects_themes_that_do_not_exist(string theme)
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await actors.Owner.Client.PostAsJsonAsync("/api/brews", new { meta = new { theme } }, TestJson.Options, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("meta.theme", out _));
    }

    [Fact]
    public async Task Create_accepts_user_themes_but_not_other_brews_as_themes()
    {
        var ct = TestContext.Current.CancellationToken;
        var userTheme = await TestBrews.CreateAsync(actors.Other.Client, ct, title: "A user theme", tags: ["meta:theme"], published: false);
        var notATheme = await TestBrews.CreateAsync(actors.Other.Client, ct, title: "Private brew", published: false);

        var themed = await BrewApi.CreateAsync(actors.Owner.Client, new { meta = new { theme = userTheme.ShareId } }, ct);
        using var refused = await actors.Owner.Client.PostAsJsonAsync("/api/brews", new { meta = new { theme = notATheme.ShareId } }, TestJson.Options, ct);

        Assert.Equal(userTheme.ShareId, themed.Meta.Theme);
        await BrewApi.EnsureStatusAsync(refused, HttpStatusCode.BadRequest, ct);
        var problem = await refused.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("meta.theme", out _));
    }

    [Fact]
    public async Task Create_sanitizes_the_document()
    {
        var ct = TestContext.Current.CancellationToken;
        var doc = JsonNode.Parse("""
            {"type":"doc","content":[{"type":"page","content":[
              {"type":"paragraph","attrs":{"onclick":"alert(1)","align":"center"},"content":[{"type":"text","text":"x"}]},
              {"type":"rawHtml","attrs":{"html":"<b onmouseover=\"alert(1)\">bold</b><script>alert(2)</script>"}}]}]}
            """);

        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new { doc }, ct);

        Assert.DoesNotContain("alert", brew.Doc.Json, StringComparison.Ordinal);
        Assert.Contains("<b>bold</b>", brew.Doc.Json, StringComparison.Ordinal);
        Assert.Contains("\"align\": \"center\"", brew.Doc.Json, StringComparison.Ordinal);
    }

    // ---- get for edit -------------------------------------------------------------------------

    [Fact]
    public async Task Get_for_edit_lists_authors_with_handles_roles_and_the_callers_role()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var asInvited = await BrewApi.GetForEditAsync(actors.Invited.Client, brew.EditId, ct);

        Assert.Equal(
            [
                new BrewAuthorInfo(actors.Owner.Handle, AuthorRole.Owner),
                new BrewAuthorInfo(actors.Author.Handle, AuthorRole.Author),
                new BrewAuthorInfo(actors.Invited.Handle, AuthorRole.Invited),
            ],
            asInvited.Authors);
        Assert.Equal(AuthorRole.Invited, asInvited.Role);
        Assert.Equal(brew.Version, asInvited.Version);
        Assert.Equal("Shared", asInvited.Meta.Title);
    }

    [Fact]
    public async Task Role_names_are_camel_case_strings_in_json()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var json = await actors.Owner.Client.GetFromJsonAsync<JsonElement>($"/api/brews/edit/{brew.EditId}", ct);

        Assert.Equal("owner", json.GetProperty("role").GetString());
        Assert.Equal(["owner", "author", "invited"], json.GetProperty("authors").EnumerateArray().Select(a => a.GetProperty("role").GetString()));
        Assert.Equal(JsonValueKind.Object, json.GetProperty("doc").ValueKind);                 // raw JSON, not a string
    }

    [Fact]
    public async Task Get_for_edit_shows_the_lock_edit_message()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        await LockAsync(brew.EditId, ct);

        var locked = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);

        Assert.NotNull(locked.Lock);
        Assert.Equal(455, locked.Lock.Code);
        Assert.Equal("Please fix the art credits.", locked.Lock.Message);
    }

    // ---- share, views and locks --------------------------------------------------------------

    [Fact]
    public async Task Share_is_public_and_hides_edit_ids_and_invited_users_from_readers()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var asReader = await actors.Anonymous.GetFromJsonAsync<BrewForShare>($"/api/brews/share/{brew.ShareId}", TestJson.Options, ct);
        var asAuthor = await actors.Author.Client.GetFromJsonAsync<BrewForShare>($"/api/brews/share/{brew.ShareId}", TestJson.Options, ct);

        Assert.NotNull(asReader);
        Assert.Null(asReader.EditId);
        Assert.Equal([actors.Owner.Handle, actors.Author.Handle], asReader.Authors);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(brew.Doc.Json), JsonNode.Parse(asReader.Doc.Json)));
        Assert.Equal("Shared", asReader.Meta.Title);
        Assert.Equal(brew.EditId, asAuthor?.EditId);
    }

    [Fact]
    public async Task Views_count_readers_but_not_authors()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var url = $"/api/brews/share/{brew.ShareId}";

        foreach (var author in new[] { actors.Owner, actors.Author, actors.Invited })
        {
            (await author.Client.GetAsync(url, ct)).Dispose();
        }

        var afterAuthors = await StoredViewsAsync(brew.ShareId, ct);
        var before = Stamps.Now();
        var first = await actors.Anonymous.GetFromJsonAsync<BrewForShare>(url, TestJson.Options, ct);
        var second = await actors.Other.Client.GetFromJsonAsync<BrewForShare>(url, TestJson.Options, ct);
        var after = Stamps.Now();
        var afterReaders = await StoredViewsAsync(brew.ShareId, ct);

        Assert.Equal((0, null), afterAuthors);
        Assert.Equal(1, first?.Views);
        Assert.Equal(2, second?.Views);
        Assert.Equal(2, afterReaders.Views);
        Stamps.Between(afterReaders.LastViewedAt, before, after);
    }

    [Fact]
    public async Task Views_increment_atomically_under_concurrency()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        const int readers = 40;

        var responses = await Task.WhenAll(Enumerable.Range(0, readers)
            .Select(_ => actors.Anonymous.GetAsync($"/api/brews/share/{brew.ShareId}", ct)));
        foreach (var response in responses) response.Dispose();

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        Assert.Equal(readers, (await StoredViewsAsync(brew.ShareId, ct)).Views);
    }

    [Fact]
    public async Task Views_do_not_change_the_version()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        (await actors.Anonymous.GetAsync($"/api/brews/share/{brew.ShareId}", ct)).Dispose();
        using var save = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version), ct);

        await BrewApi.EnsureStatusAsync(save, HttpStatusCode.OK, ct);
    }

    [Theory]
    [InlineData(Actor.Anonymous)]
    [InlineData(Actor.Other)]
    [InlineData(Actor.Owner)]
    public async Task A_lock_blocks_the_share_view_with_its_share_message(Actor actor)
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        await LockAsync(brew.EditId, ct);

        using var response = await actors.ClientFor(actor).GetAsync($"/api/brews/share/{brew.ShareId}", ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Locked, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("This brew is under review.", problem.GetProperty("detail").GetString());
        Assert.Equal(455, problem.GetProperty("code").GetInt32());
        Assert.Equal(0, (await StoredViewsAsync(brew.ShareId, ct)).Views);
    }

    [Fact]
    public async Task A_lock_blocks_cloning()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        await LockAsync(brew.EditId, ct);

        using var response = await actors.Other.Client.PostAsync($"/api/brews/{brew.ShareId}/clone", null, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Locked, ct);
    }

    // ---- clone ----------------------------------------------------------------------------------

    [Fact]
    public async Task Clone_copies_content_into_a_new_private_brew_owned_by_the_caller()
    {
        var ct = TestContext.Current.CancellationToken;
        var source = await BrewApi.CreateAsync(actors.Owner.Client, new
        {
            doc = BrewApi.SimpleDoc("Original"),
            style = ".x{}",
            snippets = new[] { new { name = "s" } },
            meta = new { title = "Original", description = "d", tags = new[] { "t" }, lang = "de", theme = "Blank", published = true },
        }, ct);
        (await actors.Anonymous.GetAsync($"/api/brews/share/{source.ShareId}", ct)).Dispose();       // one view

        using var response = await actors.Other.Client.PostAsync($"/api/brews/{source.ShareId}/clone", null, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        var copy = await TestJson.ReadAsync<BrewForEdit>(response, ct);
        Assert.NotEqual(source.EditId, copy.EditId);
        Assert.NotEqual(source.ShareId, copy.ShareId);
        Assert.Equal("Copy of Original", copy.Meta.Title);
        Assert.False(copy.Meta.Published);
        Assert.Equal(("d", "de", "Blank"), (copy.Meta.Description, copy.Meta.Lang, copy.Meta.Theme));
        Assert.Equal(["t"], copy.Meta.Tags);
        Assert.Equal(source.Doc.Json, copy.Doc.Json);
        Assert.Equal(".x{}", copy.Style);
        Assert.Equal(source.Snippets?.Json, copy.Snippets?.Json);
        Assert.Equal([new BrewAuthorInfo(actors.Other.Handle, AuthorRole.Owner)], copy.Authors);
        Assert.Equal((1, 0), (copy.Version, copy.Views));
        Assert.Equal("Original", (await BrewApi.GetForEditAsync(actors.Owner.Client, source.EditId, ct)).Meta.Title);
    }

    [Fact]
    public async Task Clone_titles_stay_within_the_limit()
    {
        var ct = TestContext.Current.CancellationToken;
        var source = await BrewApi.CreateAsync(actors.Owner.Client, new { meta = new { title = new string('T', BrewRules.MaxTitle) } }, ct);

        using var response = await actors.Owner.Client.PostAsync($"/api/brews/{source.ShareId}/clone", null, ct);

        var copy = await TestJson.ReadAsync<BrewForEdit>(response, ct);
        Assert.Equal(BrewRules.MaxTitle, copy.Meta.Title.Length);
        Assert.StartsWith("Copy of TTT", copy.Meta.Title);
    }

    [Fact]
    public async Task Clone_titles_are_not_cut_inside_a_surrogate_pair()
    {
        var ct = TestContext.Current.CancellationToken;
        // "Copy of " + 91 × 'a' is 99 characters, so the cut at 100 falls between the emoji's two halves.
        var title = new string('a', 91) + "\U0001F600" + new string('b', 7);
        var source = await BrewApi.CreateAsync(actors.Owner.Client, new { meta = new { title } }, ct);

        using var response = await actors.Other.Client.PostAsync($"/api/brews/{source.ShareId}/clone", null, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        var copy = await TestJson.ReadAsync<BrewForEdit>(response, ct);
        Assert.True(copy.Meta.Title.Length <= BrewRules.MaxTitle);
        Assert.Equal("Copy of " + new string('a', 91), copy.Meta.Title);
    }

    // ---- delete ---------------------------------------------------------------------------------

    [Fact]
    public async Task An_author_leaving_keeps_the_brew_for_the_others()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var result = await DeleteAsync(actors.Author.Client, brew.EditId, ct);
        using var afterwards = await actors.Author.Client.GetAsync($"/api/brews/edit/{brew.EditId}", ct);
        var remaining = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);

        Assert.False(result.BrewDeleted);
        Assert.Equal(HttpStatusCode.Forbidden, afterwards.StatusCode);
        Assert.Equal([actors.Owner.Handle, actors.Invited.Handle], remaining.Authors.Select(a => a.Handle));
    }

    [Fact]
    public async Task When_the_owner_leaves_the_next_author_becomes_owner()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var result = await DeleteAsync(actors.Owner.Client, brew.EditId, ct);
        var remaining = await BrewApi.GetForEditAsync(actors.Author.Client, brew.EditId, ct);

        Assert.False(result.BrewDeleted);
        Assert.Equal(
            [new BrewAuthorInfo(actors.Author.Handle, AuthorRole.Owner), new BrewAuthorInfo(actors.Invited.Handle, AuthorRole.Invited)],
            remaining.Authors);
    }

    [Fact]
    public async Task The_new_owner_moves_to_the_front_of_the_author_list()
    {
        var ct = TestContext.Current.CancellationToken;
        // owner (0), invited (1), author (2): the new owner sits behind an invited user.
        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new
        {
            doc = BrewApi.SimpleDoc("Order"),
            meta = new { authors = new[] { actors.Invited.Handle, actors.Author.Handle } },
        }, ct);
        using (var accept = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId, BrewApi.SaveBody(brew.Version), ct))
        {
            await BrewApi.EnsureStatusAsync(accept, HttpStatusCode.OK, ct);
        }

        await DeleteAsync(actors.Owner.Client, brew.EditId, ct);
        var remaining = await BrewApi.GetForEditAsync(actors.Author.Client, brew.EditId, ct);

        Assert.Equal(
            [new BrewAuthorInfo(actors.Author.Handle, AuthorRole.Owner), new BrewAuthorInfo(actors.Invited.Handle, AuthorRole.Invited)],
            remaining.Authors);
        Assert.Equal([0, 1], await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == brew.EditId)
            .SelectMany(b => b.Authors).OrderBy(a => a.Position).Select(a => (int)a.Position).ToListAsync(ct)));
    }

    [Fact]
    public async Task The_last_author_leaving_deletes_the_brew()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new { }, ct);
        var brewId = await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == brew.EditId).Select(b => b.Id).SingleAsync(ct));

        var result = await DeleteAsync(actors.Owner.Client, brew.EditId, ct);
        using var edit = await actors.Owner.Client.GetAsync($"/api/brews/edit/{brew.EditId}", ct);
        using var share = await actors.Anonymous.GetAsync($"/api/brews/share/{brew.ShareId}", ct);

        Assert.True(result.BrewDeleted);
        Assert.Equal(HttpStatusCode.NotFound, edit.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, share.StatusCode);
        Assert.Equal(0, await api.Factory.WithDbAsync(db => db.BrewAuthors.CountAsync(a => a.BrewId == brewId, ct)));
    }

    [Fact]
    public async Task Invited_users_alone_do_not_keep_a_brew_alive()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new { meta = new { authors = new[] { actors.Invited.Handle } } }, ct);

        var result = await DeleteAsync(actors.Owner.Client, brew.EditId, ct);
        using var edit = await actors.Invited.Client.GetAsync($"/api/brews/edit/{brew.EditId}", ct);

        Assert.True(result.BrewDeleted);
        Assert.Equal(HttpStatusCode.NotFound, edit.StatusCode);
    }

    [Fact]
    public async Task Invited_users_can_decline()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var result = await DeleteAsync(actors.Invited.Client, brew.EditId, ct);
        var remaining = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);

        Assert.False(result.BrewDeleted);
        Assert.Equal([actors.Owner.Handle, actors.Author.Handle], remaining.Authors.Select(a => a.Handle));
    }

    [Fact]
    public async Task The_last_two_authors_leaving_at_once_delete_the_brew()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        var results = await Task.WhenAll(
            DeleteAsync(actors.Owner.Client, brew.EditId, ct),
            DeleteAsync(actors.Author.Client, brew.EditId, ct));

        Assert.Single(results, r => r.BrewDeleted);
        Assert.False(await api.Factory.WithDbAsync(db => db.Brews.AnyAsync(b => b.EditId == brew.EditId, ct)));
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private static async Task<DeleteBrewResponse> DeleteAsync(HttpClient client, string editId, CancellationToken ct)
    {
        using var response = await client.DeleteAsync($"/api/brews/{editId}", ct);
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        return await TestJson.ReadAsync<DeleteBrewResponse>(response, ct);
    }

    private Task<(int Views, DateTimeOffset? LastViewedAt)> StoredViewsAsync(string shareId, CancellationToken ct) =>
        api.Factory.WithDbAsync(async db =>
        {
            var row = await db.Brews.AsNoTracking().Where(b => b.ShareId == shareId)
                .Select(b => new { b.Views, b.LastViewedAt }).SingleAsync(ct);
            return (row.Views, row.LastViewedAt);
        });

    private Task LockAsync(string editId, CancellationToken ct) => api.Factory.WithDbAsync(async db =>
    {
        var brew = await db.Brews.SingleAsync(b => b.EditId == editId, ct);
        brew.Lock = new BrewLock
        {
            Code = 455,
            EditMessage = "Please fix the art credits.",
            ShareMessage = "This brew is under review.",
            Applied = DateTimeOffset.UtcNow,
        };
        return await db.SaveChangesAsync(ct);
    });
}
