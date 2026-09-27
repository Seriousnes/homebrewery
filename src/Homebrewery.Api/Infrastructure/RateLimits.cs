using System.Globalization;
using System.Net;
using System.Threading.RateLimiting;
using Homebrewery.Api.Infrastructure.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Rate limits (plan §8.1). Every limit is a fixed window per partition, configured under <c>RateLimits</c>
/// (<see cref="RateLimitSettings"/>):
/// <list type="bullet">
/// <item><see cref="Auth"/>: the <c>/api/auth/*</c> endpoints (login, register, password reset, …), per client IP.</item>
/// <item><see cref="Import"/>: the upstream import proxy, per signed-in user.</item>
/// <item><see cref="Pdf"/>: PDF export (<c>POST /api/export/pdf</c>), per signed-in user or, signed out, per client IP.</item>
/// <item>A global limiter for writes (POST, PUT, PATCH, DELETE) on every path, per client IP.</item>
/// </list>
/// A rejected request gets 429 problem+json with a <c>Retry-After</c> header. The client IP is the connection's
/// remote address, which the forwarded-headers middleware sets from <c>X-Forwarded-For</c> behind Caddy.
/// </summary>
public static class RateLimits
{
    /// <summary>Endpoint policy for the Identity endpoints (<c>/api/auth/*</c>).</summary>
    public const string Auth = "auth";

    /// <summary>Endpoint policy for <c>GET /api/import/homebrewery/{shareId}</c>.</summary>
    public const string Import = "import";

    /// <summary>Endpoint policy for <c>POST /api/export/pdf</c>.</summary>
    public const string Pdf = "pdf";

    /// <summary>Configuration section of <see cref="RateLimitSettings"/>.</summary>
    public const string SectionName = "RateLimits";

    public static IServiceCollection AddRateLimits(this IServiceCollection services)
    {
        services.AddOptions<RateLimitSettings>().BindConfiguration(SectionName).Validate(
            s => s.Auth.IsValid && s.Import.IsValid && s.Pdf.IsValid && s.Writes.IsValid,
            "RateLimits: every PermitLimit must be at least 1 and every Window positive.").ValidateOnStart();
        services.AddRateLimiter(_ => { });
        services.AddOptions<RateLimiterOptions>().Configure<IOptions<RateLimitSettings>>((o, s) => Configure(o, s.Value));
        return services;
    }

    /// <summary>Adds the policies, the global write limiter and the 429 response to <paramref name="options"/>.</summary>
    public static void Configure(RateLimiterOptions options, RateLimitSettings settings)
    {
        options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        options.OnRejected = WriteRejectionAsync;

        options.AddPolicy(Auth, context =>
            RateLimitPartition.GetFixedWindowLimiter(ClientIp(context), _ => settings.Auth.ToOptions()));

        options.AddPolicy(Import, context =>
            RateLimitPartition.GetFixedWindowLimiter(
                context.User.GetUserId() is { } id ? "user:" + id.ToString("N") : ClientIp(context),
                _ => settings.Import.ToOptions()));

        options.AddPolicy(Pdf, context =>
            RateLimitPartition.GetFixedWindowLimiter(
                context.User.GetUserId() is { } id ? "user:" + id.ToString("N") : ClientIp(context),
                _ => settings.Pdf.ToOptions()));

        options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
            IsWrite(context.Request.Method)
                ? RateLimitPartition.GetFixedWindowLimiter(ClientIp(context), _ => settings.Writes.ToOptions())
                : RateLimitPartition.GetNoLimiter(""));
    }

    /// <summary>POST, PUT, PATCH and DELETE.</summary>
    public static bool IsWrite(string method) =>
        HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);

    private static string ClientIp(HttpContext context) =>
        context.Connection.RemoteIpAddress is { } ip
            ? "ip:" + (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip)
            : "ip:" + IPAddress.None;

    private static async ValueTask WriteRejectionAsync(OnRejectedContext context, CancellationToken ct)
    {
        var http = context.HttpContext;
        string? detail = null;
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            var seconds = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds));
            http.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
            detail = $"Try again in {seconds} second{(seconds == 1 ? "" : "s")}.";
        }

        var problems = http.RequestServices.GetRequiredService<IProblemDetailsService>();
        await problems.WriteAsync(new ProblemDetailsContext
        {
            HttpContext = http,
            ProblemDetails =
            {
                Status = StatusCodes.Status429TooManyRequests,
                Title = "Too many requests",
                Detail = detail,
            },
        });
    }
}

/// <summary>Limits under the <c>RateLimits</c> configuration section, e.g. <c>RateLimits__Writes__PermitLimit=300</c>.</summary>
public sealed class RateLimitSettings
{
    /// <summary>Per client IP on <c>/api/auth/*</c>. Default: 20 per minute.</summary>
    public WindowLimit Auth { get; set; } = new() { PermitLimit = 20, Window = TimeSpan.FromMinutes(1) };

    /// <summary>Per user on the import proxy. Default: 10 per minute.</summary>
    public WindowLimit Import { get; set; } = new() { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) };

    /// <summary>Per user on PDF export, per client IP for anonymous callers. Default: 10 per minute.</summary>
    public WindowLimit Pdf { get; set; } = new() { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) };

    /// <summary>Per client IP for every POST, PUT, PATCH and DELETE. Default: 120 per minute.</summary>
    public WindowLimit Writes { get; set; } = new() { PermitLimit = 120, Window = TimeSpan.FromMinutes(1) };
}

/// <summary>A fixed window: at most <see cref="PermitLimit"/> requests per <see cref="Window"/>.</summary>
public sealed class WindowLimit
{
    public int PermitLimit { get; set; }

    /// <summary>For example <c>00:01:00</c>.</summary>
    public TimeSpan Window { get; set; }

    internal bool IsValid => PermitLimit >= 1 && Window > TimeSpan.Zero;

    internal FixedWindowRateLimiterOptions ToOptions() => new()
    {
        PermitLimit = PermitLimit,
        Window = Window,
        QueueLimit = 0,
        AutoReplenishment = true,
    };
}
