using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Data;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Homebrewery.Api.Tests;

/// <summary>
/// /healthz (plan P8.4): the host starts in-process (test Postgres, no wwwroot), and the answer includes the database
/// check (<see cref="DatabaseHealthCheck"/>, <c>SELECT 1</c>).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class HealthzTests(ApiFixture api)
{
    [Fact]
    public async Task Healthz_returns_200_with_status_ok_and_the_database_check()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();

        using var response = await client.GetAsync("/healthz", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.True(response.Headers.CacheControl?.NoCache ?? response.Headers.CacheControl?.NoStore ?? false);
        var body = await response.Content.ReadFromJsonAsync<HealthBody>(ct);
        Assert.Equal("ok", body?.Status);
        Assert.Equal(new Dictionary<string, string> { [DatabaseHealthCheck.Name] = "ok" }, body?.Checks);
    }

    [Fact]
    public async Task A_failing_check_makes_healthz_answer_503_without_details()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddHealthChecks()
            .AddCheck("broken", () => HealthCheckResult.Unhealthy("secret detail", new InvalidOperationException("secret exception")))));
        using var client = host.CreateClient();

        using var response = await client.GetAsync("/healthz", ct);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var text = await response.Content.ReadAsStringAsync(ct);
        Assert.DoesNotContain("secret", text, StringComparison.Ordinal);
        var body = await response.Content.ReadFromJsonAsync<HealthBody>(ct);
        Assert.Equal("unhealthy", body?.Status);
        Assert.Equal("unhealthy", body?.Checks["broken"]);
        Assert.Equal("ok", body?.Checks[DatabaseHealthCheck.Name]);
    }

    [Fact]
    public async Task The_database_check_is_unhealthy_when_the_database_does_not_answer()
    {
        var ct = TestContext.Current.CancellationToken;
        // Port 1 on the loopback refuses connections at once.
        await using var provider = new ServiceCollection()
            .AddDbContext<AppDbContext>(o => o.UseHomebreweryNpgsql("Host=127.0.0.1;Port=1;Database=x;Username=x;Password=x;Timeout=3"))
            .Configure<Microsoft.AspNetCore.Identity.IdentityOptions>(o => o.Stores.SchemaVersion = AppDbContext.IdentitySchemaVersion)
            .BuildServiceProvider();
        var check = new DatabaseHealthCheck(provider.GetRequiredService<IServiceScopeFactory>());
        var context = new HealthCheckContext
        {
            Registration = new HealthCheckRegistration(DatabaseHealthCheck.Name, check, HealthStatus.Unhealthy, tags: null),
        };

        var result = await check.CheckHealthAsync(context, ct);

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.NotNull(result.Exception);
    }

    [Fact]
    public async Task The_database_check_passes_against_the_test_database()
    {
        var ct = TestContext.Current.CancellationToken;
        var check = new DatabaseHealthCheck(api.Factory.Services.GetRequiredService<IServiceScopeFactory>());
        var context = new HealthCheckContext
        {
            Registration = new HealthCheckRegistration(DatabaseHealthCheck.Name, check, HealthStatus.Unhealthy, tags: null),
        };

        var result = await check.CheckHealthAsync(context, ct);

        Assert.Equal(HealthStatus.Healthy, result.Status);
    }

    private sealed record HealthBody(string Status, Dictionary<string, string> Checks);
}
