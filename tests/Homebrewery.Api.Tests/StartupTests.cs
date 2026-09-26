using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests;

/// <summary>
/// DatabaseInitializer: the connection string is required, <c>Database:MigrateOnStartup</c> applies
/// migrations (container-first), and without it pending migrations stop the host.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class StartupTests(ApiFixture api)
{
    [Fact]
    public async Task MigrateOnStartup_migrates_an_empty_database_and_creates_the_admin_role()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var scratch = await ScratchDatabase.CreateAsync(api.ConnectionString, ct);
        await using var host = HostOn(scratch.ConnectionString, migrateOnStartup: true);

        var (pending, adminRole) = await host.WithServicesAsync(async services => (
            (await services.GetRequiredService<AppDbContext>().Database.GetPendingMigrationsAsync(ct)).ToList(),
            await services.GetRequiredService<RoleManager<IdentityRole<Guid>>>().RoleExistsAsync(Roles.Admin)));

        Assert.Empty(pending);
        Assert.True(adminRole);
    }

    [Fact]
    public async Task Pending_migrations_stop_the_host_when_MigrateOnStartup_is_off()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var scratch = await ScratchDatabase.CreateAsync(api.ConnectionString, ct);
        await using var host = HostOn(scratch.ConnectionString, migrateOnStartup: false);

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains("pending migration", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_missing_connection_string_stops_the_host()
    {
        await using var host = HostOn(connectionString: "", migrateOnStartup: true);

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains("ConnectionStrings:Homebrewery is not configured", error.ToString(), StringComparison.Ordinal);
    }

    private WebApplicationFactory<Program> HostOn(string connectionString, bool migrateOnStartup) =>
        api.Factory.WithWebHostBuilder(b => b
            .UseSetting("ConnectionStrings:Homebrewery", connectionString)
            .UseSetting("Database:MigrateOnStartup", migrateOnStartup ? "true" : "false"));
}
