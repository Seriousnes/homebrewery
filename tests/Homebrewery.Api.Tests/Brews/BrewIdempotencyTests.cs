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

/// <summary>
/// SAVE-8: <c>POST /api/brews</c> with an <c>Idempotency-Key</c>. A retry after a lost response (the same key and
/// request) creates nothing new and answers with the first brew; a different request with that key is 422; keys are
/// per user and expire after 24 hours.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class BrewIdempotencyTests(ApiFixture api, BrewActors actors) : IClassFixture<BrewActors>
{
    [Fact]
    public async Task A_retry_with_the_same_key_and_request_returns_the_first_brew_and_creates_nothing()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();

        using var first = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        using var retry = await PostAsync(actors.Owner.Client, Body(title), key, ct);

        await BrewApi.EnsureStatusAsync(first, HttpStatusCode.Created, ct);
        await BrewApi.EnsureStatusAsync(retry, HttpStatusCode.Created, ct);
        var created = await TestJson.ReadAsync<BrewForEdit>(first, ct);
        var replayed = await TestJson.ReadAsync<BrewForEdit>(retry, ct);
        Assert.Equal(
            (created.EditId, created.ShareId, created.Version, created.Meta.Title, created.Style, created.CreatedAt, created.UpdatedAt),
            (replayed.EditId, replayed.ShareId, replayed.Version, replayed.Meta.Title, replayed.Style, replayed.CreatedAt, replayed.UpdatedAt));
        Assert.Equal(created.Doc.Json, replayed.Doc.Json);
        Assert.Equal(created.Authors, replayed.Authors);
        Assert.Equal(first.Headers.Location, retry.Headers.Location);
        Assert.Equal(1, await CountBrewsAsync(title, ct));

        var stored = await api.Factory.WithDbAsync(db => db.BrewCreateKeys.AsNoTracking()
            .Where(k => k.UserId == actors.Owner.Id && k.Key == key).ToListAsync(ct));
        var row = Assert.Single(stored);
        var brewId = await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == created.EditId).Select(b => b.Id).SingleAsync(ct));
        Assert.Equal(brewId, row.BrewId);
        Assert.Equal(32, row.RequestHash.Length);
    }

    [Fact]
    public async Task A_retry_that_differs_only_in_encoding_key_order_or_number_spelling_is_a_replay()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString("N");
        var original = $$$"""
            {"meta":{"title":{{{JsonSerializer.Serialize(title)}}},"tags":["a","b"]},"style":".x{}","docSchemaVersion":1,
             "doc":{"type":"doc","content":[{"type":"page","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Hé"}]}]}]}}
            """;
        var respelled = $$$"""
            { "doc" : { "content" : [ { "content" : [ { "content" : [ { "text" : "Hé", "type" : "text" } ], "attrs" : { "level" : 2.0 }, "type" : "heading" } ], "type" : "page" } ], "type" : "doc" },
              "docSchemaVersion" : 1, "style" : ".x{}", "snippets" : null,
              "meta" : { "tags" : [ "a", "b" ], "title" : {{{JsonSerializer.Serialize(title)}}} } }
            """;

        using var first = await PostRawAsync(actors.Owner.Client, JsonContent(original), key, ct);
        using var retry = await PostRawAsync(actors.Owner.Client, BrewApi.Gzip(respelled), key, ct);

        await BrewApi.EnsureStatusAsync(first, HttpStatusCode.Created, ct);
        await BrewApi.EnsureStatusAsync(retry, HttpStatusCode.Created, ct);
        Assert.Equal(
            (await TestJson.ReadAsync<BrewForEdit>(first, ct)).EditId,
            (await TestJson.ReadAsync<BrewForEdit>(retry, ct)).EditId);
        Assert.Equal(1, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task The_same_key_with_a_different_request_is_422_and_creates_nothing()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();

        using var first = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        using var changed = await PostAsync(actors.Owner.Client, Body(title, text: "Typed after the first request."), key, ct);

        await BrewApi.EnsureStatusAsync(first, HttpStatusCode.Created, ct);
        await BrewApi.EnsureStatusAsync(changed, HttpStatusCode.UnprocessableEntity, ct);
        Assert.StartsWith("application/problem+json", changed.Content.Headers.ContentType?.ToString());
        var problem = await changed.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("Idempotency-Key reused", problem.GetProperty("title").GetString());
        Assert.Equal(422, problem.GetProperty("status").GetInt32());
        Assert.Equal(1, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task Keys_are_per_user()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();

        using var mine = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        using var theirs = await PostAsync(actors.Other.Client, Body(title), key, ct);

        await BrewApi.EnsureStatusAsync(mine, HttpStatusCode.Created, ct);
        await BrewApi.EnsureStatusAsync(theirs, HttpStatusCode.Created, ct);
        var theirBrew = await TestJson.ReadAsync<BrewForEdit>(theirs, ct);
        Assert.NotEqual((await TestJson.ReadAsync<BrewForEdit>(mine, ct)).EditId, theirBrew.EditId);
        Assert.Equal([new BrewAuthorInfo(actors.Other.Handle, AuthorRole.Owner)], theirBrew.Authors);
        Assert.Equal(2, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task Without_a_key_every_request_creates_a_brew()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();

        using var first = await PostAsync(actors.Owner.Client, Body(title), key: null, ct);
        using var second = await PostAsync(actors.Owner.Client, Body(title), key: null, ct);

        await BrewApi.EnsureStatusAsync(first, HttpStatusCode.Created, ct);
        await BrewApi.EnsureStatusAsync(second, HttpStatusCode.Created, ct);
        Assert.Equal(2, await CountBrewsAsync(title, ct));
    }

    [Theory]
    [InlineData("has space")]
    [InlineData("\"\"")]
    [InlineData("tab\tkey")]
    public async Task Malformed_keys_are_400_and_create_nothing(string key)
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();

        using var response = await PostAsync(actors.Owner.Client, Body(title), key, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Contains("visible ASCII", problem.GetProperty("errors").GetProperty("Idempotency-Key")[0].GetString());
        Assert.Equal(0, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task Several_key_headers_are_400()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/brews") { Content = JsonContent(Body(title).ToJsonString()) };
        request.Headers.TryAddWithoutValidation(CreateIdempotency.HeaderName, [Guid.NewGuid().ToString(), Guid.NewGuid().ToString()]);

        using var response = await actors.Owner.Client.SendAsync(request, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.BadRequest, ct);
        Assert.Equal(0, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task A_key_longer_than_128_characters_is_400()
    {
        var ct = TestContext.Current.CancellationToken;

        var longestKey = Guid.NewGuid().ToString("N").PadRight(128, 'k');

        using var longest = await PostAsync(actors.Owner.Client, Body(UniqueTitle()), longestKey, ct);
        using var tooLong = await PostAsync(actors.Owner.Client, Body(UniqueTitle()), longestKey + "k", ct);

        await BrewApi.EnsureStatusAsync(longest, HttpStatusCode.Created, ct);
        await BrewApi.EnsureStatusAsync(tooLong, HttpStatusCode.BadRequest, ct);
    }

    [Fact]
    public async Task A_quoted_key_is_the_same_key()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();

        using var plain = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        using var quoted = await PostAsync(actors.Owner.Client, Body(title), $"\"{key}\"", ct);

        Assert.Equal(
            (await TestJson.ReadAsync<BrewForEdit>(plain, ct)).EditId,
            (await TestJson.ReadAsync<BrewForEdit>(quoted, ct)).EditId);
        Assert.Equal(1, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task A_replay_returns_the_brew_as_it_is_now()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();
        using var first = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        var created = await TestJson.ReadAsync<BrewForEdit>(first, ct);
        using var save = await BrewApi.SaveAsync(actors.Owner.Client, created.EditId,
            BrewApi.SaveBody(created.Version, BrewApi.SimpleDoc("Saved later")), ct);
        await BrewApi.EnsureStatusAsync(save, HttpStatusCode.OK, ct);

        using var retry = await PostAsync(actors.Owner.Client, Body(title), key, ct);

        await BrewApi.EnsureStatusAsync(retry, HttpStatusCode.Created, ct);
        var replayed = await TestJson.ReadAsync<BrewForEdit>(retry, ct);
        Assert.Equal(created.EditId, replayed.EditId);
        Assert.Equal(created.Version + 1, replayed.Version);
        Assert.Contains("Saved later", replayed.Doc.Json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_replay_after_the_brew_was_deleted_creates_a_new_one()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();
        using var first = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        var created = await TestJson.ReadAsync<BrewForEdit>(first, ct);
        using (var delete = await actors.Owner.Client.DeleteAsync($"/api/brews/{created.EditId}", ct))
        {
            await BrewApi.EnsureStatusAsync(delete, HttpStatusCode.OK, ct);
        }

        Assert.Equal(0, await api.Factory.WithDbAsync(db => db.BrewCreateKeys.CountAsync(k => k.UserId == actors.Owner.Id && k.Key == key, ct)));
        using var retry = await PostAsync(actors.Owner.Client, Body(title), key, ct);

        await BrewApi.EnsureStatusAsync(retry, HttpStatusCode.Created, ct);
        Assert.NotEqual(created.EditId, (await TestJson.ReadAsync<BrewForEdit>(retry, ct)).EditId);
        Assert.Equal(1, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task Keys_expire_after_24_hours_and_expired_keys_are_deleted_on_the_next_keyed_create()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();
        var otherKey = Guid.NewGuid().ToString();
        var freshKey = Guid.NewGuid().ToString();
        using var first = await PostAsync(actors.Owner.Client, Body(title), key, ct);
        using var others = await PostAsync(actors.Other.Client, Body(UniqueTitle()), otherKey, ct);
        using var fresh = await PostAsync(actors.Other.Client, Body(UniqueTitle()), freshKey, ct);
        var created = await TestJson.ReadAsync<BrewForEdit>(first, ct);
        await ExecuteAsync(
            "UPDATE brew_create_keys SET created_at = now() - interval '24 hours 1 minute' WHERE (user_id = @owner AND key = @key) OR (user_id = @other AND key = @otherKey)",
            ct, ("owner", actors.Owner.Id), ("key", key), ("other", actors.Other.Id), ("otherKey", otherKey));

        using var retry = await PostAsync(actors.Owner.Client, Body(title), key, ct);

        await BrewApi.EnsureStatusAsync(retry, HttpStatusCode.Created, ct);
        var recreated = await TestJson.ReadAsync<BrewForEdit>(retry, ct);
        Assert.NotEqual(created.EditId, recreated.EditId);
        Assert.Equal(2, await CountBrewsAsync(title, ct));
        var keys = await api.Factory.WithDbAsync(db => db.BrewCreateKeys.AsNoTracking()
            .Where(k => k.Key == key || k.Key == otherKey || k.Key == freshKey)
            .Select(k => new { k.Key, k.BrewId, k.CreatedAt }).ToListAsync(ct));
        Assert.Equal(new[] { freshKey, key }.Order(StringComparer.Ordinal), keys.Select(k => k.Key).Order(StringComparer.Ordinal));
        Assert.Equal(
            await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.EditId == recreated.EditId).Select(b => b.Id).SingleAsync(ct)),
            keys.Single(k => k.Key == key).BrewId);
        Assert.True(keys.Single(k => k.Key == key).CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-5));
    }

    [Fact]
    public async Task A_request_that_races_one_with_the_same_key_waits_for_it_and_returns_its_brew()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var raceKey = Guid.NewGuid().ToString();
        // The brew and fingerprint the "first" request will have committed: made through the API with another key.
        using var seed = await PostAsync(actors.Owner.Client, Body(title), Guid.NewGuid().ToString(), ct);
        var seeded = await TestJson.ReadAsync<BrewForEdit>(seed, ct);

        await using var first = new NpgsqlConnection(api.ConnectionString);
        await first.OpenAsync(ct);
        await using var transaction = await first.BeginTransactionAsync(ct);
        await using (var insert = new NpgsqlCommand(
                         """
                         INSERT INTO brew_create_keys (user_id, key, brew_id, request_hash, created_at)
                         SELECT k.user_id, @raceKey, k.brew_id, k.request_hash, now()
                         FROM brew_create_keys k JOIN brews b ON b.id = k.brew_id
                         WHERE k.user_id = @owner AND b.edit_id = @editId
                         """, first, transaction))
        {
            insert.Parameters.AddWithValue("raceKey", raceKey);
            insert.Parameters.AddWithValue("owner", actors.Owner.Id);
            insert.Parameters.AddWithValue("editId", seeded.EditId);
            Assert.Equal(1, await insert.ExecuteNonQueryAsync(ct));
        }

        // The second request finds no committed key, inserts its own brew and key, and waits on the key's index entry.
        var second = PostAsync(actors.Owner.Client, Body(title), raceKey, ct);
        await WaitForLockWaitersAsync(api.ConnectionString, 1, ct);
        await transaction.CommitAsync(ct);

        using var response = await second;
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        Assert.Equal(seeded.EditId, (await TestJson.ReadAsync<BrewForEdit>(response, ct)).EditId);
        Assert.Equal(1, await CountBrewsAsync(title, ct));
    }

    [Fact]
    public async Task Concurrent_requests_with_the_same_key_create_one_brew()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = UniqueTitle();
        var key = Guid.NewGuid().ToString();

        var responses = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => PostAsync(actors.Owner.Client, Body(title), key, ct)));

        try
        {
            var editIds = new List<string>();
            foreach (var response in responses)
            {
                await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
                editIds.Add((await TestJson.ReadAsync<BrewForEdit>(response, ct)).EditId);
            }

            Assert.Single(editIds.Distinct());
            Assert.Equal(1, await CountBrewsAsync(title, ct));
        }
        finally
        {
            foreach (var response in responses) response.Dispose();
        }
    }

    [Fact]
    public async Task The_key_table_cascades_with_brews_and_users_and_is_indexed_for_cleanup()
    {
        var ct = TestContext.Current.CancellationToken;
        var user = await api.Factory.CreateUserAsync(ct: ct);
        var key = Guid.NewGuid().ToString();
        using (user)
        {
            using var created = await PostAsync(user.Client, Body(UniqueTitle()), key, ct);
            await BrewApi.EnsureStatusAsync(created, HttpStatusCode.Created, ct);
        }

        var indexes = await RowsAsync(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'brew_create_keys'", ct);
        var foreignKeys = await RowsAsync(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'brew_create_keys'::regclass AND contype = 'f'", ct);
        Assert.Equal(
            [
                "CREATE INDEX ix_brew_create_keys_brew_id ON public.brew_create_keys USING btree (brew_id)",
                "CREATE INDEX ix_brew_create_keys_created_at ON public.brew_create_keys USING btree (created_at)",
                "CREATE UNIQUE INDEX pk_brew_create_keys ON public.brew_create_keys USING btree (user_id, key)",
            ],
            indexes.Order(StringComparer.Ordinal));
        Assert.Equal(
            [
                "FOREIGN KEY (brew_id) REFERENCES brews(id) ON DELETE CASCADE",
                "FOREIGN KEY (user_id) REFERENCES asp_net_users(id) ON DELETE CASCADE",
            ],
            foreignKeys.Order(StringComparer.Ordinal));

        await ExecuteAsync("DELETE FROM asp_net_users WHERE id = @id", ct, ("id", user.Id));
        Assert.Equal(0, await api.Factory.WithDbAsync(db => db.BrewCreateKeys.CountAsync(k => k.UserId == user.Id, ct)));
    }

    // ---- CreateIdempotency (no database) ------------------------------------------------------------

    [Theory]
    [InlineData("0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5b-d9cb-469f-a165-70867728950e")]
    [InlineData("\"quoted-key\"", "quoted-key")]
    [InlineData("a", "a")]
    [InlineData("!~:/+=", "!~:/+=")]
    [InlineData("", null)]
    [InlineData("\"\"", null)]
    [InlineData("tab\tkey", null)]
    [InlineData("clé", null)]
    [InlineData("a b", null)]
    public void Parse_accepts_visible_ascii_keys_up_to_128_characters(string header, string? expected)
    {
        Assert.Equal(expected, CreateIdempotency.Parse(header));
        Assert.Equal(new string('x', 128), CreateIdempotency.Parse(new string('x', 128)));
        Assert.Null(CreateIdempotency.Parse(new string('x', 129)));
    }

    [Fact]
    public void HeaderValue_keeps_an_empty_header_and_joins_several_so_that_Parse_refuses_them()
    {
        // (HttpClient over TestServer drops empty header values, so the empty case is checked here.)
        static string? Value(params string[] values)
        {
            var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
            if (values.Length > 0) context.Request.Headers[CreateIdempotency.HeaderName] = values;
            return CreateIdempotency.HeaderValue(context.Request.Headers);
        }

        Assert.Null(Value());
        Assert.Equal("", Value(""));
        Assert.Null(CreateIdempotency.Parse(Value("")!));
        Assert.Equal("a, b", Value("a", "b"));
        Assert.Null(CreateIdempotency.Parse(Value("a", "b")!));
        Assert.Equal("k-1", CreateIdempotency.Parse(Value("k-1")!));
    }

    [Fact]
    public void Fingerprint_ignores_member_order_and_number_spelling_but_not_values()
    {
        static CreateBrewRequest Request(string docJson, string? style = ".a{}") =>
            new(JsonDocument.Parse(docJson).RootElement, style, null, new BrewMetaInput(Title: "T"), null, 1);

        var a = CreateIdempotency.Fingerprint(Request("""{"type":"doc","attrs":{"n":2,"m":"x"}}"""));
        var reordered = CreateIdempotency.Fingerprint(Request("""{ "attrs": { "m": "x", "n": 2.0 }, "type": "doc" }"""));
        var changedValue = CreateIdempotency.Fingerprint(Request("""{"type":"doc","attrs":{"n":3,"m":"x"}}"""));
        var changedStyle = CreateIdempotency.Fingerprint(Request("""{"type":"doc","attrs":{"n":2,"m":"x"}}""", ".b{}"));

        Assert.Equal(32, a.Length);
        Assert.Equal(a, reordered);
        Assert.NotEqual(a, changedValue);
        Assert.NotEqual(a, changedStyle);
    }

    // ---- helpers ---------------------------------------------------------------------------------

    private static string UniqueTitle() => "Idempotent " + Guid.NewGuid().ToString("N")[..16];

    private static JsonObject Body(string title, string text = "Some text.") => new()
    {
        ["doc"] = BrewApi.SimpleDoc("Heading", text),
        ["style"] = ".page { color: red; }",
        ["meta"] = new JsonObject { ["title"] = title },
        ["docSchemaVersion"] = 1,
    };

    private static HttpContent JsonContent(string json) => new StringContent(json, Encoding.UTF8, "application/json");

    private static Task<HttpResponseMessage> PostAsync(HttpClient client, JsonObject body, string? key, CancellationToken ct) =>
        PostRawAsync(client, JsonContent(body.ToJsonString()), key, ct);

    private static Task<HttpResponseMessage> PostRawAsync(HttpClient client, HttpContent content, string? key, CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/brews") { Content = content };
        if (key is not null) request.Headers.TryAddWithoutValidation(CreateIdempotency.HeaderName, key);
        return client.SendAsync(request, ct);
    }

    private Task<int> CountBrewsAsync(string title, CancellationToken ct) =>
        api.Factory.WithDbAsync(db => db.Brews.CountAsync(b => b.Title == title, ct));

    private async Task ExecuteAsync(string sql, CancellationToken ct, params (string Name, object Value)[] parameters)
    {
        await using var connection = new NpgsqlConnection(api.ConnectionString);
        await connection.OpenAsync(ct);
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
        await command.ExecuteNonQueryAsync(ct);
    }

    private async Task<List<string>> RowsAsync(string sql, CancellationToken ct)
    {
        await using var connection = new NpgsqlConnection(api.ConnectionString);
        await connection.OpenAsync(ct);
        await using var command = new NpgsqlCommand(sql, connection);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<string>();
        while (await reader.ReadAsync(ct)) rows.Add(reader.GetString(0));
        return rows;
    }

    /// <summary>
    /// Waits until <paramref name="expected"/> backends wait on a lock. Polls on its own connection: inside a
    /// transaction pg_stat_activity is a snapshot taken at first access.
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
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Only {waiting} of {expected} requests reached the lock.");
            await Task.Delay(25, ct);
        }
    }
}
