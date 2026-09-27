using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Homebrewery.Api.Endpoints;
using Homebrewery.Api.Pdf;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Homebrewery.Api.Tests.Pdf;

/// <summary><c>POST /api/export/pdf</c> over a fake renderer (PdfRendererTests covers Chromium).</summary>
[Collection(ApiCollection.Name)]
public sealed class PdfExportEndpointTests(PdfExportEndpointTests.PdfHost host) : IClassFixture<PdfExportEndpointTests.PdfHost>
{
    private const string Html = "<!DOCTYPE html><title>Brew</title><div class=\"page\">Hello</div>";
    private static readonly byte[] Pdf = Encoding.ASCII.GetBytes("%PDF-1.7 fake");

    [Fact]
    public async Task A_signed_in_user_gets_the_pdf()
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => Task.FromResult(new PdfRenderResult(Pdf, RemoteFiles: 2, MissingFiles: 1));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.PostAsJsonAsync("/api/export/pdf", new { html = Html }, ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/pdf", response.Content.Headers.ContentType?.MediaType);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal("1", Assert.Single(response.Headers.GetValues(ExportEndpoints.MissingFilesHeader)));
        Assert.Equal(Pdf, await response.Content.ReadAsByteArrayAsync(ct));
        Assert.Equal(Html, Assert.Single(host.Renderer.Received));
    }

    [Fact]
    public async Task A_gzip_body_is_accepted()
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => Task.FromResult(new PdfRenderResult(Pdf, 0, 0));
        var user = await host.UserAsync(ct);
        using var body = new ByteArrayContent(Gzip(JsonSerializer.SerializeToUtf8Bytes(new { html = Html })));
        body.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        body.Headers.ContentEncoding.Add("gzip");

        using var response = await user.Client.PostAsync("/api/export/pdf", body, ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Html, Assert.Single(host.Renderer.Received));
    }

    [Fact]
    public async Task Anonymous_callers_get_the_pdf_too()
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => Task.FromResult(new PdfRenderResult(Pdf, 0, 0));
        using var anonymous = host.Factory.CreateClient();

        using var response = await anonymous.PostAsJsonAsync("/api/export/pdf", new { html = Html }, ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/pdf", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(Pdf, await response.Content.ReadAsByteArrayAsync(ct));
        Assert.Equal(Html, Assert.Single(host.Renderer.Received));
    }

    [Fact]
    public async Task Another_origin_gets_403_and_nothing_is_rendered()
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => Task.FromResult(new PdfRenderResult(Pdf, 0, 0));
        using var client = host.Factory.CreateClient();
        client.DefaultRequestHeaders.Remove("Origin");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/export/pdf") { Content = JsonContent.Create(new { html = Html }) };
        request.Headers.Add("Origin", "https://evil.example");

        using var response = await client.SendAsync(request, ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(host.Renderer.Received);
    }

    [Theory]
    [InlineData("{\"html\":\"\"}")]
    [InlineData("{\"html\":\"   \"}")]
    public async Task Empty_html_is_400(string json)
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => Task.FromResult(new PdfRenderResult(Pdf, 0, 0));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.PostAsync("/api/export/pdf", new StringContent(json, Encoding.UTF8, "application/json"), ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("html", out _));
        Assert.Empty(host.Renderer.Received);
    }

    [Fact]
    public async Task A_body_over_20_MB_is_413_also_when_gzipped()
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => Task.FromResult(new PdfRenderResult(Pdf, 0, 0));
        var user = await host.UserAsync(ct);
        var json = JsonSerializer.SerializeToUtf8Bytes(new { html = new string('x', (int)ExportEndpoints.MaxRequestBytes) });
        using var body = new ByteArrayContent(Gzip(json));             // a few KB on the wire
        body.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        body.Headers.ContentEncoding.Add("gzip");

        using var response = await user.Client.PostAsync("/api/export/pdf", body, ct);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Empty(host.Renderer.Received);
    }

    [Fact]
    public async Task A_busy_renderer_is_503_with_retry_after()
    {
        var ct = TestContext.Current.CancellationToken;
        host.Renderer.Respond = _ => throw new PdfRendererBusyException();
        var user = await host.UserAsync(ct);

        using var response = await user.Client.PostAsJsonAsync("/api/export/pdf", new { html = Html }, ct);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("5", Assert.Single(response.Headers.GetValues("Retry-After")));
        Assert.Equal("PDF export is busy", (await response.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("title").GetString());
    }

    [Fact]
    public async Task A_missing_browser_is_503_and_a_failed_render_is_500()
    {
        var ct = TestContext.Current.CancellationToken;
        var user = await host.UserAsync(ct);

        host.Renderer.Respond = _ => throw new PdfRendererUnavailableException("no chromium", new InvalidOperationException());
        using var unavailable = await user.Client.PostAsJsonAsync("/api/export/pdf", new { html = Html }, ct);
        host.Renderer.Respond = _ => throw new PdfRenderFailedException("The PDF took longer than 60 seconds to make.");
        using var failed = await user.Client.PostAsJsonAsync("/api/export/pdf", new { html = Html }, ct);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, unavailable.StatusCode);
        Assert.False(unavailable.Headers.Contains("Retry-After"));
        Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
        var problem = await failed.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("Couldn't make the PDF", problem.GetProperty("title").GetString());
        Assert.Equal("The PDF took longer than 60 seconds to make.", problem.GetProperty("detail").GetString());
    }

    private static byte[] Gzip(byte[] data)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest)) gzip.Write(data);
        return output.ToArray();
    }

    public sealed class PdfHost : IAsyncDisposable
    {
        private TestUser? _user;

        public PdfHost(ApiFixture api) =>
            Factory = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.Replace(ServiceDescriptor.Singleton<IPdfRenderer>(Renderer))));

        public FakeRenderer Renderer { get; } = new();

        public WebApplicationFactory<Program> Factory { get; }

        public async Task<TestUser> UserAsync(CancellationToken ct) => _user ??= await Factory.CreateUserAsync(ct: ct);

        public async ValueTask DisposeAsync()
        {
            _user?.Dispose();
            await Factory.DisposeAsync();
        }
    }

    public sealed class FakeRenderer : IPdfRenderer
    {
        private Func<string, Task<PdfRenderResult>> _respond = _ => throw new InvalidOperationException("No answer set.");

        public List<string> Received { get; } = [];

        /// <summary>Setting an answer also clears <see cref="Received"/>.</summary>
        public Func<string, Task<PdfRenderResult>> Respond
        {
            set
            {
                Received.Clear();
                _respond = value;
            }
        }

        public Task<PdfRenderResult> RenderAsync(string html, CancellationToken ct)
        {
            Received.Add(html);
            return _respond(html);
        }
    }
}
