using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Api.Themes;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests.Themes;

/// <summary>
/// P2.5: the host loads the theme catalog at startup: Themes:CatalogPath, else wwwroot/themes/themes.json, else (outside
/// Production) the theme sources. A missing catalog stops the host.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ThemeStartupTests(ApiFixture api)
{
    [Fact]
    public void The_test_host_uses_the_configured_fixture()
    {
        var catalog = api.Factory.Services.GetRequiredService<ThemeCatalog>();

        Assert.Equal(HomebreweryApiFactory.ThemeCatalogFixture, catalog.Source);
        Assert.Equal(5, catalog.Themes.Count);
    }

    [Fact]
    public async Task A_missing_configured_catalog_stops_the_host()
    {
        var missing = Path.Combine(Path.GetTempPath(), $"no-themes-{Guid.NewGuid():N}.json");
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(ThemeCatalogSetup.CatalogPathKey, missing));

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains(missing, error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_broken_catalog_stops_the_host()
    {
        var directory = Directory.CreateTempSubdirectory("themes-");
        try
        {
            var path = Path.Combine(directory.FullName, "themes.json");
            await File.WriteAllTextAsync(path, """{"themes":[{"key":"A","name":"A","renderer":"V3","baseTheme":"Nope","style":"/a.css","scopedStyle":"/a.scoped.css"}]}""",
                TestContext.Current.CancellationToken);
            await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(ThemeCatalogSetup.CatalogPathKey, path));

            var error = Assert.ThrowsAny<Exception>(() => host.Services);

            Assert.Contains("unknown base theme 'Nope'", error.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task The_web_root_catalog_is_the_default()
    {
        var webRoot = Directory.CreateTempSubdirectory("wwwroot-");
        try
        {
            Directory.CreateDirectory(Path.Combine(webRoot.FullName, "themes"));
            var path = Path.Combine(webRoot.FullName, "themes", "themes.json");
            File.Copy(HomebreweryApiFactory.ThemeCatalogFixture, path);
            await using var host = api.Factory.WithWebHostBuilder(b => b
                .UseWebRoot(webRoot.FullName)
                .UseSetting(ThemeCatalogSetup.CatalogPathKey, ""));

            var catalog = host.Services.GetRequiredService<ThemeCatalog>();

            Assert.Equal(path, catalog.Source);
        }
        finally
        {
            webRoot.Delete(recursive: true);
        }
    }

    [Fact]
    public async Task Without_a_web_build_development_hosts_read_the_theme_sources()
    {
        // The shared host's web root is empty, and the content root (src/Homebrewery.Api) is two levels below themes/.
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(ThemeCatalogSetup.CatalogPathKey, ""));

        var catalog = host.Services.GetRequiredService<ThemeCatalog>();

        Assert.EndsWith("settings.json", catalog.Source, StringComparison.Ordinal);
        Assert.Equal(ThemeCatalog.Load(HomebreweryApiFactory.ThemeCatalogFixture).Themes, catalog.Themes);
    }

    [Fact]
    public async Task Production_hosts_require_the_built_catalog()
    {
        await using var host = api.Factory.WithWebHostBuilder(b => b
            .UseEnvironment("Production")
            .UseSetting(ThemeCatalogSetup.CatalogPathKey, ""));

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains("Theme catalog not found", error.ToString(), StringComparison.Ordinal);
    }
}
