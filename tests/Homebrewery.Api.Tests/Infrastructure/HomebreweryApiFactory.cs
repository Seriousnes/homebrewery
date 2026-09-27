using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>
/// The API in-process against the test run's Postgres container. Never touches the compose database
/// or the real wwwroot:
/// <list type="bullet">
/// <item>environment <c>Testing</c> (no appsettings.Development.json, user secrets or static web assets);</item>
/// <item>an empty temporary web root (override with <c>WithWebHostBuilder(b =&gt; b.UseWebRoot(...))</c>);</item>
/// <item><c>Database:MigrateOnStartup=true</c>, so starting the host applies the migrations;</item>
/// <item><c>Themes:CatalogPath</c> = <see cref="ThemeCatalogFixture"/>, a committed copy of the web build's
/// <c>themes.json</c> (the web root is empty).</item>
/// </list>
/// Customize per test class with <c>Factory.WithWebHostBuilder(b =&gt; b.UseSetting(key, value))</c>;
/// the derived factory keeps these settings, starts its own host on the same database, and must be
/// disposed (<c>await using</c>).
/// </summary>
public sealed class HomebreweryApiFactory(string connectionString) : WebApplicationFactory<Program>
{
    public const string EnvironmentName = "Testing";

    /// <summary>Origin sent by every client this factory creates (the TestServer host).</summary>
    public const string Origin = "http://localhost";

    private readonly DirectoryInfo _webRoot = Directory.CreateTempSubdirectory("homebrewery-test-wwwroot-");

    public string ConnectionString { get; } = connectionString;

    /// <summary>The committed copy of <c>/themes/themes.json</c> (Fixtures/themes.json, copied next to the tests).</summary>
    public static string ThemeCatalogFixture { get; } = Path.Combine(AppContext.BaseDirectory, "Fixtures", "themes.json");

    /// <summary>
    /// Rate limits of the test hosts: high enough that no test trips them (every test client shares one partition,
    /// the TestServer has no remote IP). RateLimitTests lowers them on its own hosts.
    /// </summary>
    public const int GenerousPermitLimit = 1_000_000;

    protected override void ConfigureWebHost(IWebHostBuilder builder) => builder
        .UseEnvironment(EnvironmentName)
        .UseWebRoot(_webRoot.FullName)
        .UseSetting("ConnectionStrings:Homebrewery", ConnectionString)
        .UseSetting("Database:MigrateOnStartup", "true")
        .UseSetting("Themes:CatalogPath", ThemeCatalogFixture)
        .UseSetting("RateLimits:Auth:PermitLimit", GenerousPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("RateLimits:Import:PermitLimit", GenerousPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("RateLimits:Pdf:PermitLimit", GenerousPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("RateLimits:Writes:PermitLimit", GenerousPermitLimit.ToString(System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("Logging:LogLevel:Microsoft.EntityFrameworkCore", "Warning");

    protected override void ConfigureClient(HttpClient client)
    {
        base.ConfigureClient(client);
        // Browsers send Origin on same-origin POST/PUT/DELETE; SameOriginWriteGuard (P2.7) requires it.
        client.DefaultRequestHeaders.Add("Origin", Origin);
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        try
        {
            _webRoot.Delete(recursive: true);
        }
        catch (IOException)
        {
            // Best effort: a file may still be open on Windows.
        }
    }
}
