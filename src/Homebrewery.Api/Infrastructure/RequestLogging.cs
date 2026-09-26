using System.Diagnostics;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// One log entry per request (plan P8.4): <c>Method</c>, <c>Route</c>, <c>StatusCode</c> and <c>ElapsedMs</c>, under
/// the category <c>Homebrewery.Api.Infrastructure.RequestLogging</c> (event <c>RequestFinished</c>, id 1).
/// </summary>
/// <remarks>
/// <para><c>Route</c> is the matched endpoint's route template (<c>/api/brews/edit/{editId}</c>, the SPA fallback
/// <c>/{*path:nonfile}</c>), never the path itself, so edit ids, handles and other values in URLs stay out of the logs.
/// Only requests that no endpoint handles (static files and misses for file-like paths) log their path. Query strings,
/// headers, cookies, bodies, client addresses and user ids are never logged.</para>
/// <para>Every log entry written while the request runs (by any category) gets a <c>RequestId</c> scope, the value
/// problem+json responses return as <c>traceId</c>, so a reported error can be found in the logs.</para>
/// <para>Levels: Error for 5xx responses; Debug for successful health probes (<c>/healthz*</c>) and static files;
/// Information otherwise. Adjust with <c>Logging:LogLevel:Homebrewery.Api.Infrastructure.RequestLogging</c>.</para>
/// <para>Runs first in the app's pipeline, after routing (which <see cref="WebApplication"/> adds in front), so it sees
/// the endpoint before the exception handler clears it and the final status after it has written a 500.</para>
/// </remarks>
public sealed partial class RequestLogging(RequestDelegate next, ILogger<RequestLogging> logger)
{
    /// <summary>Longest path logged for requests without an endpoint; longer ones are cut and end with '…'.</summary>
    public const int MaxPathLength = 200;

    private static readonly Func<ILogger, string, IDisposable?> RequestScope =
        LoggerMessage.DefineScope<string>("RequestId:{RequestId}");

    public async Task InvokeAsync(HttpContext context)
    {
        var started = Stopwatch.GetTimestamp();
        var endpoint = context.GetEndpoint();
        using var scope = RequestScope(logger, RequestIdOf(context));
        var failed = true;
        try
        {
            await next(context);
            failed = false;
        }
        finally
        {
            // An exception that escapes the exception handler (e.g. the response had already started) is a 500 for the
            // log, whatever status the response carries.
            var status = failed ? StatusCodes.Status500InternalServerError : context.Response.StatusCode;
            var route = RouteOf(endpoint ?? context.GetEndpoint(), context.Request);
            var level = LevelFor(status, route, endpoint is not null);
            if (logger.IsEnabled(level))
            {
                LogRequestFinished(logger, level, context.Request.Method, route, status,
                    Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1));
            }
        }
    }

    /// <summary>
    /// The id problem+json responses return as <c>traceId</c> (ProblemDetails uses the same expression): the request's
    /// W3C activity id when the host tracks activities, otherwise <see cref="HttpContext.TraceIdentifier"/>.
    /// </summary>
    internal static string RequestIdOf(HttpContext context) => Activity.Current?.Id ?? context.TraceIdentifier;

    /// <summary>The endpoint's route template, or the (shortened) path when no endpoint handled the request.</summary>
    internal static string RouteOf(Endpoint? endpoint, HttpRequest request)
    {
        if (endpoint is RouteEndpoint { RoutePattern.RawText: { Length: > 0 } template })
        {
            return template.StartsWith('/') ? template : "/" + template;
        }
        var path = request.PathBase.Add(request.Path).Value;
        if (string.IsNullOrEmpty(path)) return "/";
        return path.Length <= MaxPathLength ? path : string.Concat(path.AsSpan(0, MaxPathLength), "…");
    }

    internal static LogLevel LevelFor(int status, string route, bool hasEndpoint)
    {
        if (status >= StatusCodes.Status500InternalServerError) return LogLevel.Error;
        if (status < StatusCodes.Status400BadRequest &&
            (!hasEndpoint || route.StartsWith(HealthEndpoints.Path, StringComparison.Ordinal)))
        {
            return LogLevel.Debug;
        }
        return LogLevel.Information;
    }

    [LoggerMessage(EventId = 1, EventName = "RequestFinished", Message = "{Method} {Route} responded {StatusCode} in {ElapsedMs} ms")]
    private static partial void LogRequestFinished(ILogger logger, LogLevel level, string method, string route, int statusCode, double elapsedMs);
}

public static class RequestLoggingExtensions
{
    /// <summary>Adds <see cref="RequestLogging"/>. Call it first, right after <c>builder.Build()</c>.</summary>
    public static IApplicationBuilder UseRequestLogging(this IApplicationBuilder app) => app.UseMiddleware<RequestLogging>();
}
