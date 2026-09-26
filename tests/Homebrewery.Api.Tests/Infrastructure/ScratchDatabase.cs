using Npgsql;

namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>
/// An empty database in the test run's Postgres container, dropped on dispose. For tests that need a
/// database without migrations (startup and migration tests); everything else uses the shared one.
/// </summary>
public sealed class ScratchDatabase : IAsyncDisposable
{
    private readonly string _serverConnectionString;

    private ScratchDatabase(string serverConnectionString, string name)
    {
        _serverConnectionString = serverConnectionString;
        Name = name;
        ConnectionString = new NpgsqlConnectionStringBuilder(serverConnectionString) { Database = name }.ConnectionString;
    }

    public string Name { get; }
    public string ConnectionString { get; }

    public static async Task<ScratchDatabase> CreateAsync(string serverConnectionString, CancellationToken ct = default)
    {
        var database = new ScratchDatabase(serverConnectionString, "scratch_" + Guid.NewGuid().ToString("N")[..12]);
        await database.ExecuteOnServerAsync($"CREATE DATABASE {database.Name}", ct);
        return database;
    }

    public async ValueTask DisposeAsync()
    {
        NpgsqlConnection.ClearAllPools();
        await ExecuteOnServerAsync($"DROP DATABASE IF EXISTS {Name} WITH (FORCE)", CancellationToken.None);
    }

    private async Task ExecuteOnServerAsync(string sql, CancellationToken ct)
    {
        await using var connection = new NpgsqlConnection(_serverConnectionString);
        await connection.OpenAsync(ct);
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync(ct);
    }
}
