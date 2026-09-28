using Microsoft.AspNetCore.OpenApi;

namespace Homebrewery.Api.Themes;

/// <summary>
/// Registers the theme services (plan §8.7) and loads <see cref="ThemeCatalog"/> while the host starts, so a missing
/// or broken catalog stops the server instead of failing the first request.
/// </summary>
/// <remarks>
/// Where the catalog comes from:
/// <list type="number">
/// <item><c>Themes:CatalogPath</c> when set (relative paths resolve against the content root). Tests point it at a
/// committed copy.</item>
/// <item>Otherwise <c>{web root}/themes/themes.json</c>, which the web build (<c>pnpm run build</c>) writes.</item>
/// <item>Outside Production only, when that file does not exist: the theme sources, <c>themes/V3/*/settings.json</c>
/// (<c>Themes:SourcePath</c>, default: a <c>themes</c> folder in the content root or up to three levels above it). This
/// keeps <c>docker compose up</c> and <c>dotnet run</c> working without a web build; Vite serves the theme files in
/// development.</item>
/// </list>
/// A configured <c>Themes:CatalogPath</c> that does not exist is always an error.
/// </remarks>
public static partial class ThemeCatalogSetup
{
    /// <summary>Optional path of <c>themes.json</c>.</summary>
    public const string CatalogPathKey = "Themes:CatalogPath";

    /// <summary>Optional path of the repository's <c>themes/</c> folder, for the development fallback.</summary>
    public const string SourcePathKey = "Themes:SourcePath";

    public static IServiceCollection AddThemes(this IServiceCollection services)
    {
        services.AddSingleton(sp => LoadCatalog(
            sp.GetRequiredService<IConfiguration>(),
            sp.GetRequiredService<IWebHostEnvironment>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(ThemeCatalog))));
        services.AddScoped<ThemeService>();
        services.AddHostedService<ThemeCatalogCheck>();
        services.ConfigureAll<OpenApiOptions>(o => o.AddDocumentTransformer<ThemeBundleDocumentTransformer>());
        return services;
    }

    /// <summary>The <c>themes.json</c> path the host uses (see the class remarks).</summary>
    public static string ResolveCatalogPath(IConfiguration configuration, IWebHostEnvironment environment)
    {
        var configured = configuration[CatalogPathKey];
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured, environment.ContentRootPath);

        // WebRootPath is null when the wwwroot folder does not exist.
        var webRoot = environment.WebRootPath ?? Path.Combine(environment.ContentRootPath, "wwwroot");
        return Path.Combine(webRoot, "themes", "themes.json");
    }

    internal static ThemeCatalog LoadCatalog(IConfiguration configuration, IWebHostEnvironment environment, ILogger logger)
    {
        var path = ResolveCatalogPath(configuration, environment);
        if (File.Exists(path) || !string.IsNullOrWhiteSpace(configuration[CatalogPathKey]) || environment.IsProduction())
        {
            return ThemeCatalog.Load(path);
        }

        var sources = FindThemeSources(configuration, environment)
                      ?? throw new FileNotFoundException(
                          $"Theme catalog not found: {path}. Run the web build (pnpm -C web run build), set " +
                          $"{CatalogPathKey}, or set {SourcePathKey} to the repository's themes folder.", path);
        var catalog = ThemeCatalog.FromThemeSources(sources);
        LogFallback(logger, path, sources);
        return catalog;
    }

    private static string? FindThemeSources(IConfiguration configuration, IWebHostEnvironment environment)
    {
        var configured = configuration[SourcePathKey];
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured, environment.ContentRootPath);

        var dir = new DirectoryInfo(environment.ContentRootPath);
        for (var level = 0; dir is not null && level <= 3; level++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "themes");
            if (Directory.Exists(Path.Combine(candidate, ThemeCatalog.Renderer))) return candidate;
        }

        return null;
    }

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Theme catalog {Path} not found; built it from the theme sources in {Sources} (development fallback). Run the web build to use the generated catalog.")]
    private static partial void LogFallback(ILogger logger, string path, string sources);

    /// <summary>Loads the catalog before the server accepts requests.</summary>
    private sealed partial class ThemeCatalogCheck(IServiceProvider services, ILogger<ThemeCatalogCheck> logger)
        : IHostedLifecycleService
    {
        public Task StartingAsync(CancellationToken cancellationToken)
        {
            var catalog = services.GetRequiredService<ThemeCatalog>();
            LogLoaded(catalog.Themes.Count, string.Join(", ", catalog.Themes.Select(t => t.Key)), catalog.Source);
            return Task.CompletedTask;
        }

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        [LoggerMessage(Level = LogLevel.Information, Message = "Theme catalog loaded: {Count} themes ({Keys}) from {Source}.")]
        private partial void LogLoaded(int count, string keys, string source);
    }
}
