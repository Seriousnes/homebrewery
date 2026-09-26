using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P2.7 SameOriginWriteGuard: POST/PUT/PATCH/DELETE need an Origin (or, without one, a Referer) with the request's own
/// scheme, host and port; behind the proxy that is the forwarded scheme and host.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class SameOriginWriteGuardTests(ApiFixture api)
{
    // Anonymous logout: 401 once past the guard, 403 when the guard blocks it.
    private const string WritePath = "/api/account/logout";

    [Theory]
    [InlineData("http://localhost", null)]
    [InlineData("http://LOCALHOST", null)]
    [InlineData("http://localhost:80", null)]
    [InlineData(null, "http://localhost/edit/abc123XYZ?x=1")]
    public async Task Same_origin_writes_pass(string? origin, string? referer)
    {
        using var response = await SendAsync(api.Factory, HttpMethod.Post, WritePath, origin, referer);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData(null, null)]                                            // neither header
    [InlineData("https://evil.example", null)]                          // another site
    [InlineData("https://localhost", null)]                             // another scheme
    [InlineData("http://localhost:8080", null)]                         // another port
    [InlineData("http://localhost.evil.example", null)]                 // a longer host
    [InlineData("null", null)]                                          // sandboxed iframe, file://
    [InlineData("not a url", null)]
    [InlineData("ftp://localhost", null)]
    [InlineData(null, "https://evil.example/page")]                     // Referer from another site
    [InlineData("https://evil.example", "http://localhost/")]           // Origin wins over a same-site Referer
    public async Task Cross_origin_writes_get_403_problem(string? origin, string? referer)
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await SendAsync(api.Factory, HttpMethod.Post, WritePath, origin, referer);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("Cross-origin request blocked", problem.GetProperty("title").GetString());
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task Every_write_method_is_guarded(string method)
    {
        using var blocked = await SendAsync(api.Factory, new HttpMethod(method), "/api/brews/abc123XYZabc", "https://evil.example", null);
        using var allowed = await SendAsync(api.Factory, new HttpMethod(method), "/api/brews/abc123XYZabc", HomebreweryApiFactory.Origin, null);

        Assert.Equal(HttpStatusCode.Forbidden, blocked.StatusCode);
        Assert.NotEqual(HttpStatusCode.Forbidden, allowed.StatusCode);
    }

    [Fact]
    public async Task Reads_need_no_origin()
    {
        using var response = await SendAsync(api.Factory, HttpMethod.Get, "/api/notifications/active", null, null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task A_signed_in_cross_site_write_changes_nothing()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var title = TestBrews.Token();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/brews")
        {
            Content = JsonContent.Create(new { meta = new { title } }),
        };
        request.Headers.Remove("Origin");
        request.Headers.Add("Origin", "https://evil.example");

        using var response = await user.Client.SendAsync(request, ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.False(await api.Factory.WithDbAsync(db => db.Brews.AnyAsync(b => b.Title == title, ct)));
    }

    [Fact]
    public async Task Behind_the_proxy_the_forwarded_scheme_and_host_are_the_origin()
    {
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting("FORWARDEDHEADERS_ENABLED", "true"));
        var forwarded = new Dictionary<string, string>
        {
            ["X-Forwarded-For"] = "203.0.113.7",
            ["X-Forwarded-Proto"] = "https",
            ["X-Forwarded-Host"] = "hb.example.org",
        };

        using var browser = await SendAsync(host, HttpMethod.Post, WritePath, "https://hb.example.org", null, forwarded);
        using var internalOrigin = await SendAsync(host, HttpMethod.Post, WritePath, "http://localhost", null, forwarded);
        using var withPort = await SendAsync(host, HttpMethod.Post, WritePath, "https://hb.example.org:8443", null, forwarded);

        Assert.Equal(HttpStatusCode.Unauthorized, browser.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, internalOrigin.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, withPort.StatusCode);
    }

    [Fact]
    public async Task Forwarded_headers_are_ignored_unless_enabled()
    {
        var forwarded = new Dictionary<string, string> { ["X-Forwarded-Proto"] = "https", ["X-Forwarded-Host"] = "hb.example.org" };

        using var spoofed = await SendAsync(api.Factory, HttpMethod.Post, WritePath, "https://hb.example.org", null, forwarded);
        using var real = await SendAsync(api.Factory, HttpMethod.Post, WritePath, "http://localhost", null, forwarded);

        Assert.Equal(HttpStatusCode.Forbidden, spoofed.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, real.StatusCode);
    }

    [Theory]
    [InlineData("http", "localhost:5173", "http://localhost:5173", true)]     // Vite proxy keeps the Host header
    [InlineData("http", "localhost:5173", "http://127.0.0.1:5173", false)]
    [InlineData("https", "hb.example.org", "https://hb.example.org:443", true)]
    [InlineData("https", "hb.example.org:443", "https://hb.example.org", true)]
    [InlineData("http", "[::1]:8080", "http://[::1]:8080", true)]
    [InlineData("http", "[::1]:8080", "http://[::2]:8080", false)]
    [InlineData("http", "xn--bcher-kva.example", "http://xn--bcher-kva.example", true)]
    public void Origins_compare_scheme_host_and_effective_port(string scheme, string host, string origin, bool expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = scheme;
        context.Request.Host = new HostString(host);
        context.Request.Headers.Origin = origin;

        Assert.Equal(expected, SameOriginWriteGuard.IsSameOrigin(context.Request));
    }

    [Fact]
    public void Several_origin_values_are_refused()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "http";
        context.Request.Host = new HostString("localhost");
        context.Request.Headers.Origin = new Microsoft.Extensions.Primitives.StringValues(["http://localhost", "http://localhost"]);

        Assert.False(SameOriginWriteGuard.IsSameOrigin(context.Request));
    }

    private static async Task<HttpResponseMessage> SendAsync(
        Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program> factory, HttpMethod method, string path,
        string? origin, string? referer, IReadOnlyDictionary<string, string>? headers = null)
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Remove("Origin");
        using var request = new HttpRequestMessage(method, path);
        if (method != HttpMethod.Get) request.Content = JsonContent.Create(new { baseVersion = 1, doc = BrewApi.SimpleDoc("x") });
        if (origin is not null) request.Headers.TryAddWithoutValidation("Origin", origin);
        if (referer is not null) request.Headers.TryAddWithoutValidation("Referer", referer);
        foreach (var (name, value) in headers ?? new Dictionary<string, string>()) request.Headers.TryAddWithoutValidation(name, value);
        return await client.SendAsync(request, TestContext.Current.CancellationToken);
    }
}
