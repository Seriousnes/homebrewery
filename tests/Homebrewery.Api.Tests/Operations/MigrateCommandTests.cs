using System.Diagnostics;
using System.Text.Json;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Homebrewery.Api.Tests.Operations;

/// <summary>
/// <c>Homebrewery.Api migrate</c> (plan P8.4), run as a real process in
/// the Production environment: it migrates, seeds the Admin role and exits 0, or logs a Critical entry and exits 1.
/// Its stdout also shows the production log format: one JSON object per line with a UTC timestamp.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class MigrateCommandTests(ApiFixture api)
{
    private static readonly TimeSpan ProcessTimeout = TimeSpan.FromMinutes(2);

    [Theory]
    [InlineData(new[] { "migrate" }, true)]
    [InlineData(new[] { "MIGRATE" }, true)]
    [InlineData(new[] { "migrate", "--Logging:LogLevel:Default=Debug" }, true)]
    [InlineData(new string[0], false)]
    [InlineData(new[] { "--migrate" }, false)]
    [InlineData(new[] { "--urls", "migrate" }, false)]
    [InlineData(new[] { "migrations" }, false)]
    public void IsRequested_only_for_migrate_as_the_first_argument(string[] args, bool expected) =>
        Assert.Equal(expected, MigrateCommand.IsRequested(args));

    [Fact]
    public async Task Migrate_applies_every_migration_seeds_the_admin_role_and_exits_0()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var scratch = await ScratchDatabase.CreateAsync(api.ConnectionString, ct);

        var first = await RunApiAsync(["migrate"], scratch.ConnectionString, ct);
        var second = await RunApiAsync(["migrate"], scratch.ConnectionString, ct);   // idempotent

        Assert.True(first.ExitCode == 0, first.Output);
        Assert.True(second.ExitCode == 0, second.Output);
        await using (var db = new AppDbContext(AppDbContext.CreateStandaloneOptions(scratch.ConnectionString)))
        {
            Assert.Empty(await db.Database.GetPendingMigrationsAsync(ct));
            Assert.NotEmpty(await db.Database.GetAppliedMigrationsAsync(ct));
        }
        await using (var connection = new NpgsqlConnection(scratch.ConnectionString))
        {
            await connection.OpenAsync(ct);
            await using var command = new NpgsqlCommand("SELECT count(*) FROM asp_net_roles WHERE name = 'Admin'", connection);
            Assert.Equal(1L, await command.ExecuteScalarAsync(ct));
        }

        var logs = JsonLines(first.StdOut);
        Assert.Contains(logs, l => l.GetProperty("Category").GetString() == typeof(MigrateCommand).FullName
                                   && l.GetProperty("LogLevel").GetString() == "Information"
                                   && l.GetProperty("Message").GetString()!.Contains("up to date", StringComparison.Ordinal));
        Assert.Contains(logs, l => l.GetProperty("Category").GetString() == "Homebrewery.Api.Infrastructure.DatabaseInitializer");
        // The web server never started.
        Assert.DoesNotContain(logs, l => l.GetProperty("Message").GetString()!.Contains("Now listening", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Production_logs_are_one_json_object_per_line_with_utc_timestamps()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var scratch = await ScratchDatabase.CreateAsync(api.ConnectionString, ct);

        var run = await RunApiAsync(["migrate"], scratch.ConnectionString, ct);

        Assert.True(run.ExitCode == 0, run.Output);
        var lines = run.StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.NotEmpty(lines);
        foreach (var line in lines)
        {
            using var doc = JsonDocument.Parse(line);           // throws on anything that is not one JSON object
            var entry = doc.RootElement;
            var timestamp = entry.GetProperty("Timestamp").GetString()!;
            Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", timestamp);
            Assert.True(entry.TryGetProperty("EventId", out _));
            Assert.True(entry.TryGetProperty("LogLevel", out _));
            Assert.True(entry.TryGetProperty("Category", out _));
            Assert.True(entry.TryGetProperty("Message", out _));
        }
        Assert.DoesNotContain("Password=", run.Output, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Migrate_logs_a_critical_entry_and_exits_1_when_the_database_is_unreachable()
    {
        var ct = TestContext.Current.CancellationToken;
        // Port 1 on the loopback refuses connections at once.
        var run = await RunApiAsync(["migrate"], "Host=127.0.0.1;Port=1;Database=x;Username=x;Password=not-logged;Timeout=3", ct);

        Assert.True(run.ExitCode == 1, run.Output);
        var failure = Assert.Single(JsonLines(run.StdOut), l => l.GetProperty("LogLevel").GetString() == "Critical");
        Assert.Equal(typeof(MigrateCommand).FullName, failure.GetProperty("Category").GetString());
        Assert.Equal("The migrate command failed.", failure.GetProperty("Message").GetString());
        Assert.False(string.IsNullOrEmpty(failure.GetProperty("Exception").GetString()));
        Assert.DoesNotContain("not-logged", run.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Migrate_exits_1_without_a_connection_string()
    {
        var ct = TestContext.Current.CancellationToken;

        var run = await RunApiAsync(["migrate"], connectionString: null, ct);

        Assert.True(run.ExitCode == 1, run.Output);
        Assert.Contains("ConnectionStrings:Homebrewery is not configured", run.StdOut, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_failed_start_is_logged_as_json_and_exits_1_without_an_unhandled_exception()
    {
        var ct = TestContext.Current.CancellationToken;

        // The server (no command) against a database that refuses connections: DatabaseInitializer fails the start.
        var run = await RunApiAsync([], "Host=127.0.0.1;Port=1;Database=x;Username=x;Password=not-logged;Timeout=3", ct);

        Assert.True(run.ExitCode == AppLifetime.StartupFailedExitCode, run.Output);
        var failure = Assert.Single(JsonLines(run.StdOut), l => l.GetProperty("Message").GetString() == "Hosting failed to start");
        Assert.Equal("Error", failure.GetProperty("LogLevel").GetString());
        Assert.Contains("NpgsqlException", failure.GetProperty("Exception").GetString(), StringComparison.Ordinal);
        Assert.DoesNotContain("Unhandled exception", run.StdErr, StringComparison.Ordinal);
        Assert.DoesNotContain("not-logged", run.Output, StringComparison.Ordinal);
    }

    private static List<JsonElement> JsonLines(string stdout) =>
        [.. stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => JsonDocument.Parse(line).RootElement.Clone())];

    private sealed record ProcessRun(int ExitCode, string StdOut, string StdErr)
    {
        public string Output => $"exit {ExitCode}\n--- stdout\n{StdOut}\n--- stderr\n{StdErr}";
    }

    /// <summary>
    /// Runs the API assembly next to the tests (<c>dotnet Homebrewery.Api.dll …</c>) in the Production environment, with
    /// that directory as the content root (appsettings.json, schema-manifest.json).
    /// </summary>
    private static async Task<ProcessRun> RunApiAsync(string[] args, string? connectionString, CancellationToken ct)
    {
        var directory = AppContext.BaseDirectory;
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host ? host : "dotnet")
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(Path.Combine(directory, "Homebrewery.Api.dll"));
        foreach (var arg in args) start.ArgumentList.Add(arg);

        // Only what the test sets: no inherited ASP.NET Core, logging or connection settings.
        foreach (var key in start.Environment.Keys.ToList())
        {
            if (key.StartsWith("ASPNETCORE_", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("DOTNET_ENVIRONMENT", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("Logging__", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("ConnectionStrings__", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("Database__", StringComparison.OrdinalIgnoreCase))
            {
                start.Environment.Remove(key);
            }
        }
        start.Environment["ASPNETCORE_ENVIRONMENT"] = "Production";
        start.Environment["ASPNETCORE_URLS"] = "http://127.0.0.1:0";              // if the server ever gets to listen
        start.Environment["Themes__CatalogPath"] = HomebreweryApiFactory.ThemeCatalogFixture;
        start.Environment["DOTNET_NOLOGO"] = "1";
        // A temporary key ring, so the run never touches the user's Data Protection keys.
        var keys = Directory.CreateTempSubdirectory("hb-migrate-keys-");
        start.Environment["DataProtection__KeysPath"] = keys.FullName;
        if (connectionString is not null) start.Environment["ConnectionStrings__Homebrewery"] = connectionString;

        try
        {
            using var process = Process.Start(start) ?? throw new InvalidOperationException("dotnet did not start.");
            var stdout = process.StandardOutput.ReadToEndAsync(ct);
            var stderr = process.StandardError.ReadToEndAsync(ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(ProcessTimeout);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                throw;
            }
            return new ProcessRun(process.ExitCode, await stdout, await stderr);
        }
        finally
        {
            try { keys.Delete(recursive: true); } catch (IOException) { }
        }
    }
}
