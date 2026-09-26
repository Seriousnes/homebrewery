using System.Net;
using System.Net.Http.Json;
using AngleSharp.Html.Parser;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P8.3 security headers (docs/security.md): pages get the document CSP (scripts only from this origin, no inline
/// scripts, no eval; images and fonts from this origin, https: and data:), API responses a CSP that allows nothing,
/// and every response nosniff, Referrer-Policy, Permissions-Policy, COOP and X-Frame-Options; HTTPS adds HSTS and
/// upgrade-insecure-requests. Uses a temporary web root with a fixture index.html, never the real wwwroot.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class SecurityHeadersTests(ApiFixture api, SecurityHeadersTests.WebRoot webRoot)
    : IClassFixture<SecurityHeadersTests.WebRoot>
{
    private const string Csp = "Content-Security-Policy";
    private const string CspReportOnly = "Content-Security-Policy-Report-Only";

    private WebApplicationFactory<Program> Factory => webRoot.FactoryFor(api);

    // ---- pages -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("/")]                           // UseDefaultFiles + static index.html
    [InlineData("/edit/abc123XYZabc")]          // SPA fallback
    [InlineData("/share/unknownShare1")]        // ShareShell (unknown id: the plain index)
    [InlineData("/static/app.js")]
    [InlineData("/static/app.css")]
    [InlineData("/themes/V3/Blank/style.css")]
    [InlineData("/missing.png")]                // 404 from the SPA fallback's file check
    public async Task Pages_and_static_files_get_the_document_policy(string path)
    {
        using var client = Factory.CreateClient();

        using var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        Assert.Equal(SecurityHeaders.DocumentPolicy, Header(response, Csp));
        Assert.False(response.Headers.Contains(CspReportOnly));
        AssertCommonHeaders(response);
        Assert.False(response.Headers.Contains("Strict-Transport-Security"));    // plain http
    }

    [Fact]
    public async Task A_brews_share_shell_gets_the_document_policy_and_no_inline_script()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await Factory.CreateUserAsync(ct: ct);
        const string title = "</script><script>alert(1)</script>";
        const string description = "<style>*{}</style>\" onload=\"alert(2)";
        var brew = await TestBrews.CreateAsync(owner.Client, ct, title: title, description: description);
        using var anonymous = Factory.CreateClient();

        using var response = await anonymous.GetAsync($"/share/{brew.ShareId}", ct);
        var html = await response.Content.ReadAsStringAsync(ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(SecurityHeaders.DocumentPolicy, Header(response, Csp));
        AssertCommonHeaders(response);
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());             // the shell's own choice is kept
        AssertNoInlineCode(html);
        var page = new HtmlParser().ParseDocument(html);
        // The payloads are text inside attribute values, exactly as typed, not markup.
        Assert.StartsWith(title, page.QuerySelector("meta[property='og:title']")?.GetAttribute("content"), StringComparison.Ordinal);
        Assert.Equal(description, page.QuerySelector("meta[property='og:description']")?.GetAttribute("content"));
    }

    [Fact]
    public void The_document_policy_allows_no_inline_script_no_eval_and_only_https_fonts_and_images()
    {
        var policy = Directives(SecurityHeaders.DocumentPolicy);

        Assert.Equal(["'self'"], policy["default-src"]);
        Assert.Equal(["'self'"], policy["script-src"]);
        Assert.DoesNotContain(policy, d => d.Value.Any(s => s is "'unsafe-eval'" or "'wasm-unsafe-eval'" or "'unsafe-hashes'"));
        Assert.DoesNotContain(policy, d => d.Key is "script-src" or "default-src" or "script-src-elem" or "script-src-attr"
                                           && d.Value.Contains("'unsafe-inline'"));
        Assert.DoesNotContain(policy, d => d.Value.Any(s => s is "*" or "http:" or "ws:" or "wss:"));
        Assert.Equal(["'self'", "https:", "data:", "blob:"], policy["img-src"]);
        Assert.Equal(["'self'", "https:", "data:"], policy["font-src"]);
        Assert.Equal(["'self'", "https:"], policy["connect-src"]);
        Assert.Equal(["'self'", "'unsafe-inline'"], policy["style-src"]);
        Assert.Equal(["'none'"], policy["object-src"]);
        Assert.Equal(["'self'"], policy["base-uri"]);
        Assert.Equal(["'self'"], policy["form-action"]);
        Assert.Equal(["'none'"], policy["frame-ancestors"]);
    }

    // ---- API ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData("GET", "/api/notifications/active", null, HttpStatusCode.OK)]
    [InlineData("GET", "/api/account/me", null, HttpStatusCode.NoContent)]
    [InlineData("GET", "/api/does-not-exist", null, HttpStatusCode.NotFound)]
    [InlineData("GET", "/api/brews/edit/abc123XYZabc", null, HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/account/logout", HomebreweryApiFactory.Origin, HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/account/logout", "https://evil.example", HttpStatusCode.Forbidden)]
    [InlineData("GET", "/healthz", null, HttpStatusCode.OK)]
    [InlineData("GET", "/openapi/v1.json", null, HttpStatusCode.OK)]
    public async Task Api_responses_get_a_policy_that_allows_nothing_and_are_not_stored(
        string method, string path, string? origin, HttpStatusCode status)
    {
        using var client = Factory.CreateClient();
        client.DefaultRequestHeaders.Remove("Origin");
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (origin is not null) request.Headers.Add("Origin", origin);

        using var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(status, response.StatusCode);
        Assert.Equal(SecurityHeaders.ApiPolicy, Header(response, Csp));
        Assert.Equal("same-origin", Header(response, "Cross-Origin-Resource-Policy"));
        Assert.True(response.Headers.CacheControl?.NoStore, "Cache-Control must include no-store.");   // /healthz: "no-store, no-cache"
        AssertCommonHeaders(response);
    }

    [Fact]
    public async Task A_signed_in_accounts_data_is_not_stored_by_caches()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(user.Client, ct);

        using var me = await user.Client.GetAsync("/api/account/me", ct);
        using var edit = await user.Client.GetAsync($"/api/brews/edit/{brew.EditId}", ct);

        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        Assert.Equal(HttpStatusCode.OK, edit.StatusCode);
        Assert.Equal("no-store", me.Headers.CacheControl?.ToString());
        Assert.Equal("no-store", edit.Headers.CacheControl?.ToString());
        Assert.Equal(SecurityHeaders.ApiPolicy, Header(edit, Csp));
    }

    [Fact]
    public async Task Rate_limited_responses_get_the_headers_too()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = Factory.WithWebHostBuilder(b => b.UseSetting("RateLimits:Auth:PermitLimit", "1"));
        using var client = host.CreateClient();
        var login = new { email = TestUsers.UniqueEmail("nobody"), password = "wrong" };

        using var first = await client.PostAsJsonAsync("/api/auth/login?useCookies=true", login, ct);
        using var limited = await client.PostAsJsonAsync("/api/auth/login?useCookies=true", login, ct);

        Assert.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode);
        Assert.Equal(SecurityHeaders.ApiPolicy, Header(limited, Csp));
        AssertCommonHeaders(limited);
    }

    // ---- HTTPS -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("/")]
    [InlineData("/api/notifications/active")]
    public async Task Https_responses_get_hsts(string path)
    {
        using var client = Factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://hb.example.org") });

        using var response = await client.GetAsync(path, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("max-age=31536000", Header(response, "Strict-Transport-Security"));
    }

    [Fact]
    public async Task Https_pages_upgrade_insecure_requests()
    {
        using var client = Factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://hb.example.org") });

        using var response = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(SecurityHeaders.DocumentPolicy + "; upgrade-insecure-requests", Header(response, Csp));
    }

    [Theory]
    [InlineData("https://localhost")]
    [InlineData("https://127.0.0.1")]
    [InlineData("https://[::1]")]
    public async Task Loopback_hosts_never_get_hsts(string baseAddress)
    {
        using var client = Factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri(baseAddress) });

        using var response = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(response.Headers.Contains("Strict-Transport-Security"));
    }

    [Fact]
    public async Task Behind_the_proxy_the_forwarded_scheme_decides_hsts()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = Factory.WithWebHostBuilder(b => b.UseSetting("FORWARDEDHEADERS_ENABLED", "true"));
        using var client = host.CreateClient();

        using var https = await GetAsync(client, "/", ct, ("X-Forwarded-Proto", "https"), ("X-Forwarded-Host", "hb.example.org"));
        using var http = await GetAsync(client, "/", ct, ("X-Forwarded-Proto", "http"), ("X-Forwarded-Host", "hb.example.org"));

        Assert.Equal("max-age=31536000", Header(https, "Strict-Transport-Security"));
        Assert.EndsWith("; upgrade-insecure-requests", Header(https, Csp));
        Assert.False(http.Headers.Contains("Strict-Transport-Security"));
        Assert.Equal(SecurityHeaders.DocumentPolicy, Header(http, Csp));
    }

    [Fact]
    public async Task Hsts_max_age_and_subdomains_are_configurable()
    {
        await using var host = Factory.WithWebHostBuilder(b => b
            .UseSetting("SecurityHeaders:HstsMaxAge", "1.00:00:00")
            .UseSetting("SecurityHeaders:HstsIncludeSubDomains", "true"));
        using var client = host.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://hb.example.org") });

        using var response = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal("max-age=86400; includeSubDomains", Header(response, "Strict-Transport-Security"));
    }

    // ---- configuration -----------------------------------------------------------------------------

    [Fact]
    public async Task Report_only_mode_sends_the_policy_as_report_only()
    {
        await using var host = Factory.WithWebHostBuilder(b => b.UseSetting(SecurityHeaders.CspKey, "ReportOnly"));
        using var client = host.CreateClient();

        using var response = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(SecurityHeaders.DocumentPolicy, Header(response, CspReportOnly));
        Assert.False(response.Headers.Contains(Csp));
    }

    [Fact]
    public async Task Off_sends_no_policy_but_keeps_the_other_headers()
    {
        await using var host = Factory.WithWebHostBuilder(b => b.UseSetting(SecurityHeaders.CspKey, "Off"));
        using var client = host.CreateClient();

        using var response = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.False(response.Headers.Contains(Csp));
        Assert.False(response.Headers.Contains(CspReportOnly));
        AssertCommonHeaders(response);
    }

    [Fact]
    public async Task A_report_uri_is_added_to_every_policy()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = Factory.WithWebHostBuilder(b => b.UseSetting("SecurityHeaders:CspReportUri", "https://reports.example/csp"));
        using var client = host.CreateClient();

        using var page = await client.GetAsync("/", ct);
        using var data = await client.GetAsync("/api/notifications/active", ct);

        Assert.Equal(SecurityHeaders.DocumentPolicy + "; report-uri https://reports.example/csp", Header(page, Csp));
        Assert.Equal(SecurityHeaders.ApiPolicy + "; report-uri https://reports.example/csp", Header(data, Csp));
    }

    [Theory]
    [InlineData("https://reports.example/csp; script-src *")]   // would add a directive
    [InlineData("https://reports.example/a, b")]
    [InlineData("https://reports.example/a b")]
    [InlineData("http://reports.example/csp")]                  // not https
    [InlineData("//reports.example/csp")]                        // protocol-relative
    [InlineData("javascript:alert(1)")]
    [InlineData("csp-reports")]                                  // neither a URL nor a path
    public async Task A_bad_report_uri_stops_the_host(string uri)
    {
        // Straight from the shared host (like the other startup tests), not from this class's web-root host.
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting("SecurityHeaders:CspReportUri", uri));

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains("CspReportUri", error.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Development", null, CspMode.Off)]
    [InlineData("Production", null, CspMode.Enforce)]
    [InlineData("Testing", null, CspMode.Enforce)]
    [InlineData("Development", CspMode.ReportOnly, CspMode.ReportOnly)]
    [InlineData("Development", CspMode.Enforce, CspMode.Enforce)]
    [InlineData("Production", CspMode.Off, CspMode.Off)]
    public void Development_defaults_to_no_csp_and_everything_else_enforces(string environment, CspMode? configured, CspMode expected)
    {
        var values = new SecurityHeaderValues(
            Options.Create(new SecurityHeadersSettings { Csp = configured }), new TestEnvironment(environment));

        Assert.Equal(expected, values.Mode);
    }

    [Fact]
    public void Kestrel_sends_no_server_header() =>
        Assert.False(api.Factory.Services.GetRequiredService<IOptions<KestrelServerOptions>>().Value.AddServerHeader);

    [Theory]
    [InlineData("localhost", true)]
    [InlineData("LOCALHOST:8443", true)]
    [InlineData("127.0.0.1:5080", true)]
    [InlineData("127.5.6.7", true)]
    [InlineData("[::1]:443", true)]
    [InlineData("hb.example.org", false)]
    [InlineData("localhost.example.org", false)]
    [InlineData("10.0.0.1", false)]
    public void Loopback_hosts_are_recognised(string host, bool expected) =>
        Assert.Equal(expected, SecurityHeaders.IsLoopbackHost(new HostString(host)));

    [Theory]
    [InlineData("/api", true)]
    [InlineData("/api/brews/share/x", true)]
    [InlineData("/API/vault", true)]
    [InlineData("/openapi/v1.json", true)]
    [InlineData("/healthz", true)]
    [InlineData("/apis", false)]
    [InlineData("/share/x", false)]
    [InlineData("/", false)]
    public void Api_paths_are_the_data_endpoints(string path, bool expected) =>
        Assert.Equal(expected, SecurityHeaders.IsApiPath(new PathString(path)));

    // ---- the SPA's own page ------------------------------------------------------------------------

    [Fact]
    public void The_spa_index_has_no_inline_script_style_or_handler()
    {
        var root = Documents.SchemaManifestTests.RepositoryRoot();
        var pages = new[] { Path.Combine(root, "web", "index.html"), Path.Combine(root, "src", "Homebrewery.Api", "wwwroot", "index.html") }
            .Where(File.Exists)
            .ToList();

        Assert.NotEmpty(pages);                                                  // web/index.html always exists
        foreach (var page in pages) AssertNoInlineCode(File.ReadAllText(page));
    }

    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<script type=\"module\">import '/a.js'</script>")]
    [InlineData("<script src=\"/a.js\">alert(1)</script>")]
    [InlineData("<style>body{}</style>")]
    [InlineData("<body onload=\"alert(1)\"></body>")]
    [InlineData("<a href=\" javascript:alert(1)\">x</a>")]
    public void The_inline_code_check_catches_inline_code(string html) =>
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertNoInlineCode(html));

    // ---- helpers -----------------------------------------------------------------------------------

    private static void AssertCommonHeaders(HttpResponseMessage response)
    {
        Assert.Equal("nosniff", Header(response, "X-Content-Type-Options"));
        Assert.Equal("strict-origin-when-cross-origin", Header(response, "Referrer-Policy"));
        Assert.Equal(SecurityHeaders.PermissionsPolicy, Header(response, "Permissions-Policy"));
        Assert.Equal("same-origin", Header(response, "Cross-Origin-Opener-Policy"));
        Assert.Equal("DENY", Header(response, "X-Frame-Options"));
    }

    private static string Header(HttpResponseMessage response, string name) =>
        response.Headers.TryGetValues(name, out var values) || response.Content.Headers.TryGetValues(name, out values)
            ? Assert.Single(values)
            : throw new Xunit.Sdk.XunitException($"Missing header {name} on {response.RequestMessage?.RequestUri} ({(int)response.StatusCode}).");

    private static async Task<HttpResponseMessage> GetAsync(HttpClient client, string path, CancellationToken ct, params (string Name, string Value)[] headers)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        return await client.SendAsync(request, ct);
    }

    private static Dictionary<string, string[]> Directives(string policy) =>
        policy.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(d => d.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            .ToDictionary(parts => parts[0], parts => parts[1..]);

    /// <summary>
    /// The page has no inline script, style element, event handler or javascript: URL, so the document policy
    /// (script-src 'self' without 'unsafe-inline') allows all of it. Parsed, so encoded text is not taken for markup.
    /// </summary>
    private static void AssertNoInlineCode(string html)
    {
        var document = new HtmlParser().ParseDocument(html);
        Assert.All(document.Scripts, script =>
        {
            Assert.False(string.IsNullOrEmpty(script.Source), $"Inline script: {script.OuterHtml}");
            Assert.True(string.IsNullOrWhiteSpace(script.Text), $"Script with inline code: {script.OuterHtml}");
        });
        Assert.Empty(document.QuerySelectorAll("style"));
        Assert.All(document.All, element => Assert.All(element.Attributes, attribute =>
        {
            Assert.False(attribute.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase), $"Inline handler: {element.OuterHtml}");
            Assert.False(attribute.Value.TrimStart().StartsWith("javascript:", StringComparison.OrdinalIgnoreCase),
                $"javascript: URL: {element.OuterHtml}");
        }));
    }

    private sealed class TestEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "Homebrewery.Api";
        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    /// <summary>A temporary web root shaped like the Vite build, and one host serving it.</summary>
    public sealed class WebRoot : IAsyncDisposable
    {
        private readonly DirectoryInfo _root = Directory.CreateTempSubdirectory("homebrewery-security-wwwroot-");
        private WebApplicationFactory<Program>? _factory;

        public WebRoot()
        {
            Write("index.html", """
                <!doctype html>
                <html lang="en">
                  <head>
                    <meta charset="UTF-8" />
                    <title>The Homebrewery</title>
                    <script type="module" crossorigin src="/static/app.js"></script>
                    <link rel="stylesheet" crossorigin href="/static/app.css">
                  </head>
                  <body><div id="root"></div></body>
                </html>
                """);
            Write("static/app.js", "export {};");
            Write("static/app.css", "body{}");
            Write("themes/V3/Blank/style.css", ".page{}");
        }

        public WebApplicationFactory<Program> FactoryFor(ApiFixture api) =>
            _factory ??= api.Factory.WithWebHostBuilder(b => b.UseWebRoot(_root.FullName));

        public async ValueTask DisposeAsync()
        {
            if (_factory is not null) await _factory.DisposeAsync();
            try
            {
                _root.Delete(recursive: true);
            }
            catch (IOException)
            {
                // Best effort: a file may still be open on Windows.
            }
        }

        private void Write(string relativePath, string content)
        {
            var file = Path.Combine(_root.FullName, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, content);
        }
    }
}
