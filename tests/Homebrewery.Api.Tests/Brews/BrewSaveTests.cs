using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>P2.3/P2.4: the save protocol (plan §8.4): versions and conflicts, the field whitelist, authors, gzip.</summary>
[Collection(ApiCollection.Name)]
public sealed class BrewSaveTests(ApiFixture api, BrewActors actors) : IClassFixture<BrewActors>
{
    // ---- versions --------------------------------------------------------------------------------

    [Fact]
    public async Task A_save_stores_the_document_and_increments_the_version()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var doc = BrewApi.SimpleDoc("Chapter One", "It was a dark and stormy night.");
        ((JsonArray)doc["content"]!).Add(JsonNode.Parse("""{"type":"page","content":[{"type":"paragraph","content":[{"type":"text","text":"Page two."}]}]}"""));

        using var response = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId, new
        {
            baseVersion = brew.Version,
            doc,
            style = ".page{}",
            snippets = new[] { new { name = "a" } },
            meta = new { title = "", description = "New description", published = true },
        }, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        var saved = await TestJson.ReadAsync<SaveBrewResponse>(response, ct);
        Assert.Equal(brew.Version + 1, saved.Version);
        Assert.Equal("Chapter One", saved.Title);                                   // blank title -> first heading
        Assert.Equal(2, saved.PageCount);

        var reloaded = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);
        Assert.Equal(saved.Version, reloaded.Version);
        Assert.Equal(saved.UpdatedAt, reloaded.UpdatedAt);
        Assert.True(JsonNode.DeepEquals(doc, JsonNode.Parse(reloaded.Doc.Json)));
        Assert.Equal(".page{}", reloaded.Style);
        Assert.Equal("""[{"name": "a"}]""", reloaded.Snippets?.Json);
        Assert.Equal(("Chapter One", "New description", true), (reloaded.Meta.Title, reloaded.Meta.Description, reloaded.Meta.Published));
        Assert.Equal(2, reloaded.PageCount);
        var searchText = await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == brew.EditId).Select(b => b.SearchText).SingleAsync(ct));
        Assert.Equal("Chapter One\nIt was a dark and stormy night.\nPage two.", searchText);
    }

    [Fact]
    public async Task Metadata_left_out_of_a_save_is_kept()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new
        {
            meta = new { title = "Keep me", description = "desc", tags = new[] { "a" }, lang = "fr", theme = "Journal", thumbnailUrl = "https://example.com/x.png" },
        }, ct);

        using var response = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        var reloaded = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);
        Assert.Equal(("Keep me", "desc", "fr", "Journal", "https://example.com/x.png"),
            (reloaded.Meta.Title, reloaded.Meta.Description, reloaded.Meta.Lang, reloaded.Meta.Theme, reloaded.Meta.ThumbnailUrl));
        Assert.Equal(["a"], reloaded.Meta.Tags);
    }

    [Fact]
    public async Task A_stale_base_version_is_a_409_with_the_server_version()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        using var first = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version), ct);
        await BrewApi.EnsureStatusAsync(first, HttpStatusCode.OK, ct);

        using var stale = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId, BrewApi.SaveBody(brew.Version, BrewApi.SimpleDoc("Lost")), ct);

        await BrewApi.EnsureStatusAsync(stale, HttpStatusCode.Conflict, ct);
        var conflict = await TestJson.ReadAsync<SaveConflict>(stale, ct);
        Assert.Equal(brew.Version + 1, conflict.ServerVersion);
        var reloaded = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);
        Assert.DoesNotContain("Lost", reloaded.Doc.Json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Two_saves_from_the_same_version_racing_in_the_database_give_one_200_and_one_409()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var brewId = await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == brew.EditId).Select(b => b.Id).SingleAsync(ct));

        // Hold the row lock so both saves pass the version pre-check and then queue on the UPDATE; releasing the lock
        // lets them race exactly where the concurrency check matters.
        await using var connection = new NpgsqlConnection(api.ConnectionString);
        await connection.OpenAsync(ct);
        await using var holder = await connection.BeginTransactionAsync(ct);
        await using (var lockRow = new NpgsqlCommand("SELECT 1 FROM brews WHERE id = @id FOR UPDATE", connection, holder))
        {
            lockRow.Parameters.AddWithValue("id", brewId);
            await lockRow.ExecuteNonQueryAsync(ct);
        }

        var ownerSave = BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, BrewApi.SimpleDoc("Owner wins?")), ct);
        var authorSave = BrewApi.SaveAsync(actors.Author.Client, brew.EditId, BrewApi.SaveBody(brew.Version, BrewApi.SimpleDoc("Author wins?")), ct);
        await WaitForLockWaitersAsync(api.ConnectionString, expected: 2, ct);
        await holder.RollbackAsync(ct);

        using var a = await ownerSave;
        using var b = await authorSave;
        var statuses = new[] { a.StatusCode, b.StatusCode }.Order().ToArray();

        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], statuses);
        var loser = a.StatusCode == HttpStatusCode.Conflict ? a : b;
        Assert.Equal(brew.Version + 1, (await TestJson.ReadAsync<SaveConflict>(loser, ct)).ServerVersion);
        var stored = await api.Factory.WithDbAsync(db => db.Brews.Where(x => x.Id == brewId).Select(x => x.Version).SingleAsync(ct));
        Assert.Equal(brew.Version + 1, stored);
    }

    [Fact]
    public async Task A_burst_of_saves_from_one_version_lets_exactly_one_through()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        const int saves = 8;

        var responses = await Task.WhenAll(Enumerable.Range(0, saves).Select(i =>
            BrewApi.SaveAsync(i % 2 == 0 ? actors.Owner.Client : actors.Author.Client, brew.EditId,
                BrewApi.SaveBody(brew.Version, BrewApi.SimpleDoc($"Save {i}")), ct)));
        var statuses = responses.Select(r => r.StatusCode).ToList();
        foreach (var response in responses) response.Dispose();

        Assert.Equal(1, statuses.Count(s => s == HttpStatusCode.OK));
        Assert.Equal(saves - 1, statuses.Count(s => s == HttpStatusCode.Conflict));
    }

    [Fact]
    public async Task An_author_list_change_racing_with_someone_leaving_is_a_conflict()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var brewId = await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == brew.EditId).Select(b => b.Id).SingleAsync(ct));
        await using var connection = new NpgsqlConnection(api.ConnectionString);
        await connection.OpenAsync(ct);
        await using var holder = await connection.BeginTransactionAsync(ct);
        await using (var lockRow = new NpgsqlCommand("SELECT 1 FROM brews WHERE id = @id FOR UPDATE", connection, holder))
        {
            lockRow.Parameters.AddWithValue("id", brewId);
            await lockRow.ExecuteNonQueryAsync(ct);
        }

        // The owner's save has read the author list and waits on the row; meanwhile the author leaves.
        var meta = new JsonObject { ["authors"] = new JsonArray(actors.Author.Handle, actors.Other.Handle) };
        var save = BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, meta: meta), ct);
        await WaitForLockWaitersAsync(api.ConnectionString, expected: 1, ct);
        await using (var leave = new NpgsqlCommand("DELETE FROM brew_authors WHERE brew_id = @id AND user_id = @user", connection, holder))
        {
            leave.Parameters.AddWithValue("id", brewId);
            leave.Parameters.AddWithValue("user", actors.Author.Id);
            await leave.ExecuteNonQueryAsync(ct);
        }

        await holder.CommitAsync(ct);
        using var response = await save;

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Conflict, ct);
        var reloaded = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);
        Assert.Equal(brew.Version, reloaded.Version);
        Assert.Equal([actors.Owner.Handle, actors.Invited.Handle], reloaded.Authors.Select(a => a.Handle));
    }

    // ---- whitelist -------------------------------------------------------------------------------

    [Fact]
    public async Task Fields_outside_the_whitelist_are_ignored()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var before = await StoredAsync(brew.EditId, ct);
        var body = BrewApi.SaveBody(brew.Version);
        body["authors"] = new JsonArray(actors.Other.Handle);
        body["lock"] = JsonNode.Parse("""{"code":1,"editMessage":"x","shareMessage":"y"}""");
        body["views"] = 999;
        body["version"] = 50;
        body["createdAt"] = "2000-01-01T00:00:00Z";
        body["editId"] = "hijacked0001";
        body["shareId"] = "hijacked0002";
        body["meta"] = new JsonObject { ["published"] = true, ["views"] = 5, ["lock"] = "x", ["owner"] = actors.Other.Handle };

        using var response = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId, body, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        var after = await StoredAsync(brew.EditId, ct);
        Assert.Equal(before.CreatedAt, after.CreatedAt);
        Assert.Equal((before.ShareId, before.Views, before.Lock), (after.ShareId, after.Views, after.Lock));
        Assert.Equal(brew.Version + 1, after.Version);
        Assert.True(after.Published);                                                     // meta.published is allowed for authors
        Assert.Equal(before.Authors, after.Authors);
    }

    [Fact]
    public async Task Invalid_documents_are_rejected_with_their_paths()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var doc = JsonNode.Parse("""
            {"type":"doc","content":[{"type":"page","content":[
              {"type":"paragraph","attrs":{"attributes":{"onclick":"alert(1)"}},"content":[
                {"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}]}
            """);

        using var response = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, doc), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        var keys = problem.GetProperty("errors").EnumerateObject().Select(p => p.Name).ToList();
        Assert.Contains("doc.content[0].content[0].attrs.attributes.onclick", keys);
        Assert.Contains("doc.content[0].content[0].content[0].marks[0].attrs.href", keys);
        Assert.Equal(brew.Version, (await StoredAsync(brew.EditId, ct)).Version);
    }

    [Theory]
    [InlineData("""{"baseVersion":1}""", "doc")]
    [InlineData("""{"baseVersion":1,"doc":null}""", "doc")]
    [InlineData("""{"baseVersion":1,"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]},"docSchemaVersion":2}""", "docSchemaVersion")]
    [InlineData("""{"baseVersion":1,"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]},"snippets":"x"}""", "snippets")]
    [InlineData("""{"baseVersion":1,"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]},"meta":{"authors":[null]}}""", "meta.authors")]
    [InlineData("""{"baseVersion":1,"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]},"meta":{"theme":"NoSuchTheme"}}""", "meta.theme")]
    public async Task Bad_save_bodies_are_validation_problems(string json, string errorKey)
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new { }, ct);

        using var response = await actors.Owner.Client.PutAsync($"/api/brews/{brew.EditId}",
            new StringContent(json, Encoding.UTF8, "application/json"), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty(errorKey, out _), $"errors has no '{errorKey}'");
    }

    [Fact]
    public async Task A_stored_theme_that_no_longer_exists_does_not_block_saves()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        await api.Factory.UpdateAsync(brew.ShareId, s => s.SetProperty(b => b.Theme, "DeletedTheme"), ct);

        using var keep = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId, BrewApi.SaveBody(brew.Version), ct);
        using var resend = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId,
            BrewApi.SaveBody(brew.Version + 1, meta: new JsonObject { ["theme"] = "DeletedTheme" }), ct);
        using var change = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId,
            BrewApi.SaveBody(brew.Version + 2, meta: new JsonObject { ["theme"] = "AlsoMissing" }), ct);

        await BrewApi.EnsureStatusAsync(keep, HttpStatusCode.OK, ct);
        await BrewApi.EnsureStatusAsync(resend, HttpStatusCode.OK, ct);
        await BrewApi.EnsureStatusAsync(change, HttpStatusCode.BadRequest, ct);
        Assert.Equal("DeletedTheme", (await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Meta.Theme);
    }

    [Fact]
    public async Task A_missing_base_version_is_a_400()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await BrewApi.CreateAsync(actors.Owner.Client, new { }, ct);

        using var response = await actors.Owner.Client.PutAsync($"/api/brews/{brew.EditId}",
            new StringContent("""{"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]}}""", Encoding.UTF8, "application/json"), ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ---- authors -------------------------------------------------------------------------------

    [Fact]
    public async Task An_invited_author_becomes_an_author_on_first_save()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);

        using var response = await BrewApi.SaveAsync(actors.Invited.Client, brew.EditId, BrewApi.SaveBody(brew.Version), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        var saved = await TestJson.ReadAsync<SaveBrewResponse>(response, ct);
        Assert.Contains(new BrewAuthorInfo(actors.Invited.Handle, AuthorRole.Author), saved.Authors);
        var reloaded = await BrewApi.GetForEditAsync(actors.Invited.Client, brew.EditId, ct);
        Assert.Equal(AuthorRole.Author, reloaded.Role);
    }

    [Fact]
    public async Task The_owner_adds_removes_and_reorders_authors_by_handle()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);                      // owner, author, invited
        var meta = new JsonObject { ["authors"] = new JsonArray(actors.Other.Handle.ToUpperInvariant(), actors.Author.Handle) };

        using var response = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, meta: meta), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        List<BrewAuthorInfo> expected =
        [
            new(actors.Owner.Handle, AuthorRole.Owner),
            new(actors.Other.Handle, AuthorRole.Invited),                          // new -> invited
            new(actors.Author.Handle, AuthorRole.Author),                          // existing keeps its role
        ];
        Assert.Equal(expected, (await TestJson.ReadAsync<SaveBrewResponse>(response, ct)).Authors);
        Assert.Equal(expected, (await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Authors);
        using var removed = await actors.Invited.Client.GetAsync($"/api/brews/edit/{brew.EditId}", ct);
        Assert.Equal(HttpStatusCode.Forbidden, removed.StatusCode);
    }

    [Fact]
    public async Task The_owner_cannot_be_removed_from_the_list()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var meta = new JsonObject { ["authors"] = new JsonArray(actors.Author.Handle) };

        using var response = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, meta: meta), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        Assert.Equal(
            [new BrewAuthorInfo(actors.Owner.Handle, AuthorRole.Owner), new BrewAuthorInfo(actors.Author.Handle, AuthorRole.Author)],
            (await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Authors);
    }

    [Theory]
    [InlineData(Actor.Author)]
    [InlineData(Actor.Invited)]
    public async Task Only_the_owner_changes_authors(Actor actor)
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var meta = new JsonObject
        {
            ["authors"] = new JsonArray(actors.Owner.Handle, actors.Author.Handle, actors.Invited.Handle, actors.Other.Handle),
        };

        using var response = await BrewApi.SaveAsync(actors.ClientFor(actor), brew.EditId, BrewApi.SaveBody(brew.Version, meta: meta), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Forbidden, ct);
        var reloaded = await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct);
        Assert.Equal(brew.Version, reloaded.Version);
        Assert.Equal(3, reloaded.Authors.Count);
    }

    [Fact]
    public async Task Authors_may_send_the_unchanged_list()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var meta = new JsonObject
        {
            ["authors"] = new JsonArray([.. brew.Authors.Select(a => (JsonNode)a.Handle).Reverse()]),
        };

        using var response = await BrewApi.SaveAsync(actors.Author.Client, brew.EditId, BrewApi.SaveBody(brew.Version, meta: meta), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        Assert.Equal(brew.Authors, (await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Authors);
    }

    [Fact]
    public async Task Unknown_or_invalid_handles_are_validation_errors()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var meta = new JsonObject { ["authors"] = new JsonArray(actors.Author.Handle, "ghost-user-404") };
        var invalid = new JsonObject { ["authors"] = new JsonArray("a b") };

        using var unknown = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, meta: meta), ct);
        using var malformed = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, meta: invalid), ct);

        await BrewApi.EnsureStatusAsync(unknown, HttpStatusCode.BadRequest, ct);
        await BrewApi.EnsureStatusAsync(malformed, HttpStatusCode.BadRequest, ct);
        Assert.Equal(brew.Authors, (await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Authors);
    }

    // ---- gzip and size limits --------------------------------------------------------------------

    [Fact]
    public async Task Gzip_request_bodies_are_accepted()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var body = BrewApi.SaveBody(brew.Version, BrewApi.SimpleDoc("Compressed", new string('z', 50_000)));

        using var save = await actors.Owner.Client.PutAsync($"/api/brews/{brew.EditId}", BrewApi.Gzip(body.ToJsonString()), ct);
        using var create = await actors.Owner.Client.PostAsync("/api/brews",
            BrewApi.Gzip(new JsonObject { ["doc"] = BrewApi.SimpleDoc("Gzip create") }.ToJsonString()), ct);

        await BrewApi.EnsureStatusAsync(save, HttpStatusCode.OK, ct);
        await BrewApi.EnsureStatusAsync(create, HttpStatusCode.Created, ct);
        Assert.Contains("Compressed", (await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Doc.Json, StringComparison.Ordinal);
        Assert.Contains("Gzip create", (await TestJson.ReadAsync<BrewForEdit>(create, ct)).Doc.Json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Gzip_bodies_that_inflate_past_20_MB_are_rejected()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var padding = new string(' ', (int)BrewRules.MaxRequestBytes);                       // compresses to ~20 KB
        var json = $$$"""{"baseVersion":{{{brew.Version}}},{{{padding}}}"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]}}""";

        using var response = await actors.Owner.Client.PutAsync($"/api/brews/{brew.EditId}", BrewApi.Gzip(json), ct);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal(brew.Version, (await StoredAsync(brew.EditId, ct)).Version);
    }

    [Fact]
    public async Task Documents_over_10_MB_are_rejected()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var doc = BrewApi.SimpleDoc("Huge", new string('x', 11 * 1024 * 1024));

        using var response = await actors.Owner.Client.PutAsync($"/api/brews/{brew.EditId}",
            BrewApi.Gzip(BrewApi.SaveBody(brew.Version, doc).ToJsonString()), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Contains("10 MB", problem.GetProperty("errors").GetProperty("doc")[0].GetString());
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private sealed record Stored(
        int Version, string ShareId, int Views, bool Published, DateTimeOffset CreatedAt, string? Lock, string Authors);

    private Task<Stored> StoredAsync(string editId, CancellationToken ct) => api.Factory.WithDbAsync(async db =>
    {
        var row = await db.Brews.AsNoTracking().Where(b => b.EditId == editId)
            .Select(b => new
            {
                b.Version, b.ShareId, b.Views, b.Published, b.CreatedAt, b.Lock,
                Authors = b.Authors.OrderBy(a => a.Position).Select(a => new { a.UserId, a.Role }).ToList(),
            })
            .SingleAsync(ct);
        return new Stored(row.Version, row.ShareId, row.Views, row.Published, row.CreatedAt,
            row.Lock is null ? null : JsonSerializer.Serialize(row.Lock),
            string.Join(",", row.Authors.Select(a => $"{a.UserId}:{a.Role}")));
    });

    /// <summary>
    /// Waits until <paramref name="expected"/> backends wait on a lock (the queued saves). Polls on its own
    /// connection: inside a transaction pg_stat_activity is a snapshot taken at first access.
    /// </summary>
    private static async Task WaitForLockWaitersAsync(string connectionString, int expected, CancellationToken ct)
    {
        await using var monitor = new NpgsqlConnection(connectionString);
        await monitor.OpenAsync(ct);
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            await using var command = new NpgsqlCommand(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
                monitor);
            var waiting = Convert.ToInt32(await command.ExecuteScalarAsync(ct), System.Globalization.CultureInfo.InvariantCulture);
            if (waiting >= expected) return;
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Only {waiting} of {expected} saves reached the row lock.");
            await Task.Delay(25, ct);
        }
    }
}
