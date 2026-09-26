using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core.Documents;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>P2.4: the host loads the schema manifest at startup (Schema:ManifestPath or the copy next to the binaries).</summary>
[Collection(ApiCollection.Name)]
public sealed class DocumentValidationStartupTests(ApiFixture api)
{
    [Fact]
    public void The_host_uses_the_manifest_next_to_the_binaries_by_default()
    {
        var manifest = api.Factory.Services.GetRequiredService<SchemaManifest>();

        Assert.Same(manifest, api.Factory.Services.GetRequiredService<DocInspector>().Manifest);
        Assert.Contains("page", manifest.Nodes.Keys);
    }

    [Fact]
    public async Task A_missing_manifest_stops_the_host()
    {
        var missing = Path.Combine(Path.GetTempPath(), $"no-manifest-{Guid.NewGuid():N}.json");
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(DocumentValidation.ManifestPathKey, missing));

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains(missing, error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_configured_manifest_path_is_used()
    {
        var directory = Directory.CreateTempSubdirectory("manifest-");
        try
        {
            var path = Path.Combine(directory.FullName, "custom.json");
            File.Copy(Path.Combine(AppContext.BaseDirectory, SchemaManifest.FileName), path);
            await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(DocumentValidation.ManifestPathKey, path));

            var manifest = host.Services.GetRequiredService<SchemaManifest>();

            Assert.Equal(TestDocs.Manifest.Nodes.Keys.Order(), manifest.Nodes.Keys.Order());
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }
}
