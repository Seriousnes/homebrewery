using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// <c>dotnet Homebrewery.Api.dll migrate</c> (in the image: <c>docker run … homebrewery migrate</c>, or
/// <c>docker compose run --rm app migrate</c>): applies pending EF Core migrations, ensures the Admin role and
/// <c>Admin:Emails</c> grants, then exits without starting the web server (docs/operations.md "Upgrades and
/// migrations").
/// </summary>
/// <remarks>
/// It is <see cref="DatabaseInitializer"/> with <c>Database:MigrateOnStartup</c> forced on, so the connection-string
/// check and the seeding are the same as at startup. Use it when the app itself runs with
/// <c>Database:MigrateOnStartup=false</c> (then pending migrations stop it), e.g. as a release step or with a
/// database user that has more rights than the app's. Exit code 0 on success, 1 on any failure (logged).
/// Arguments after <c>migrate</c> are ordinary configuration switches (<c>--Logging:LogLevel:Default=Debug</c>).
/// </remarks>
public static partial class MigrateCommand
{
    public const string Name = "migrate";

    public static bool IsRequested(IReadOnlyList<string> args) =>
        args.Count > 0 && string.Equals(args[0], Name, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Migrates the database of <paramref name="app"/> (built, not started) and returns the process exit code.
    /// Disposes <paramref name="app"/> at the end, which flushes the console log.
    /// </summary>
    public static async Task<int> RunAsync(IHost app, CancellationToken cancellationToken = default)
    {
        await using var disposeApp = app as IAsyncDisposable;
        var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(MigrateCommand).FullName!);
        try
        {
            var configuration = new ConfigurationBuilder()
                .AddConfiguration(app.Services.GetRequiredService<IConfiguration>())
                .AddInMemoryCollection([new(DatabaseInitializer.MigrateOnStartupKey, "true")])
                .Build();

            // DatabaseInitializer checks the connection string, migrates and seeds the Admin role.
            var initializer = ActivatorUtilities.CreateInstance<DatabaseInitializer>(app.Services, configuration);
            await initializer.StartingAsync(cancellationToken);

            await using var scope = app.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var applied = (await db.Database.GetAppliedMigrationsAsync(cancellationToken)).ToList();
            LogUpToDate(logger, applied.Count, applied.LastOrDefault() ?? "(none)");
            return 0;
        }
        catch (Exception ex)
        {
            LogFailed(logger, ex);
            return 1;
        }
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Information,
        Message = "The database is up to date: {MigrationCount} migrations applied, the latest is {LatestMigration}.")]
    private static partial void LogUpToDate(ILogger logger, int migrationCount, string latestMigration);

    [LoggerMessage(EventId = 2, Level = LogLevel.Critical, Message = "The migrate command failed.")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
