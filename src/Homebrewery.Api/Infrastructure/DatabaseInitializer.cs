using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Prepares the database before the server accepts requests (<see cref="IHostedLifecycleService.StartingAsync"/>
/// runs before Kestrel starts):
/// <list type="number">
/// <item>fails fast when <c>ConnectionStrings:Homebrewery</c> is missing (only Development has a default);</item>
/// <item>applies pending migrations when <c>Database:MigrateOnStartup</c> is true (the compose stack and
/// the tests set it), otherwise fails fast if migrations are pending;</item>
/// <item>ensures the Admin role and grants it to <c>Admin:Emails</c> (<see cref="AdminAccounts"/>).</item>
/// </list>
/// Not run by design-time tools (dotnet ef), which stop the host before it starts.
/// </summary>
public sealed partial class DatabaseInitializer(
    IServiceScopeFactory scopes, IConfiguration configuration, ILogger<DatabaseInitializer> logger)
    : IHostedLifecycleService
{
    public const string MigrateOnStartupKey = "Database:MigrateOnStartup";

    public async Task StartingAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration.GetConnectionString(AppDbContext.ConnectionStringName)))
        {
            throw new InvalidOperationException(
                $"ConnectionStrings:{AppDbContext.ConnectionStringName} is not configured. Set the " +
                $"ConnectionStrings__{AppDbContext.ConnectionStringName} environment variable " +
                "(or user secrets / appsettings.Development.json when developing).");
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        if (configuration.GetValue<bool>(MigrateOnStartupKey))
        {
            LogMigrating();
            await db.Database.MigrateAsync(cancellationToken);
        }
        else
        {
            var pending = (await db.Database.GetPendingMigrationsAsync(cancellationToken)).ToList();
            if (pending.Count > 0)
            {
                throw new InvalidOperationException(
                    $"The database has {pending.Count} pending migration(s) ({string.Join(", ", pending)}). Run " +
                    "'dotnet ef database update --project src/Homebrewery.Data --startup-project src/Homebrewery.Api' " +
                    $"or set {MigrateOnStartupKey}=true.");
            }
        }

        await scope.ServiceProvider.GetRequiredService<AdminAccounts>().SeedAsync(scope.ServiceProvider, cancellationToken);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Information, Message = "Applying pending database migrations (Database:MigrateOnStartup).")]
    private partial void LogMigrating();
}
