using Homebrewery.Data;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// The <c>/healthz</c> database check (plan P8.4): runs <c>SELECT 1</c> on the app's own <see cref="AppDbContext"/>
/// connection within <see cref="Timeout"/>. A failure makes <c>/healthz</c> answer 503; the exception is logged by the
/// health check service, never returned.
/// </summary>
public sealed class DatabaseHealthCheck(IServiceScopeFactory scopes) : IHealthCheck
{
    public const string Name = "database";

    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await db.Database.ExecuteSqlRawAsync("SELECT 1", cancellationToken);
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            return new HealthCheckResult(context.Registration.FailureStatus, "The database did not answer SELECT 1.", ex);
        }
    }
}

public static class HealthEndpoints
{
    /// <summary>Every check (today only <see cref="DatabaseHealthCheck"/>). The compose health checks use it.</summary>
    public const string Path = "/healthz";

    /// <summary>Liveness: runs no checks, so it answers 200 while the process serves HTTP (a database outage is not a
    /// reason to restart the app).</summary>
    public const string LivePath = "/healthz/live";

    /// <summary>Readiness: the checks tagged <see cref="ReadyTag"/> (the database), i.e. whether requests can be served.</summary>
    public const string ReadyPath = "/healthz/ready";

    /// <summary>Tag of the checks behind <see cref="ReadyPath"/>.</summary>
    public const string ReadyTag = "ready";

    /// <summary>Registers the health checks behind <see cref="Path"/>: <see cref="DatabaseHealthCheck"/>.</summary>
    public static IServiceCollection AddAppHealthChecks(this IServiceCollection services)
    {
        services.AddHealthChecks().Add(new HealthCheckRegistration(
            DatabaseHealthCheck.Name,
            sp => ActivatorUtilities.CreateInstance<DatabaseHealthCheck>(sp),
            failureStatus: HealthStatus.Unhealthy,
            tags: [ReadyTag],
            timeout: DatabaseHealthCheck.Timeout));
        return services;
    }

    /// <summary>
    /// <c>GET /healthz</c> (every check), <c>/healthz/live</c> (none) and <c>/healthz/ready</c> (tagged
    /// <see cref="ReadyTag"/>): 200 <c>{"status":"ok","checks":{"database":"ok"}}</c> when healthy, else 503 with the
    /// failing check's status (<c>"unhealthy"</c>). Only statuses are returned, no exception text. The returned builder
    /// applies conventions to all three endpoints.
    /// </summary>
    public static IEndpointConventionBuilder MapAppHealthChecks(this IEndpointRouteBuilder app) =>
        new AllEndpoints(
        [
            app.MapHealthChecks(Path, Options(_ => true)),
            app.MapHealthChecks(LivePath, Options(_ => false)),
            app.MapHealthChecks(ReadyPath, Options(r => r.Tags.Contains(ReadyTag))),
        ]);

    private static HealthCheckOptions Options(Func<HealthCheckRegistration, bool> predicate) => new()
    {
        Predicate = predicate,
        ResponseWriter = (ctx, report) => ctx.Response.WriteAsJsonAsync(new
        {
            status = StatusText(report.Status),
            checks = report.Entries.ToDictionary(e => e.Key, e => StatusText(e.Value.Status), StringComparer.Ordinal),
        }),
    };

    private static string StatusText(HealthStatus status) =>
        status == HealthStatus.Healthy ? "ok" : status.ToString().ToLowerInvariant();

    private sealed class AllEndpoints(IReadOnlyList<IEndpointConventionBuilder> builders) : IEndpointConventionBuilder
    {
        public void Add(Action<EndpointBuilder> convention)
        {
            foreach (var builder in builders) builder.Add(convention);
        }

        public void Finally(Action<EndpointBuilder> finallyConvention)
        {
            foreach (var builder in builders) builder.Finally(finallyConvention);
        }
    }
}
