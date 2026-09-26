using System.Net;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Homebrewery.Api.Tests;

/// <summary>
/// SPA hosting: the Vite build output (SPA + /themes/...) is served from wwwroot with the right
/// content types, "/" serves index.html, and unknown paths fall back to it. Uses a throwaway web
/// root so it runs without a web build.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class StaticFilesTests(ApiFixture api, StaticFilesTests.TempWebRoot webRoot)
    : IClassFixture<StaticFilesTests.TempWebRoot>
{
    // Same URL layout as the real build (web/vite/generateAssetsPlugin.ts): stylesheets under
    // /themes/V3/<key>/, fonts and images at the site root, because theme CSS references them as
    // url('/assets/...') and url('../../../fonts/...').
    private static readonly (string Path, string MediaType)[] AssetFiles =
    [
        ("/themes/V3/5ePHB/style.css", "text/css"),
        ("/themes/V3/5ePHB/style.scoped.css", "text/css"),
        ("/themes/themes.json", "application/json"),
        ("/fonts/Test/Font.woff", "font/woff"),
        ("/fonts/Test/Font.woff2", "font/woff2"),
        ("/fonts/Test/Font.ttf", "font/ttf"),
        ("/fonts/Test/Font.otf", "font/otf"),
        ("/assets/image.webp", "image/webp"),
        ("/assets/image.svg", "image/svg+xml"),
        ("/assets/image.png", "image/png"),
        ("/assets/image.jpg", "image/jpeg"),
    ];

    public static TheoryData<string, string> Assets
    {
        get
        {
            var data = new TheoryData<string, string>();
            foreach (var (path, mediaType) in AssetFiles) data.Add(path, mediaType);
            return data;
        }
    }

    private WebApplicationFactory<Program> Factory => webRoot.FactoryFor(api);

    [Theory]
    [MemberData(nameof(Assets))]
    public async Task Serves_theme_assets_with_their_content_type(string path, string mediaType)
    {
        using var client = Factory.CreateClient();

        using var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(mediaType, response.Content.Headers.ContentType?.MediaType);
    }

    [Theory]
    [InlineData("/")]                 // UseDefaultFiles
    [InlineData("/edit/abc123XYZ")]   // client-side route -> MapFallbackToFile
    public async Task Serves_index_html_for_the_spa(string path)
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Factory.CreateClient();

        using var response = await client.GetAsync(path, ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
        Assert.Contains(TempWebRoot.IndexMarker, await response.Content.ReadAsStringAsync(ct));
    }

    [Theory]
    [InlineData("/api")]
    [InlineData("/api/does-not-exist")]
    [InlineData("/api/brews/abc123XYZ/unknown")]
    public async Task Unknown_api_paths_return_404_problem_not_the_spa(string path)
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Factory.CreateClient();

        using var response = await client.GetAsync(path, ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain(TempWebRoot.IndexMarker, await response.Content.ReadAsStringAsync(ct));
    }

    [Fact]
    public async Task Healthz_is_not_swallowed_by_the_spa_fallback()
    {
        using var client = Factory.CreateClient();

        using var response = await client.GetAsync("/healthz", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
    }

    /// <summary>
    /// A temporary web root with an index.html and the asset files, and one host serving it (derived
    /// from the shared test host, so it uses the test database and the "Testing" environment; in
    /// "Development" the static web assets manifest would layer the real wwwroot over this root).
    /// </summary>
    public sealed class TempWebRoot : IAsyncDisposable
    {
        public const string IndexMarker = "<!-- homebrewery-spa-index -->";

        private readonly DirectoryInfo _webRoot = Directory.CreateTempSubdirectory("homebrewery-wwwroot-");
        private WebApplicationFactory<Program>? _factory;

        public TempWebRoot()
        {
            Write("index.html", $"<!doctype html><html><body>{IndexMarker}</body></html>");
            foreach (var (path, _) in AssetFiles)
            {
                Write(path.TrimStart('/'), "test asset");
            }
        }

        public WebApplicationFactory<Program> FactoryFor(ApiFixture api) =>
            _factory ??= api.Factory.WithWebHostBuilder(b => b.UseWebRoot(_webRoot.FullName));

        public async ValueTask DisposeAsync()
        {
            if (_factory is not null) await _factory.DisposeAsync();
            _webRoot.Delete(recursive: true);
        }

        private void Write(string relativePath, string content)
        {
            var file = Path.Combine(_webRoot.FullName, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, content);
        }
    }
}
