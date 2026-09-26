using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Data Protection keys, which encrypt the sign-in cookies (plan §8.6, P8 hardening). Without a persistent key ring a
/// production container makes new keys whenever it is re-created, and every sign-in is lost.
/// </summary>
/// <remarks>
/// <para><c>DataProtection:KeysPath</c> (env <c>DataProtection__KeysPath</c>) is a directory for the key ring
/// (relative paths resolve against the content root). The production image sets it to
/// <c>/var/lib/homebrewery/keys</c>, which must be a volume. When the path is set, startup fails unless a key can be
/// created or read there, so a read-only or missing mount stops the container instead of silently losing sign-ins.
/// Without it, ASP.NET Core's default location is used (<c>~/.aspnet/DataProtection-Keys</c> on Linux, which the dev
/// compose stack keeps in its <c>aspnet-keys</c> volume; <c>%LOCALAPPDATA%\ASP.NET\DataProtection-Keys</c> on
/// Windows).</para>
/// <para>The application name is fixed to <see cref="ApplicationName"/>, so keys (and cookies) do not depend on the
/// install path. Keys are stored unencrypted at rest on Linux (ASP.NET Core logs a warning about that); protect the
/// volume like the database. Microsoft.AspNetCore.DataProtection.EntityFrameworkCore (keys in PostgreSQL) would avoid
/// the volume but is not a dependency yet.</para>
/// </remarks>
public static partial class DataProtectionSetup
{
    public const string KeysPathKey = "DataProtection:KeysPath";

    /// <summary>The Data Protection application discriminator: keys are shared by every instance of the app.</summary>
    public const string ApplicationName = "Homebrewery";

    public static IServiceCollection AddPersistentDataProtection(this IServiceCollection services)
    {
        services.AddDataProtection().SetApplicationName(ApplicationName);

        // Like PersistKeysToFileSystem, but the path is read from configuration when the options are built, so test
        // hosts (WebApplicationFactory settings) can supply it.
        services.AddSingleton<IConfigureOptions<KeyManagementOptions>>(sp =>
        {
            var directory = KeysDirectory(sp.GetRequiredService<IConfiguration>(), sp.GetRequiredService<IHostEnvironment>());
            var loggers = sp.GetRequiredService<ILoggerFactory>();
            return new ConfigureOptions<KeyManagementOptions>(o =>
            {
                if (directory is not null) o.XmlRepository = new FileSystemXmlRepository(directory, loggers);
            });
        });
        services.AddHostedService<KeyRingCheck>();
        return services;
    }

    /// <summary>The configured key directory (<see cref="KeysPathKey"/>), or null for ASP.NET Core's default location.</summary>
    public static DirectoryInfo? KeysDirectory(IConfiguration configuration, IHostEnvironment environment)
    {
        var path = configuration[KeysPathKey];
        return string.IsNullOrWhiteSpace(path) ? null : new DirectoryInfo(Path.GetFullPath(path, environment.ContentRootPath));
    }

    /// <summary>
    /// Protects and unprotects a value before the server starts when <see cref="KeysPathKey"/> is set: the first run
    /// creates the key ring there, later runs read it, and an unusable directory stops startup with a clear message.
    /// </summary>
    private sealed partial class KeyRingCheck(
        IDataProtectionProvider provider, IConfiguration configuration, IHostEnvironment environment, ILogger<KeyRingCheck> logger)
        : IHostedLifecycleService
    {
        public Task StartingAsync(CancellationToken cancellationToken)
        {
            if (KeysDirectory(configuration, environment) is not { } directory) return Task.CompletedTask;
            try
            {
                var protector = provider.CreateProtector("Homebrewery.KeyRingCheck");
                if (protector.Unprotect(protector.Protect("ok")) != "ok") throw new InvalidOperationException("the round trip changed the value");
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    $"Data Protection keys cannot be created or read in '{directory.FullName}' ({KeysPathKey}). Mount a " +
                    "writable volume there (sign-ins are encrypted with these keys), or unset the setting.", ex);
            }

            LogKeyRing(directory.FullName);
            return Task.CompletedTask;
        }

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        [LoggerMessage(Level = LogLevel.Information, Message = "Data Protection keys are kept in {Directory}.")]
        private partial void LogKeyRing(string directory);
    }
}
