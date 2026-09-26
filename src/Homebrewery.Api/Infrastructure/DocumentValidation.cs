using Homebrewery.Core.Documents;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Registers <see cref="SchemaManifest"/>, <see cref="RawHtmlSanitizer"/> and <see cref="DocInspector"/> (plan §8.5)
/// and loads the manifest while the host starts, so a missing or unusable manifest stops the server instead of
/// failing the first save.
/// </summary>
public static partial class DocumentValidation
{
    /// <summary>
    /// Optional path of <c>schema-manifest.json</c>; relative paths are resolved against the content root.
    /// Default: the copy the build places next to the binaries.
    /// </summary>
    public const string ManifestPathKey = "Schema:ManifestPath";

    public static IServiceCollection AddDocumentValidation(this IServiceCollection services)
    {
        services.AddSingleton(sp => SchemaManifest.Load(ResolveManifestPath(
            sp.GetRequiredService<IConfiguration>(), sp.GetRequiredService<IHostEnvironment>())));
        services.AddSingleton<RawHtmlSanitizer>();
        services.AddSingleton<DocInspector>();
        services.AddHostedService<SchemaManifestCheck>();
        return services;
    }

    public static string ResolveManifestPath(IConfiguration configuration, IHostEnvironment environment)
    {
        var configured = configuration[ManifestPathKey];
        return string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(AppContext.BaseDirectory, SchemaManifest.FileName)
            : Path.GetFullPath(configured, environment.ContentRootPath);
    }

    /// <summary>Loads the manifest before the server accepts requests.</summary>
    private sealed partial class SchemaManifestCheck(IServiceProvider services, ILogger<SchemaManifestCheck> logger)
        : IHostedLifecycleService
    {
        public Task StartingAsync(CancellationToken cancellationToken)
        {
            var manifest = services.GetRequiredService<DocInspector>().Manifest;
            LogLoaded(manifest.DocSchemaVersion, manifest.Nodes.Count, manifest.Marks.Count);
            return Task.CompletedTask;
        }

        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        [LoggerMessage(Level = LogLevel.Information,
            Message = "Schema manifest loaded: document schema version {DocSchemaVersion}, {Nodes} node types, {Marks} mark types.")]
        private partial void LogLoaded(int docSchemaVersion, int nodes, int marks);
    }
}
