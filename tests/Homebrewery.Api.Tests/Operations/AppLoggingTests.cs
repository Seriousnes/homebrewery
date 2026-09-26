using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Console;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Tests.Operations;

/// <summary>
/// Console log format (plan P8.4, docs/operations.md "Logs"): JSON with scopes and UTC timestamps outside Development,
/// the readable simple format in Development, and configuration always wins. The process-level check (real JSON lines
/// on stdout) is in <see cref="MigrateCommandTests"/>; the container check is deploy/scripts/test-external-db.sh.
/// </summary>
public sealed class AppLoggingTests
{
    [Theory]
    [InlineData("Production", "json")]
    [InlineData("Staging", "json")]
    [InlineData("Testing", "json")]
    [InlineData("Development", "simple")]
    public void The_formatter_depends_on_the_environment(string environment, string formatter)
    {
        using var services = Build(environment);

        Assert.Equal(formatter, services.GetRequiredService<IOptionsMonitor<ConsoleLoggerOptions>>().CurrentValue.FormatterName);
    }

    [Fact]
    public void Json_logs_include_scopes_and_utc_timestamps_by_default()
    {
        using var services = Build("Production");

        var options = services.GetRequiredService<IOptionsMonitor<JsonConsoleFormatterOptions>>().CurrentValue;

        Assert.True(options.IncludeScopes);
        Assert.True(options.UseUtcTimestamp);
        Assert.Equal(AppLogging.TimestampFormat, options.TimestampFormat);
        Assert.False(options.JsonWriterOptions.Indented);                  // one object per line
        Assert.Equal("2026-09-25T10:15:30.123Z",
            new DateTimeOffset(2026, 9, 25, 10, 15, 30, 123, TimeSpan.Zero).ToString(AppLogging.TimestampFormat, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Configured_values_win_over_the_defaults()
    {
        using var services = Build("Production", new()
        {
            [AppLogging.FormatterNameKey] = "systemd",
            [$"{AppLogging.FormatterOptionsSection}:IncludeScopes"] = "false",
            [$"{AppLogging.FormatterOptionsSection}:TimestampFormat"] = "HH:mm:ss ",
        });

        Assert.Equal("systemd", services.GetRequiredService<IOptionsMonitor<ConsoleLoggerOptions>>().CurrentValue.FormatterName);
        var json = services.GetRequiredService<IOptionsMonitor<JsonConsoleFormatterOptions>>().CurrentValue;
        Assert.False(json.IncludeScopes);
        Assert.Equal("HH:mm:ss ", json.TimestampFormat);
        Assert.True(json.UseUtcTimestamp);
    }

    [Fact]
    public void Development_can_switch_to_json_too()
    {
        using var services = Build("Development", new() { [AppLogging.FormatterNameKey] = "json" });

        Assert.Equal("json", services.GetRequiredService<IOptionsMonitor<ConsoleLoggerOptions>>().CurrentValue.FormatterName);
    }

    [Fact]
    public void Production_levels_turn_off_request_path_scopes_and_sql_command_logs()
    {
        // The committed appsettings.json (copied next to the tests with the API).
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .Build();
        using var services = new ServiceCollection()
            .AddLogging(b => b.AddConfiguration(configuration.GetSection("Logging")).AddProvider(new LogCapture()))
            .BuildServiceProvider();
        var factory = services.GetRequiredService<ILoggerFactory>();

        Assert.False(factory.CreateLogger("Microsoft.AspNetCore.Hosting.Diagnostics").IsEnabled(LogLevel.Critical));
        Assert.False(factory.CreateLogger("Microsoft.EntityFrameworkCore.Database.Command").IsEnabled(LogLevel.Critical));
        Assert.False(factory.CreateLogger("Microsoft.EntityFrameworkCore.Query").IsEnabled(LogLevel.Information));
        Assert.True(factory.CreateLogger("Microsoft.EntityFrameworkCore.Query").IsEnabled(LogLevel.Warning));
        Assert.True(factory.CreateLogger("Microsoft.EntityFrameworkCore.Migrations").IsEnabled(LogLevel.Information));
        Assert.True(factory.CreateLogger("Homebrewery.Api.Infrastructure.RequestLogging").IsEnabled(LogLevel.Information));
        Assert.False(factory.CreateLogger("Homebrewery.Api.Infrastructure.RequestLogging").IsEnabled(LogLevel.Debug));
        Assert.True(factory.CreateLogger("Microsoft.Hosting.Lifetime").IsEnabled(LogLevel.Information));
        Assert.False(factory.CreateLogger("Microsoft.AspNetCore.Routing.EndpointMiddleware").IsEnabled(LogLevel.Information));
    }

    private static ServiceProvider Build(string environment, Dictionary<string, string?>? settings = null)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings ?? []).Build();
        var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(configuration)
            .AddSingleton<IHostEnvironment>(new TestEnvironment(environment))
            .AddLogging(b => b.AddConfiguration(configuration.GetSection("Logging")).AddConsole());
        services.AddAppLogging();
        return services.BuildServiceProvider();
    }

    private sealed class TestEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Homebrewery.Api";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}

/// <summary>The shared API host (environment Testing) resolves the JSON formatter with the app's defaults.</summary>
[Collection(ApiCollection.Name)]
public sealed class ApiHostLoggingTests(ApiFixture api)
{
    [Fact]
    public void The_test_host_uses_json_console_logs_with_scopes()
    {
        var services = api.Factory.Services;

        Assert.Equal(ConsoleFormatterNames.Json, services.GetRequiredService<IOptionsMonitor<ConsoleLoggerOptions>>().CurrentValue.FormatterName);
        var json = services.GetRequiredService<IOptionsMonitor<JsonConsoleFormatterOptions>>().CurrentValue;
        Assert.True(json.IncludeScopes);
        Assert.True(json.UseUtcTimestamp);
    }
}
