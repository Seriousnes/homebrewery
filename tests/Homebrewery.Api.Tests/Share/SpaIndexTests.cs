using System.Net;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Homebrewery.Api.Tests.Share;

/// <summary>Where ShareShell gets index.html: the web root (cached outside Development) or the Vite dev server.</summary>
public sealed class SpaIndexTests : IDisposable
{
    private readonly DirectoryInfo _webRoot = Directory.CreateTempSubdirectory("homebrewery-spa-index-");
    private readonly FakeHttpHandler _devServer = new();

    [Fact]
    public async Task Outside_development_the_file_is_read_once()
    {
        var ct = TestContext.Current.CancellationToken;
        var index = Create(Environments.Production);
        Write("v1");

        var first = await index.GetAsync(ct);
        Write("v2");
        var second = await index.GetAsync(ct);

        Assert.Equal("v1", first);
        Assert.Equal("v1", second);
    }

    [Fact]
    public async Task In_development_the_file_is_read_on_every_request()
    {
        var ct = TestContext.Current.CancellationToken;
        var index = Create(Environments.Development);
        Write("v1");

        var first = await index.GetAsync(ct);
        Write("v2");
        var second = await index.GetAsync(ct);

        Assert.Equal("v1", first);
        Assert.Equal("v2", second);
    }

    [Fact]
    public async Task A_missing_index_is_not_cached()
    {
        var ct = TestContext.Current.CancellationToken;
        var index = Create(Environments.Production);

        var missing = await index.GetAsync(ct);
        Write("built later");

        Assert.Null(missing);
        Assert.Equal("built later", await index.GetAsync(ct));
    }

    [Fact]
    public async Task The_dev_server_is_asked_first_with_a_host_vite_accepts()
    {
        var ct = TestContext.Current.CancellationToken;
        _devServer.Respond = FakeHttpHandler.Text("<html><head></head>vite</html>", "text/html");
        var index = Create(Environments.Development, devServer: "http://web:5173");
        Write("stale build");

        var html = await index.GetAsync(ct);

        Assert.Equal("<html><head></head>vite</html>", html);
        var request = Assert.Single(_devServer.Requests);
        Assert.Equal(new Uri("http://web:5173/"), request.Uri);
        Assert.Equal("localhost", request.Host);
        Assert.Contains("text/html", request.Headers, StringComparison.Ordinal);
    }

    [Fact]
    public async Task When_the_dev_server_fails_the_file_is_used()
    {
        var ct = TestContext.Current.CancellationToken;
        var index = Create(Environments.Development, devServer: "http://web:5173");
        Write("from wwwroot");

        _devServer.Respond = (_, _) => throw new HttpRequestException("connection refused");
        var refused = await index.GetAsync(ct);
        _devServer.Respond = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
        var blocked = await index.GetAsync(ct);

        Assert.Equal("from wwwroot", refused);
        Assert.Equal("from wwwroot", blocked);
    }

    [Fact]
    public async Task Dev_servers_are_tried_in_order_starting_with_the_last_that_answered()
    {
        var ct = TestContext.Current.CancellationToken;
        _devServer.Respond = (request, _) => request.RequestUri!.Host == "web"
            ? FakeHttpHandler.Text("<html>compose vite</html>", "text/html")(request, ct)
            : throw new HttpRequestException("connection refused");
        var index = Create(Environments.Development, devServer: "http://localhost:5173; http://web:5173");

        var first = await index.GetAsync(ct);
        var afterFirst = _devServer.Requests.Select(r => r.Uri.Host).ToList();
        _devServer.Reset();
        var second = await index.GetAsync(ct);

        Assert.Equal("<html>compose vite</html>", first);
        Assert.Equal(["localhost", "web"], afterFirst);
        Assert.Equal("<html>compose vite</html>", second);
        Assert.Equal(["web"], _devServer.Requests.Select(r => r.Uri.Host));                // no second localhost attempt
    }

    [Fact]
    public void Development_settings_try_the_host_run_and_the_compose_dev_server()
    {
        var settings = new ConfigurationBuilder()
            .AddJsonFile(Path.Combine(Documents.SchemaManifestTests.RepositoryRoot(), "src", "Homebrewery.Api", "appsettings.Development.json"))
            .Build();

        Assert.Equal(["http://localhost:5173", "http://web:8080"], ConfigurationLists.Read(settings, SpaIndex.DevServerUrlsKey));
    }

    public void Dispose()
    {
        _devServer.Dispose();
        _webRoot.Delete(recursive: true);
    }

    private void Write(string html) => File.WriteAllText(Path.Combine(_webRoot.FullName, SpaIndex.FileName), html);

    private SpaIndex Create(string environment, string? devServer = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [SpaIndex.DevServerUrlsKey] = devServer })
            .Build();
        return new SpaIndex(new Environment(environment, _webRoot.FullName), configuration, new Clients(_devServer),
            NullLogger<SpaIndex>.Instance);
    }

    private sealed class Environment(string name, string webRoot) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Homebrewery.Api";
        public string WebRootPath { get; set; } = webRoot;
        public IFileProvider WebRootFileProvider { get; set; } = new PhysicalFileProvider(webRoot);
        public string ContentRootPath { get; set; } = webRoot;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class Clients(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
