using Homebrewery.Core.Documents;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

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
/// <item>cheap password hashes (1 PBKDF2 iteration) and a raw HTML time limit that never runs out.</item>
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

    /// <summary>
    /// The rate limit window of the test hosts: a day, so a limit a test lowers never replenishes while the test runs,
    /// however slow the machine is.
    /// </summary>
    public static readonly TimeSpan RateLimitWindow = TimeSpan.FromDays(1);

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
        .UseSetting("RateLimits:Auth:Window", RateLimitWindow.ToString("c", System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("RateLimits:Import:Window", RateLimitWindow.ToString("c", System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("RateLimits:Pdf:Window", RateLimitWindow.ToString("c", System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("RateLimits:Writes:Window", RateLimitWindow.ToString("c", System.Globalization.CultureInfo.InvariantCulture))
        .UseSetting("Logging:LogLevel:Microsoft.EntityFrameworkCore", "Warning")
        .ConfigureTestServices(s =>
        {
            // Every test registers and signs in its own accounts, one test at a time (ApiCollection): with the default
            // 100,000 PBKDF2 iterations the hashing alone took ~15 s of the run, and far more on a busy machine.
            s.Configure<PasswordHasherOptions>(o => o.IterationCount = 1);
            // Raw HTML never runs out of its time limit because the machine is busy (RawHtmlSanitizerTests test the limit).
            s.Replace(ServiceDescriptor.Singleton(new RawHtmlSanitizer(clock: SteppingClock.Stopped())));
        });

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
