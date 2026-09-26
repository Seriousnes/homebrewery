using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Homebrewery.Api.Tests;

/// <summary>
/// P2.1: the migrations produce the schema of plan §8.2 (checked against the live test database),
/// apply to an empty database, and match the EF model. The model tests pin the behaviours later
/// phases rely on (jsonb lock, tsvector search, optimistic concurrency, handle constraints).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class SchemaTests(ApiFixture api)
{
    private sealed record Column(string Name, string Type, bool Nullable, string? Default);

    [Fact]
    public async Task Migrations_are_applied_and_the_model_has_no_pending_changes()
    {
        var ct = TestContext.Current.CancellationToken;
        var (pending, modelChanged) = await api.Factory.WithDbAsync(async db =>
            ((await db.Database.GetPendingMigrationsAsync(ct)).ToList(), db.Database.HasPendingModelChanges()));

        Assert.Empty(pending);
        Assert.False(modelChanged, "The EF model differs from the migrations: add a migration.");
    }

    [Fact]
    public async Task Brews_columns_match_the_reference_schema()
    {
        Column[] expected =
        [
            new("id", "uuid", false, null),
            new("share_id", "text", false, null),
            new("edit_id", "text", false, null),
            new("title", "text", false, "''::text"),
            new("description", "text", false, "''::text"),
            new("lang", "text", false, "'en'::text"),
            new("theme", "text", false, "'5ePHB'::text"),
            new("doc_schema_version", "int4", false, "1"),
            new("doc", "jsonb", false, null),
            new("style", "text", false, "''::text"),
            new("snippets", "jsonb", true, null),
            new("source_markdown", "text", true, null),
            new("search_text", "text", false, "''::text"),
            new("search_vector", "tsvector", false, null),
            new("tags", "_text", false, "'{}'::text[]"),
            new("page_count", "int4", false, "1"),
            new("published", "bool", false, "false"),
            new("thumbnail_url", "text", true, null),
            new("views", "int4", false, "0"),
            new("version", "int4", false, "1"),
            new("lock", "jsonb", true, null),
            new("created_at", "timestamptz", false, "now()"),
            new("updated_at", "timestamptz", false, "now()"),
            new("last_viewed_at", "timestamptz", true, null),
        ];

        var actual = await ColumnsAsync("brews");

        Assert.Equal(expected.OrderBy(c => c.Name), actual.OrderBy(c => c.Name));
    }

    [Fact]
    public async Task Brew_authors_and_notifications_columns_match_the_reference_schema()
    {
        Column[] authors =
        [
            new("brew_id", "uuid", false, null),
            new("user_id", "uuid", false, null),
            new("role", "int2", false, null),
            new("position", "int2", false, null),
        ];
        Column[] notifications =
        [
            new("id", "uuid", false, null),
            new("dismiss_key", "text", false, null),
            new("title", "text", false, null),
            new("body", "text", false, null),
            new("starts_at", "timestamptz", false, null),
            new("stops_at", "timestamptz", false, null),
            new("created_at", "timestamptz", false, "now()"),
        ];

        Assert.Equal(authors.OrderBy(c => c.Name), (await ColumnsAsync("brew_authors")).OrderBy(c => c.Name));
        Assert.Equal(notifications.OrderBy(c => c.Name), (await ColumnsAsync("notifications")).OrderBy(c => c.Name));
    }

    [Fact]
    public async Task Search_vector_is_a_stored_simple_tsvector_over_title_description_and_search_text()
    {
        var generation = await ScalarAsync<string>("""
            SELECT is_generated || ' ' || generation_expression FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'brews' AND column_name = 'search_vector'
            """);

        // The reference SQL wraps each column in coalesce(); Npgsql omits it because all three are NOT NULL.
        Assert.Equal(
            "ALWAYS to_tsvector('simple'::regconfig, ((((title || ' '::text) || description) || ' '::text) || search_text))",
            generation);
    }

    [Fact]
    public async Task Doc_uses_lz4_compression()
    {
        var compression = await ScalarAsync<string>(
            "SELECT attcompression::text FROM pg_attribute WHERE attrelid = 'brews'::regclass AND attname = 'doc'");

        Assert.Equal("l", compression);
    }

    [Fact]
    public async Task Indexes_match_the_reference_schema()
    {
        var expected = new Dictionary<string, string>
        {
            ["pk_brews"] = "CREATE UNIQUE INDEX pk_brews ON public.brews USING btree (id)",
            ["ix_brews_share_id"] = "CREATE UNIQUE INDEX ix_brews_share_id ON public.brews USING btree (share_id)",
            ["ix_brews_edit_id"] = "CREATE UNIQUE INDEX ix_brews_edit_id ON public.brews USING btree (edit_id)",
            ["ix_brews_tags"] = "CREATE INDEX ix_brews_tags ON public.brews USING gin (tags)",
            ["ix_brews_search_vector"] = "CREATE INDEX ix_brews_search_vector ON public.brews USING gin (search_vector)",
            ["ix_brews_published_updated"] =
                "CREATE INDEX ix_brews_published_updated ON public.brews USING btree (published, updated_at DESC)",
            ["pk_brew_authors"] = "CREATE UNIQUE INDEX pk_brew_authors ON public.brew_authors USING btree (brew_id, user_id)",
            ["ix_brew_authors_user"] = "CREATE INDEX ix_brew_authors_user ON public.brew_authors USING btree (user_id)",
            ["pk_notifications"] = "CREATE UNIQUE INDEX pk_notifications ON public.notifications USING btree (id)",
            ["ix_notifications_dismiss_key"] =
                "CREATE UNIQUE INDEX ix_notifications_dismiss_key ON public.notifications USING btree (dismiss_key)",
        };

        var actual = await RowsAsync(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('brews', 'brew_authors', 'notifications')",
            r => (Name: r.GetString(0), Definition: r.GetString(1)));

        Assert.Equal(expected.OrderBy(e => e.Key), actual.ToDictionary(a => a.Name, a => a.Definition).OrderBy(e => e.Key));
    }

    [Fact]
    public async Task Brew_authors_cascade_from_brews_and_users()
    {
        var foreignKeys = await RowsAsync(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'brew_authors'::regclass AND contype = 'f'",
            r => r.GetString(0));

        Assert.Equal(
            new[]
            {
                "FOREIGN KEY (brew_id) REFERENCES brews(id) ON DELETE CASCADE",
                "FOREIGN KEY (user_id) REFERENCES asp_net_users(id) ON DELETE CASCADE",
            },
            foreignKeys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Identity_tables_use_snake_case_and_handles_are_unique_and_constrained()
    {
        var tables = await RowsAsync(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'asp\\_net\\_%'",
            r => r.GetString(0));
        var handleIndex = await ScalarAsync<string>("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_asp_net_users_handle'");
        var handleCheck = await ScalarAsync<string>(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_asp_net_users_handle'");

        Assert.Equal(
            new[]
            {
                "asp_net_role_claims", "asp_net_roles", "asp_net_user_claims", "asp_net_user_logins",
                "asp_net_user_passkeys", "asp_net_user_roles", "asp_net_user_tokens", "asp_net_users",
            },
            tables.Order(StringComparer.Ordinal));
        Assert.Equal("CREATE UNIQUE INDEX ix_asp_net_users_handle ON public.asp_net_users USING btree (handle)", handleIndex);
        Assert.Equal("CHECK (((handle)::text ~ '^[a-z0-9_-]{3,32}$'::text))", handleCheck);
    }

    [Fact]
    public async Task The_database_rejects_upper_case_and_duplicate_handles()
    {
        var ct = TestContext.Current.CancellationToken;
        using var first = await api.Factory.CreateUserAsync(ct: ct);
        using var second = await api.Factory.CreateUserAsync(ct: ct);

        var upper = await Assert.ThrowsAsync<PostgresException>(() => ExecuteAsync(
            "UPDATE asp_net_users SET handle = upper(handle) WHERE id = @id", ("id", first.Id)));
        var duplicate = await Assert.ThrowsAsync<PostgresException>(() => ExecuteAsync(
            "UPDATE asp_net_users SET handle = @handle WHERE id = @id", ("handle", first.Handle), ("id", second.Id)));

        Assert.Equal(PostgresErrorCodes.CheckViolation, upper.SqlState);
        Assert.Equal(PostgresErrorCodes.UniqueViolation, duplicate.SqlState);
        Assert.Equal("ix_asp_net_users_handle", duplicate.ConstraintName);
    }

    [Fact]
    public async Task Migrations_apply_to_an_empty_database_and_roll_back()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var scratch = await ScratchDatabase.CreateAsync(api.ConnectionString, ct);
        await using var db = new AppDbContext(AppDbContext.CreateStandaloneOptions(scratch.ConnectionString));

        Assert.NotEmpty(await db.Database.GetPendingMigrationsAsync(ct));
        await db.Database.MigrateAsync(ct);                              // throws if the model has pending changes
        Assert.Empty(await db.Database.GetPendingMigrationsAsync(ct));
        Assert.Equal(0, await db.Brews.CountAsync(ct));

        await db.GetService<IMigrator>().MigrateAsync(Migration.InitialDatabase, cancellationToken: ct);
        var remaining = await db.Database
            .SqlQueryRaw<string>("SELECT tablename AS \"Value\" FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__EFMigrationsHistory'")
            .ToListAsync(ct);
        Assert.Empty(remaining);
    }

    [Fact]
    public void A_context_without_the_identity_schema_version_refuses_to_build_its_model()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>();
        options.UseHomebreweryNpgsql("Host=unused.invalid");
        using var db = new AppDbContext(options.Options);

        var error = Assert.Throws<InvalidOperationException>(() => db.Model);

        Assert.Contains(nameof(AppDbContext.CreateStandaloneOptions), error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Brews_store_the_lock_as_camel_case_json_and_are_searchable()
    {
        var ct = TestContext.Current.CancellationToken;
        var marker = "kobold" + Guid.NewGuid().ToString("N")[..8];
        var brew = new Brew
        {
            Title = "The Dragon Tavern",
            Doc = """{"type":"doc","content":[]}""",
            SearchText = $"an ambush by {marker} raiders",
            Tags = ["meta:theme", "type:adventure"],
            Lock = new BrewLock { Code = 455, EditMessage = "Locked for review", ShareMessage = "Unavailable", Applied = DateTimeOffset.UtcNow },
        };
        await api.Factory.WithDbAsync(async db =>
        {
            db.Brews.Add(brew);
            return await db.SaveChangesAsync(ct);
        });

        var (loaded, found) = await api.Factory.WithDbAsync(async db => (
            await db.Brews.AsNoTracking().SingleAsync(b => b.Id == brew.Id, ct),
            await db.Brews.Where(b => b.SearchVector.Matches(EF.Functions.WebSearchToTsQuery("simple", marker)))
                .Select(b => b.Id).ToListAsync(ct)));
        var lockJson = await ScalarAsync<string>("SELECT lock::text FROM brews WHERE id = @id", ("id", brew.Id));

        Assert.Equal("Locked for review", loaded.Lock?.EditMessage);
        Assert.Equal(new[] { "meta:theme", "type:adventure" }, loaded.Tags);
        Assert.Equal(new[] { brew.Id }, found);
        Assert.Contains("\"editMessage\": \"Locked for review\"", lockJson, StringComparison.Ordinal);
        Assert.Contains("\"code\": 455", lockJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Version_is_an_optimistic_concurrency_token()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = new Brew { Doc = """{"type":"doc","content":[]}""" };
        await api.Factory.WithDbAsync(async db =>
        {
            db.Brews.Add(brew);
            return await db.SaveChangesAsync(ct);
        });

        await using var scopeA = api.Factory.Services.CreateAsyncScope();
        await using var scopeB = api.Factory.Services.CreateAsyncScope();
        var dbA = scopeA.ServiceProvider.GetRequiredService<AppDbContext>();
        var dbB = scopeB.ServiceProvider.GetRequiredService<AppDbContext>();
        var copyA = await dbA.Brews.SingleAsync(b => b.Id == brew.Id, ct);
        var copyB = await dbB.Brews.SingleAsync(b => b.Id == brew.Id, ct);

        copyA.Title = "A";
        copyA.Version++;
        await dbA.SaveChangesAsync(ct);
        copyB.Title = "B";
        copyB.Version++;

        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => dbB.SaveChangesAsync(ct));
    }

    private async Task<List<Column>> ColumnsAsync(string table) => await RowsAsync(
        """
        SELECT column_name, udt_name, is_nullable = 'YES', column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = @table
        """,
        r => new Column(r.GetString(0), r.GetString(1), r.GetBoolean(2), r.IsDBNull(3) ? null : r.GetString(3)),
        ("table", table));

    private async Task<List<T>> RowsAsync<T>(string sql, Func<NpgsqlDataReader, T> read, params (string Name, object Value)[] parameters)
    {
        var ct = TestContext.Current.CancellationToken;
        await using var connection = new NpgsqlConnection(api.ConnectionString);
        await connection.OpenAsync(ct);
        await using var command = Command(connection, sql, parameters);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<T>();
        while (await reader.ReadAsync(ct)) rows.Add(read(reader));
        return rows;
    }

    private async Task<T> ScalarAsync<T>(string sql, params (string Name, object Value)[] parameters) =>
        (await RowsAsync(sql, r => r.GetFieldValue<T>(0), parameters)).Single();

    private async Task ExecuteAsync(string sql, params (string Name, object Value)[] parameters)
    {
        var ct = TestContext.Current.CancellationToken;
        await using var connection = new NpgsqlConnection(api.ConnectionString);
        await connection.OpenAsync(ct);
        await using var command = Command(connection, sql, parameters);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static NpgsqlCommand Command(NpgsqlConnection connection, string sql, (string Name, object Value)[] parameters)
    {
        var command = new NpgsqlCommand(sql, connection);
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
        return command;
    }
}
