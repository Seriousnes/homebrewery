using Testcontainers.PostgreSql;

namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>
/// One <c>postgres:18</c> Testcontainer for the whole test run, plus the API host on top of it.
/// Shared through <see cref="ApiCollection"/>: put <c>[Collection(ApiCollection.Name)]</c> on a test
/// class and take <see cref="ApiFixture"/> in its constructor.
/// <para>The database is shared by every test in the run and is not reset between tests: create
/// your own users and brews (<see cref="TestUsers"/>) and never assume a table is empty.</para>
/// </summary>
public sealed class ApiFixture : IAsyncLifetime
{
    public const string PostgresImage = "postgres:18";

    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder(PostgresImage)
        .WithDatabase("homebrewery")
        .WithUsername("homebrewery")
        .WithPassword("homebrewery")
        .Build();

    private HomebreweryApiFactory? _factory;

    /// <summary>Connection string of the test container's <c>homebrewery</c> database.</summary>
    public string ConnectionString => _postgres.GetConnectionString();

    /// <summary>The shared API host. Already started, so migrations are applied and the Admin role exists.</summary>
    public HomebreweryApiFactory Factory => _factory ?? throw new InvalidOperationException("The fixture is not initialized.");

    public async ValueTask InitializeAsync()
    {
        await _postgres.StartAsync();
        _factory = new HomebreweryApiFactory(ConnectionString);
        _ = _factory.Services;                // starts the host: DatabaseInitializer migrates and seeds
    }

    public async ValueTask DisposeAsync()
    {
        if (_factory is not null) await _factory.DisposeAsync();
        await _postgres.DisposeAsync();
    }
}

/// <summary>The collection that shares <see cref="ApiFixture"/> (tests in it run one at a time).</summary>
[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<ApiFixture>
{
    public const string Name = "Api";
}
