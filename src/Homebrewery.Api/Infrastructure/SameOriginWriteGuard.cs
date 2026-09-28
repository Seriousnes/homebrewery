namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// CSRF defence (plan §8.6): a POST, PUT, PATCH or DELETE must come from this site. Its <c>Origin</c> header, or its
/// <c>Referer</c> when there is no <c>Origin</c>, must have the request's own scheme, host and port; otherwise the
/// request gets 403 problem+json before authentication runs. A request with neither header is refused too, so non-browser
/// clients must send <c>Origin</c>.
/// </summary>
/// <remarks>
/// The request's scheme and host are the ones the browser used: behind a reverse proxy the forwarded-headers middleware applies
/// <c>X-Forwarded-Proto</c> and <c>X-Forwarded-Host</c> first (see <see cref="ForwardedHeadersSetup"/>); through the
/// Vite dev proxy the <c>Host</c> header is kept (<c>changeOrigin: false</c>).
/// </remarks>
public sealed partial class SameOriginWriteGuard(RequestDelegate next, IProblemDetailsService problems, ILogger<SameOriginWriteGuard> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        if (!RateLimits.IsWrite(context.Request.Method) || IsSameOrigin(context.Request))
        {
            await next(context);
            return;
        }

        LogBlocked(context.Request.Method, context.Request.Path, context.Request.Headers.Origin.ToString(),
            context.Request.Headers.Referer.ToString(), $"{context.Request.Scheme}://{context.Request.Host}");
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await problems.WriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            ProblemDetails =
            {
                Status = StatusCodes.Status403Forbidden,
                Title = "Cross-origin request blocked",
                Detail = "Writes must come from this site: the Origin (or Referer) header must match the request's scheme and host.",
            },
        });
    }

    /// <summary>
    /// True when <c>Origin</c> (or, without it, <c>Referer</c>) is an absolute http(s) URL with the request's scheme,
    /// host and port. <c>Origin: null</c>, several values, and a missing header are all refused.
    /// </summary>
    public static bool IsSameOrigin(HttpRequest request)
    {
        var headers = request.Headers;
        var source = headers.Origin.Count > 0 ? headers.Origin : headers.Referer;
        if (source.Count != 1 || !Uri.TryCreate(source[0], UriKind.Absolute, out var claimed)) return false;
        if (claimed.Scheme != Uri.UriSchemeHttp && claimed.Scheme != Uri.UriSchemeHttps) return false;

        if (!request.Host.HasValue
            || !Uri.TryCreate($"{request.Scheme}://{request.Host.ToUriComponent()}/", UriKind.Absolute, out var self))
        {
            return false;
        }

        // Scheme, host (both lower-cased by Uri) and the effective port: http://localhost equals http://localhost:80.
        return Uri.Compare(claimed, self, UriComponents.Scheme | UriComponents.Host | UriComponents.StrongPort,
            UriFormat.UriEscaped, StringComparison.OrdinalIgnoreCase) == 0;
    }

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Blocked cross-origin {Method} {Path}: Origin '{Origin}', Referer '{Referer}', expected {Expected}.")]
    private partial void LogBlocked(string method, PathString path, string origin, string referer, string expected);
}
