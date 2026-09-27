using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Homebrewery.Api.Tests.Operations;

/// <summary>
/// Liveness and readiness (plan P8.4): <c>/healthz/live</c> runs no checks,
/// <c>/healthz/ready</c> runs the checks tagged <see cref="HealthEndpoints.ReadyTag"/> (the database), and
/// <c>/healthz</c> keeps running every check (the compose health checks use it).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class HealthProbeTests(ApiFixture api)
{
    [Fact]
    public async Task Live_and_ready_answer_200_on_a_healthy_host()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();

        var live = await GetAsync(client, HealthEndpoints.LivePath, ct);
        var ready = await GetAsync(client, HealthEndpoints.ReadyPath, ct);

        Assert.Equal((HttpStatusCode.OK, "ok"), (live.Status, live.Body.Status));
        Assert.Empty(live.Body.Checks);
        Assert.Equal((HttpStatusCode.OK, "ok"), (ready.Status, ready.Body.Status));
        Assert.Equal(new Dictionary<string, string> { [DatabaseHealthCheck.Name] = "ok" }, ready.Body.Checks);
    }

    [Fact]
    public async Task A_failing_ready_check_fails_ready_and_healthz_but_not_live()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddHealthChecks()
            .AddCheck("dependency", () => HealthCheckResult.Unhealthy("secret detail"), tags: [HealthEndpoints.ReadyTag])));
        using var client = host.CreateClient();

        var live = await GetAsync(client, HealthEndpoints.LivePath, ct);
        var ready = await GetAsync(client, HealthEndpoints.ReadyPath, ct);
        var all = await GetAsync(client, HealthEndpoints.Path, ct);

        Assert.Equal(HttpStatusCode.OK, live.Status);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, ready.Status);
        Assert.Equal("unhealthy", ready.Body.Status);
        Assert.Equal("unhealthy", ready.Body.Checks["dependency"]);
        Assert.Equal("ok", ready.Body.Checks[DatabaseHealthCheck.Name]);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, all.Status);
        Assert.DoesNotContain("secret", ready.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_untagged_check_counts_for_healthz_only()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddHealthChecks()
            .AddCheck("diagnostic", () => HealthCheckResult.Degraded())));
        using var client = host.CreateClient();

        var ready = await GetAsync(client, HealthEndpoints.ReadyPath, ct);
        var all = await GetAsync(client, HealthEndpoints.Path, ct);

        Assert.Equal(HttpStatusCode.OK, ready.Status);
        Assert.False(ready.Body.Checks.ContainsKey("diagnostic"));
        Assert.Equal(HttpStatusCode.OK, all.Status);                    // Degraded still answers 200 ...
        Assert.Equal("degraded", all.Body.Status);                     // ... and says so
        Assert.Equal("degraded", all.Body.Checks["diagnostic"]);
    }

    [Fact]
    public async Task Probes_are_not_cached_and_answer_HEAD()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();

        foreach (var path in new[] { HealthEndpoints.Path, HealthEndpoints.LivePath, HealthEndpoints.ReadyPath })
        {
            using var get = await client.GetAsync(path, ct);
            Assert.True(get.Headers.CacheControl?.NoCache ?? get.Headers.CacheControl?.NoStore ?? false, path);
            using var head = await client.SendAsync(new HttpRequestMessage(HttpMethod.Head, path), ct);
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        }
    }

    private static async Task<(HttpStatusCode Status, HealthBody Body, string Text)> GetAsync(HttpClient client, string path, CancellationToken ct)
    {
        using var response = await client.GetAsync(path, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        var body = System.Text.Json.JsonSerializer.Deserialize<HealthBody>(text, JsonOptions)
                   ?? throw new InvalidOperationException($"{path} returned no body");
        return (response.StatusCode, body, text);
    }

    private static readonly System.Text.Json.JsonSerializerOptions JsonOptions = new(System.Text.Json.JsonSerializerDefaults.Web);

    private sealed record HealthBody(string Status, Dictionary<string, string> Checks);
}
