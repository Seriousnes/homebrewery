using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Import;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Pdf;
using Homebrewery.Api.Tests.Pdf;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P2.7 rate limits: the auth policy (per IP), the import and PDF export policies (per user) and the global write limiter
/// (per IP), each answering 429 problem+json with Retry-After. Each test runs its own host with low limits.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class RateLimitTests(ApiFixture api)
{
    [Fact]
    public void Defaults_limit_auth_import_pdf_and_writes()
    {
        var settings = api.Factory.Services.GetRequiredService<IOptions<RateLimitSettings>>().Value;
        var defaults = new RateLimitSettings();

        Assert.Equal(HomebreweryApiFactory.GenerousPermitLimit, settings.Writes.PermitLimit);     // the test hosts' override
        Assert.Equal(20, defaults.Auth.PermitLimit);
        Assert.Equal(10, defaults.Import.PermitLimit);
        Assert.Equal(10, defaults.Pdf.PermitLimit);
        Assert.Equal(120, defaults.Writes.PermitLimit);
        Assert.All([defaults.Auth, defaults.Import, defaults.Pdf, defaults.Writes], l => Assert.Equal(TimeSpan.FromMinutes(1), l.Window));
    }

    [Fact]
    public async Task Auth_endpoints_are_limited_per_ip()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = WithLimits(auth: 3);
        using var client = host.CreateClient();
        var login = new { email = TestUsers.UniqueEmail("nobody"), password = "wrong" };

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 3; i++)
        {
            using var attempt = await client.PostAsJsonAsync("/api/auth/login?useCookies=true", login, ct);
            statuses.Add(attempt.StatusCode);
        }

        using var limited = await client.PostAsJsonAsync("/api/auth/register", new { email = TestUsers.UniqueEmail(), password = TestUsers.Password }, ct);

        Assert.All(statuses, s => Assert.Equal(HttpStatusCode.Unauthorized, s));
        await AssertTooManyRequestsAsync(limited, ct);
    }

    [Fact]
    public async Task Writes_are_limited_per_ip_but_reads_are_not()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = WithLimits(writes: 2);
        using var client = host.CreateClient();

        using var first = await client.PostAsync("/api/account/logout", null, ct);
        using var second = await client.DeleteAsync("/api/brews/abc123XYZabc", ct);
        using var third = await client.PutAsJsonAsync("/api/account/handle", new { handle = "whoever" }, ct);
        using var read = await client.GetAsync("/api/notifications/active", ct);

        Assert.Equal(HttpStatusCode.Unauthorized, first.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, second.StatusCode);
        await AssertTooManyRequestsAsync(third, ct);
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
    }

    [Fact]
    public async Task Behind_the_proxy_each_client_ip_has_its_own_write_budget()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = WithLimits(writes: 1, configure: b => b.UseSetting("FORWARDEDHEADERS_ENABLED", "true"));
        using var client = host.CreateClient();

        using var a1 = await LogoutFromAsync(client, "203.0.113.1", ct);
        using var a2 = await LogoutFromAsync(client, "203.0.113.1", ct);
        using var b1 = await LogoutFromAsync(client, "203.0.113.2", ct);

        Assert.Equal(HttpStatusCode.Unauthorized, a1.StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, a2.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, b1.StatusCode);
    }

    [Fact]
    public async Task The_import_proxy_is_limited_per_user()
    {
        var ct = TestContext.Current.CancellationToken;
        var upstream = new FakeHttpHandler { Respond = FakeHttpHandler.Text("# A brew") };
        await using var host = WithLimits(import: 2, configure: b => b.ConfigureTestServices(s =>
            s.AddHttpClient<UpstreamImportClient>().ConfigurePrimaryHttpMessageHandler(() => upstream)));
        using var alice = await host.CreateUserAsync(ct: ct);
        using var bob = await host.CreateUserAsync(ct: ct);

        using var a1 = await alice.Client.GetAsync("/api/import/homebrewery/abcdefghij12", ct);
        using var a2 = await alice.Client.GetAsync("/api/import/homebrewery/abcdefghij12", ct);
        using var a3 = await alice.Client.GetAsync("/api/import/homebrewery/abcdefghij12", ct);
        using var b1 = await bob.Client.GetAsync("/api/import/homebrewery/abcdefghij12", ct);

        Assert.Equal(HttpStatusCode.OK, a1.StatusCode);
        Assert.Equal(HttpStatusCode.OK, a2.StatusCode);
        await AssertTooManyRequestsAsync(a3, ct);
        Assert.Equal(HttpStatusCode.OK, b1.StatusCode);
        Assert.Equal(3, upstream.Requests.Count);                                  // the limited call never went out
    }

    [Fact]
    public async Task Pdf_export_is_limited_per_user()
    {
        var ct = TestContext.Current.CancellationToken;
        var renderer = new PdfExportEndpointTests.FakeRenderer { Respond = _ => Task.FromResult(new PdfRenderResult([37, 80, 68, 70], 0, 0)) };
        await using var host = WithLimits(pdf: 1, configure: b => b.ConfigureTestServices(s =>
            s.Replace(ServiceDescriptor.Singleton<IPdfRenderer>(renderer))));
        using var alice = await host.CreateUserAsync(ct: ct);
        using var bob = await host.CreateUserAsync(ct: ct);

        using var a1 = await alice.Client.PostAsJsonAsync("/api/export/pdf", new { html = "<p>x</p>" }, ct);
        using var a2 = await alice.Client.PostAsJsonAsync("/api/export/pdf", new { html = "<p>x</p>" }, ct);
        using var b1 = await bob.Client.PostAsJsonAsync("/api/export/pdf", new { html = "<p>x</p>" }, ct);

        Assert.Equal(HttpStatusCode.OK, a1.StatusCode);
        await AssertTooManyRequestsAsync(a2, ct);
        Assert.Equal(HttpStatusCode.OK, b1.StatusCode);
        Assert.Equal(2, renderer.Received.Count);                                 // the limited call never rendered
    }

    [Fact]
    public async Task Anonymous_pdf_exports_are_limited_per_client_ip()
    {
        var ct = TestContext.Current.CancellationToken;
        var renderer = new PdfExportEndpointTests.FakeRenderer { Respond = _ => Task.FromResult(new PdfRenderResult([37, 80, 68, 70], 0, 0)) };
        await using var host = WithLimits(pdf: 1, configure: b => b
            .UseSetting("FORWARDEDHEADERS_ENABLED", "true")
            .ConfigureTestServices(s => s.Replace(ServiceDescriptor.Singleton<IPdfRenderer>(renderer))));
        using var client = host.CreateClient();

        using var a1 = await ExportPdfFromAsync(client, "203.0.113.1", ct);
        using var a2 = await ExportPdfFromAsync(client, "203.0.113.1", ct);
        using var b1 = await ExportPdfFromAsync(client, "203.0.113.2", ct);

        Assert.Equal(HttpStatusCode.OK, a1.StatusCode);
        await AssertTooManyRequestsAsync(a2, ct);
        Assert.Equal(HttpStatusCode.OK, b1.StatusCode);
        Assert.Equal(2, renderer.Received.Count);
    }

    [Fact]
    public void Invalid_limits_stop_the_host()
    {
        using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting("RateLimits:Writes:PermitLimit", "0"));

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains("RateLimits", error.ToString(), StringComparison.Ordinal);
    }

    private WebApplicationFactory<Program> WithLimits(
        int? auth = null, int? import = null, int? writes = null, int? pdf = null, Action<IWebHostBuilder>? configure = null) =>
        api.Factory.WithWebHostBuilder(b =>
        {
            if (auth is { } a) b.UseSetting("RateLimits:Auth:PermitLimit", a.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (import is { } i) b.UseSetting("RateLimits:Import:PermitLimit", i.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (writes is { } w) b.UseSetting("RateLimits:Writes:PermitLimit", w.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (pdf is { } p) b.UseSetting("RateLimits:Pdf:PermitLimit", p.ToString(System.Globalization.CultureInfo.InvariantCulture));
            configure?.Invoke(b);
        });

    private static Task<HttpResponseMessage> LogoutFromAsync(HttpClient client, string ip, CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/account/logout");
        request.Headers.Add("X-Forwarded-For", ip);
        return client.SendAsync(request, ct);
    }

    private static Task<HttpResponseMessage> ExportPdfFromAsync(HttpClient client, string ip, CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/export/pdf") { Content = JsonContent.Create(new { html = "<p>x</p>" }) };
        request.Headers.Add("X-Forwarded-For", ip);
        return client.SendAsync(request, ct);
    }

    private static async Task AssertTooManyRequestsAsync(HttpResponseMessage response, CancellationToken ct)
    {
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal(429, problem.GetProperty("status").GetInt32());
        Assert.Equal("Too many requests", problem.GetProperty("title").GetString());
        var retryAfter = Assert.Single(response.Headers.GetValues("Retry-After"));
        Assert.InRange(int.Parse(retryAfter, System.Globalization.CultureInfo.InvariantCulture), 1, 60);
    }
}
