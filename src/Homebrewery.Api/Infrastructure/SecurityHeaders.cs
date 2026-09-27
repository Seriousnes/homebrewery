using System.Net;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Infrastructure;

/// <summary>How the Content-Security-Policy is sent (<see cref="SecurityHeadersSettings.Csp"/>).</summary>
public enum CspMode
{
    /// <summary><c>Content-Security-Policy</c>: the browser blocks what the policy does not allow.</summary>
    Enforce,

    /// <summary><c>Content-Security-Policy-Report-Only</c>: the browser only reports (console, report URI).</summary>
    ReportOnly,

    /// <summary>No CSP header (the other security headers are still sent).</summary>
    Off,
}

/// <summary>
/// Configuration section <c>SecurityHeaders</c> (P8.3).
/// </summary>
public sealed class SecurityHeadersSettings
{
    public const string SectionName = "SecurityHeaders";

    /// <summary>
    /// <c>SecurityHeaders:Csp</c>: Enforce, ReportOnly or Off. Unset means Enforce, except in Development, where the
    /// page comes from the Vite dev server (its React refresh preamble is an inline script) and the default is Off.
    /// </summary>
    public CspMode? Csp { get; set; }

    /// <summary>
    /// <c>SecurityHeaders:CspReportUri</c>: an absolute https URL or a site path (<c>/…</c>) that browsers POST
    /// violation reports to (<c>report-uri</c>). Unset: no reports.
    /// </summary>
    public string? CspReportUri { get; set; }

    /// <summary><c>SecurityHeaders:HstsMaxAge</c> (default 365 days). Sent only on HTTPS responses to a non-loopback host.</summary>
    public TimeSpan HstsMaxAge { get; set; } = TimeSpan.FromDays(365);

    /// <summary><c>SecurityHeaders:HstsIncludeSubDomains</c> (default false): only when every subdomain serves HTTPS.</summary>
    public bool HstsIncludeSubDomains { get; set; }

    internal bool HasValidReportUri =>
        CspReportUri is null
        || (CspReportUri.Length is > 0 and <= 512
            && !CspReportUri.Any(c => char.IsWhiteSpace(c) || char.IsControl(c) || c is ';' or ',' or '\'' or '"')
            && ((CspReportUri.StartsWith('/') && !CspReportUri.StartsWith("//", StringComparison.Ordinal))
                || (Uri.TryCreate(CspReportUri, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)));
}

/// <summary>
/// Security headers on every response the API host sends (plan §11 P8.3): the SPA and its static files, the share shell
/// (<see cref="ShareShell"/>), the API and error responses. They are added when the response starts, so endpoints,
/// static files, the exception handler and status-code pages all get them; a header an endpoint set itself is kept.
/// </summary>
/// <remarks>
/// <para>Pages (everything outside <c>/api</c>, <c>/openapi</c> and <c>/healthz</c>) get <see cref="DocumentPolicy"/>:
/// scripts only from this origin (no inline scripts, no eval); images and fonts from this origin, https: and data:
/// URIs; styles from this origin plus inline <c>&lt;style&gt;</c> elements and <c>style</c> attributes, which TipTap,
/// CodeMirror, ProseMirror's DOM serializer and the import probe need (brew and theme CSS go through constructed
/// stylesheets, which CSP does not govern); fetches to this origin and https: (user CSS <c>@import</c>s are inlined
/// with fetch). API responses are never pages and get <see cref="ApiPolicy"/>, which allows nothing.</para>
/// <para>On HTTPS (after forwarded headers) pages also get <c>upgrade-insecure-requests</c>, and every response
/// <c>Strict-Transport-Security</c> unless the host is a loopback name (a developer's https://localhost).</para>
/// </remarks>
public static class SecurityHeaders
{
    /// <summary>Configuration key of <see cref="SecurityHeadersSettings.Csp"/>.</summary>
    public const string CspKey = $"{SecurityHeadersSettings.SectionName}:{nameof(SecurityHeadersSettings.Csp)}";

    /// <summary>The CSP of pages (the SPA, the share shell, static files).</summary>
    public static readonly string DocumentPolicy = string.Join("; ",
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: data: blob:",
        "font-src 'self' https: data:",
        "connect-src 'self' https:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'");

    /// <summary>The CSP of API responses: JSON is never rendered, so nothing may load and nothing may frame it.</summary>
    public const string ApiPolicy = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    /// <summary>
    /// Browser features the app never uses, switched off for this origin and every frame. Only names Chromium knows:
    /// an unknown one is a console error there.
    /// </summary>
    public const string PermissionsPolicy =
        "accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), "
        + "magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()";

    public const string ReferrerPolicy = "strict-origin-when-cross-origin";

    public const string CrossOriginOpenerPolicy = "same-origin";

    /// <summary>Hosts that never get HSTS (like ASP.NET Core's HstsOptions.ExcludedHosts).</summary>
    private static readonly string[] LoopbackHosts = ["localhost", "127.0.0.1", "[::1]"];

    public static IServiceCollection AddSecurityHeaders(this IServiceCollection services)
    {
        services.AddOptions<SecurityHeadersSettings>()
            .BindConfiguration(SecurityHeadersSettings.SectionName)
            .Validate(s => s.HasValidReportUri,
                $"{SecurityHeadersSettings.SectionName}:{nameof(SecurityHeadersSettings.CspReportUri)} must be an absolute https URL or a path starting with '/', without spaces, quotes, ';' or ','.")
            .Validate(s => s.HstsMaxAge >= TimeSpan.Zero,
                $"{SecurityHeadersSettings.SectionName}:{nameof(SecurityHeadersSettings.HstsMaxAge)} must not be negative.")
            .ValidateOnStart();
        services.AddSingleton<SecurityHeaderValues>();
        // No "Server: Kestrel" header: it only tells scanners what to try.
        services.Configure<KestrelServerOptions>(o => o.AddServerHeader = false);
        return services;
    }

    /// <summary>Adds the headers to every response of the rest of the pipeline. Call it first.</summary>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) =>
        app.UseMiddleware<SecurityHeadersMiddleware>();

    /// <summary>Paths whose responses are data, not pages: <c>/api</c>, <c>/openapi</c> and <c>/healthz</c>.</summary>
    public static bool IsApiPath(PathString path) =>
        path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)
        || path.StartsWithSegments("/openapi", StringComparison.OrdinalIgnoreCase)
        || path.StartsWithSegments("/healthz", StringComparison.OrdinalIgnoreCase);

    internal static bool IsLoopbackHost(HostString host)
    {
        if (!host.HasValue) return true;
        var name = host.Host;
        if (LoopbackHosts.Any(h => string.Equals(h, name, StringComparison.OrdinalIgnoreCase))) return true;
        return IPAddress.TryParse(name.Trim('[', ']'), out var ip) && IPAddress.IsLoopback(ip);
    }
}

/// <summary>The header values, computed once from <see cref="SecurityHeadersSettings"/>.</summary>
internal sealed class SecurityHeaderValues
{
    public SecurityHeaderValues(IOptions<SecurityHeadersSettings> options, IHostEnvironment environment)
    {
        var settings = options.Value;
        Mode = settings.Csp ?? (environment.IsDevelopment() ? CspMode.Off : CspMode.Enforce);
        CspHeader = Mode == CspMode.ReportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

        var report = settings.CspReportUri is { } uri ? $"; report-uri {uri}" : "";
        Document = SecurityHeaders.DocumentPolicy + report;
        DocumentHttps = SecurityHeaders.DocumentPolicy + "; upgrade-insecure-requests" + report;
        Api = SecurityHeaders.ApiPolicy + report;

        var maxAge = (long)settings.HstsMaxAge.TotalSeconds;
        Hsts = settings.HstsIncludeSubDomains ? $"max-age={maxAge}; includeSubDomains" : $"max-age={maxAge}";
    }

    public CspMode Mode { get; }
    public string CspHeader { get; }
    public string Document { get; }
    public string DocumentHttps { get; }
    public string Api { get; }
    public string Hsts { get; }
}

internal sealed class SecurityHeadersMiddleware(RequestDelegate next, SecurityHeaderValues values)
{
    public Task InvokeAsync(HttpContext context)
    {
        context.Response.OnStarting(static state =>
        {
            var (ctx, v) = ((HttpContext, SecurityHeaderValues))state;
            Apply(ctx, v);
            return Task.CompletedTask;
        }, (context, values));
        return next(context);
    }

    private static void Apply(HttpContext context, SecurityHeaderValues values)
    {
        var request = context.Request;
        var headers = context.Response.Headers;
        var api = SecurityHeaders.IsApiPath(request.Path);

        if (values.Mode != CspMode.Off
            && !headers.ContainsKey("Content-Security-Policy")
            && !headers.ContainsKey("Content-Security-Policy-Report-Only"))
        {
            headers[values.CspHeader] = api ? values.Api : request.IsHttps ? values.DocumentHttps : values.Document;
        }

        headers.TryAdd("X-Content-Type-Options", "nosniff");
        headers.TryAdd("Referrer-Policy", SecurityHeaders.ReferrerPolicy);
        headers.TryAdd("Permissions-Policy", SecurityHeaders.PermissionsPolicy);
        headers.TryAdd("Cross-Origin-Opener-Policy", SecurityHeaders.CrossOriginOpenerPolicy);
        headers.TryAdd("X-Frame-Options", "DENY");                     // frame-ancestors 'none' for browsers without CSP 2
        if (api)
        {
            // Data for this site's scripts only: no other site may embed it (Spectre-style reads), and responses that
            // did not choose their own caching (private brews, the account, admin data) are not stored anywhere.
            headers.TryAdd("Cross-Origin-Resource-Policy", "same-origin");
            if (!headers.ContainsKey("Cache-Control")) headers.CacheControl = "no-store";
        }

        if (request.IsHttps && !SecurityHeaders.IsLoopbackHost(request.Host))
        {
            headers.TryAdd("Strict-Transport-Security", values.Hsts);
        }
    }
}
