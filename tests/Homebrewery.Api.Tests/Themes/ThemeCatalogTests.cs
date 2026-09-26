using System.Text.Json.Nodes;
using Homebrewery.Api.Tests.Documents;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Api.Themes;

namespace Homebrewery.Api.Tests.Themes;

/// <summary>P2.5: ThemeCatalog reads the web build's themes.json, validates it, and can rebuild it from the theme sources.</summary>
public sealed class ThemeCatalogTests
{
    private static readonly string[] Keys = ["5eDMG", "5ePHB", "Blank", "Journal", "UnearthedArcana"];

    [Fact]
    public void The_fixture_catalog_loads_every_V3_theme()
    {
        var catalog = ThemeCatalog.Load(HomebreweryApiFactory.ThemeCatalogFixture);

        Assert.Equal(Keys, catalog.Themes.Select(t => t.Key));
        Assert.True(catalog.TryGet("5eDMG", out var dmg));
        Assert.Equal(
            new ThemeCatalogEntry("5eDMG", "5e DMG", "V3", "5ePHB", "5ePHB", "5eDMG", "/themes/V3/5eDMG/style.css",
                "/themes/V3/5eDMG/style.scoped.css", "/themes/V3/5eDMG/dropdownPreview.png",
                "/themes/V3/5eDMG/dropdownTexture.png", HasSnippets: true),
            dmg);
        Assert.Equal("V3_5eDMG", dmg.SnippetGroup);
        Assert.False(catalog.TryGet("5edmg", out _));                   // keys are case-sensitive, like upstream
    }

    [Fact]
    public void The_fixture_matches_what_the_theme_sources_produce()
    {
        // The fixture is a copy of web/vite/generateAssetsPlugin.ts output. The development fallback derives the same
        // catalog from themes/V3/*/settings.json; if this fails, a theme changed: rebuild the web app and copy
        // src/Homebrewery.Api/wwwroot/themes/themes.json to tests/Homebrewery.Api.Tests/Fixtures/.
        var fromSources = ThemeCatalog.FromThemeSources(Path.Combine(SchemaManifestTests.RepositoryRoot(), "themes"));
        var fixture = ThemeCatalog.Load(HomebreweryApiFactory.ThemeCatalogFixture);

        Assert.Equal(fixture.Themes, fromSources.Themes);
        Assert.EndsWith("settings.json", fromSources.Source, StringComparison.Ordinal);
    }

    [Fact]
    public void A_web_build_catalog_matches_the_fixture_when_present()
    {
        var built = Path.Combine(SchemaManifestTests.RepositoryRoot(), "src", "Homebrewery.Api", "wwwroot", "themes", "themes.json");
        Assert.SkipUnless(File.Exists(built), "No web build in src/Homebrewery.Api/wwwroot.");

        Assert.Equal(ThemeCatalog.Load(HomebreweryApiFactory.ThemeCatalogFixture).Themes, ThemeCatalog.Load(built).Themes);
    }

    [Theory]
    [InlineData("5eDMG", new[] { "Blank", "5ePHB", "5eDMG" })]
    [InlineData("5ePHB", new[] { "Blank", "5ePHB" })]
    [InlineData("Journal", new[] { "Blank", "Journal" })]
    [InlineData("Blank", new[] { "Blank" })]
    public void Static_chains_are_root_first(string key, string[] expected)
    {
        var catalog = ThemeCatalog.Load(HomebreweryApiFactory.ThemeCatalogFixture);

        Assert.Equal(expected, catalog.ChainOf(key)!.Select(t => t.Key));
    }

    [Fact]
    public void An_unknown_key_has_no_chain() =>
        Assert.Null(ThemeCatalog.Load(HomebreweryApiFactory.ThemeCatalogFixture).ChainOf("NoSuchTheme"));

    [Fact]
    public void A_missing_file_throws_FileNotFound()
    {
        var missing = Path.Combine(Path.GetTempPath(), $"no-themes-{Guid.NewGuid():N}.json");

        var error = Assert.Throws<FileNotFoundException>(() => ThemeCatalog.Load(missing));

        Assert.Contains(missing, error.Message, StringComparison.Ordinal);
    }

    public static TheoryData<string, string> InvalidCatalogs => new()
    {
        { "not json", "not valid JSON" },
        { "{}", "no \"themes\" array" },
        { """{"themes":[null]}""", "null entry" },
        { Catalog(Theme("A"), Theme("A")), "duplicate theme 'A'" },
        { Catalog(Theme("A", baseTheme: "Missing")), "unknown base theme 'Missing'" },
        { Catalog(Theme("A", baseTheme: "B"), Theme("B", baseTheme: "Missing")), "theme 'B' has an unknown base theme 'Missing'" },
        { Catalog(Theme("A", baseTheme: "B"), Theme("B", baseTheme: "A")), "cycle or longer than 8" },
        { Catalog(Theme("A", baseTheme: "A")), "cycle or longer than 8" },
        { Catalog(Theme("../etc")), "not a valid theme key" },
        { Catalog(Theme("A", renderer: "Legacy")), "renderer 'Legacy'" },
    };

    [Theory]
    [MemberData(nameof(InvalidCatalogs))]
    public void Invalid_catalogs_are_rejected(string json, string message)
    {
        var error = Assert.Throws<InvalidDataException>(() => ThemeCatalog.Parse(json));

        Assert.Contains(message, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_chain_of_eight_static_themes_is_accepted_and_nine_is_not()
    {
        static JsonObject[] Chain(int length) =>
            [.. Enumerable.Range(1, length).Select(i => Theme($"T{i}", baseTheme: i == 1 ? null : $"T{i - 1}"))];

        var eight = ThemeCatalog.Parse(Catalog(Chain(8)));
        Assert.Equal(8, eight.ChainOf("T8")!.Count);

        var error = Assert.Throws<InvalidDataException>(() => ThemeCatalog.Parse(Catalog(Chain(9))));
        Assert.Contains("'T9'", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Unknown_fields_are_ignored_and_a_blank_name_falls_back_to_the_key()
    {
        var theme = Theme("A", baseSnippets: "NotInThisCatalog");         // informational only, not checked
        theme["name"] = " ";
        theme["somethingNew"] = 42;

        var catalog = ThemeCatalog.Parse(Catalog(theme));

        Assert.Equal("A", catalog.Themes.Single().Name);
        Assert.Equal("NotInThisCatalog", catalog.Themes.Single().BaseSnippets);
    }

    private static string Catalog(params JsonObject[] themes) =>
        new JsonObject { ["themes"] = new JsonArray([.. themes]) }.ToJsonString();

    private static JsonObject Theme(string key, string? baseTheme = null, string? baseSnippets = null, string renderer = "V3") => new()
    {
        ["key"] = key,
        ["name"] = key,
        ["renderer"] = renderer,
        ["baseTheme"] = baseTheme,
        ["baseSnippets"] = baseSnippets,
        ["path"] = key,
        ["style"] = $"/themes/V3/{key}/style.css",
        ["scopedStyle"] = $"/themes/V3/{key}/style.scoped.css",
        ["preview"] = null,
        ["texture"] = null,
        ["hasSnippets"] = false,
    };
}
