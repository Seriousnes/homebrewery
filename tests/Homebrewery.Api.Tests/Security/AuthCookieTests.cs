using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P8 hardening: the sign-in cookie is <c>Secure</c> whenever the browser's request is HTTPS, including behind a TLS proxy
/// (<c>X-Forwarded-Proto: https</c> with <c>ASPNETCORE_FORWARDEDHEADERS_ENABLED=true</c>), and always with
/// <c>Auth:CookieSecurePolicy=Always</c>. It stays HttpOnly and SameSite=Lax.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class AuthCookieTests(ApiFixture api)
{
    private const string CookieName = ".AspNetCore.Identity.Application";

    [Fact]
    public async Task Over_plain_http_the_cookie_is_httponly_lax_and_not_secure()
    {
        var email = await RegisterAsync();

        var cookie = await SignInCookieAsync(api.Factory, email, origin: HomebreweryApiFactory.Origin);

        Assert.Contains("httponly", cookie.Attributes);
        Assert.Contains("samesite=lax", cookie.Attributes);
        Assert.DoesNotContain("secure", cookie.Attributes);
    }

    [Fact]
    public async Task Behind_the_proxy_an_https_request_gets_a_secure_cookie()
    {
        var email = await RegisterAsync();
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting("FORWARDEDHEADERS_ENABLED", "true"));

        var https = await SignInCookieAsync(host, email, origin: "https://hb.example.org", new Dictionary<string, string>
        {
            ["X-Forwarded-For"] = "203.0.113.9",
            ["X-Forwarded-Proto"] = "https",
            ["X-Forwarded-Host"] = "hb.example.org",
        });
        var http = await SignInCookieAsync(host, email, origin: "http://hb.example.org", new Dictionary<string, string>
        {
            ["X-Forwarded-Proto"] = "http",
            ["X-Forwarded-Host"] = "hb.example.org",
        });

        Assert.Contains("secure", https.Attributes);
        Assert.Contains("httponly", https.Attributes);
        Assert.DoesNotContain("secure", http.Attributes);
    }

    [Fact]
    public async Task A_forwarded_scheme_is_ignored_unless_forwarded_headers_are_enabled()
    {
        var email = await RegisterAsync();

        var cookie = await SignInCookieAsync(api.Factory, email, origin: HomebreweryApiFactory.Origin,
            new Dictionary<string, string> { ["X-Forwarded-Proto"] = "https" });

        Assert.DoesNotContain("secure", cookie.Attributes);
    }

    [Fact]
    public async Task Always_marks_the_cookie_secure_over_plain_http()
    {
        var email = await RegisterAsync();
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(AuthCookies.SecurePolicyKey, "Always"));

        var cookie = await SignInCookieAsync(host, email, origin: HomebreweryApiFactory.Origin);

        Assert.Contains("secure", cookie.Attributes);
    }

    [Theory]
    [InlineData("None")]
    [InlineData("Sometimes")]
    public async Task Other_policies_stop_the_host(string policy)
    {
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(AuthCookies.SecurePolicyKey, policy));

        var error = Assert.ThrowsAny<Exception>(() => host.Services);

        Assert.Contains(AuthCookies.SecurePolicyKey, error.ToString(), StringComparison.Ordinal);
    }

    private async Task<string> RegisterAsync()
    {
        var email = TestUsers.UniqueEmail("cookie");
        await api.Factory.RegisterAsync(email, ct: TestContext.Current.CancellationToken);
        return email;
    }

    /// <summary>Signs in with <c>useCookies=true</c> and returns the sign-in cookie's lower-cased attributes.</summary>
    internal static async Task<SetCookie> SignInCookieAsync(WebApplicationFactory<Program> host, string email, string origin,
        IReadOnlyDictionary<string, string>? headers = null)
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = host.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false });
        client.DefaultRequestHeaders.Remove("Origin");
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/login?useCookies=true")
        {
            Content = JsonContent.Create(new { email, password = TestUsers.Password }),
        };
        request.Headers.TryAddWithoutValidation("Origin", origin);
        foreach (var (name, value) in headers ?? new Dictionary<string, string>()) request.Headers.TryAddWithoutValidation(name, value);

        using var response = await client.SendAsync(request, ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var header = response.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith($"{CookieName}=", StringComparison.Ordinal));
        return SetCookie.Parse(header);
    }
}

/// <summary>A parsed <c>Set-Cookie</c> header: <c>name=value</c> plus its attributes, lower-cased and trimmed.</summary>
internal sealed record SetCookie(string NameValue, IReadOnlyList<string> Attributes)
{
    public static SetCookie Parse(string header)
    {
        var parts = header.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        return new SetCookie(parts[0], [.. parts.Skip(1).Select(p => p.ToLowerInvariant())]);
    }
}
