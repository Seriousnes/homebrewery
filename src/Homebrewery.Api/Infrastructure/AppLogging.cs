using Microsoft.Extensions.Logging.Console;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Structured console logs (plan P8.4).
/// </summary>
/// <remarks>
/// <list type="bullet">
/// <item>Outside Development the console writes one JSON object per line (<c>Timestamp</c> in UTC ISO 8601,
/// <c>EventId</c>, <c>LogLevel</c>, <c>Category</c>, <c>Message</c>, <c>State</c>, <c>Scopes</c>). Development keeps
/// ASP.NET Core's readable <c>simple</c> format.</item>
/// <item>Everything stays configurable through the standard keys, so the environment wins over these defaults:
/// <c>Logging:Console:FormatterName</c> (<c>json</c>, <c>simple</c> or <c>systemd</c>),
/// <c>Logging:Console:FormatterOptions:*</c> (e.g. <c>IncludeScopes</c>, <c>TimestampFormat</c>) and
/// <c>Logging:LogLevel:*</c>, e.g. <c>Logging__LogLevel__Default=Debug</c>.</item>
/// <item>Requests are logged by <see cref="RequestLogging"/> (method, route template, status, duration), not by the
/// hosting diagnostics, whose scope carries the raw request path. appsettings.json therefore turns
/// <c>Microsoft.AspNetCore.Hosting.Diagnostics</c> off (<c>None</c>: at any other level it adds that scope to every
/// entry), also under <c>Logging:EventLog</c>, because on Windows the host's Event Log provider has a provider rule of
/// its own that would switch it back on. Set levels under <c>Logging:LogLevel</c>, not <c>Logging:Console:LogLevel</c>,
/// for the same reason. EF Core's SQL command log is off as well (<c>Microsoft.EntityFrameworkCore.Database.Command</c> at
/// <c>None</c>; the rest of EF Core logs warnings and errors).</item>
/// </list>
/// </remarks>
public static class AppLogging
{
    /// <summary>Configuration key of the console formatter (<see cref="ConsoleLoggerOptions.FormatterName"/>).</summary>
    public const string FormatterNameKey = "Logging:Console:FormatterName";

    /// <summary>Configuration section of the formatter options; explicit values here override the defaults below.</summary>
    public const string FormatterOptionsSection = "Logging:Console:FormatterOptions";

    /// <summary>UTC timestamps with milliseconds, e.g. <c>2026-09-25T10:15:30.123Z</c>.</summary>
    public const string TimestampFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

    /// <summary>
    /// JSON console logs outside Development (unless <see cref="FormatterNameKey"/> is set), with scopes and UTC
    /// timestamps. Registered after the web host's logging defaults, so these run after the configuration binding
    /// and then re-apply <see cref="FormatterOptionsSection"/>: configured values always win.
    /// </summary>
    public static IServiceCollection AddAppLogging(this IServiceCollection services)
    {
        services.AddOptions<ConsoleLoggerOptions>().Configure<IHostEnvironment>((o, environment) =>
            o.FormatterName ??= environment.IsDevelopment() ? ConsoleFormatterNames.Simple : ConsoleFormatterNames.Json);

        services.AddOptions<JsonConsoleFormatterOptions>().Configure<IConfiguration>((o, configuration) =>
        {
            o.IncludeScopes = true;
            o.UseUtcTimestamp = true;
            o.TimestampFormat = TimestampFormat;
            configuration.GetSection(FormatterOptionsSection).Bind(o);
        });
        return services;
    }
}
