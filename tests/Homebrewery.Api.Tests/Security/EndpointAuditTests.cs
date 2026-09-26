using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P8.3 review of plan §14 ("upstream behaviour to drop") against the endpoint table itself, so routes added later are
/// checked too: every admin route needs the Admin role, every write outside the Identity endpoints needs a signed-in
/// user, there is no broadcast stream, a fresh install has no default admin, and the session never reaches scripts.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class EndpointAuditTests(ApiFixture api)
{
    private List<RouteEndpoint> Endpoints =>
        api.Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>().ToList();

    // §14: "/admin/compress/:id and /admin/clean/script/:id have no admin check".
    [Fact]
    public void Every_admin_route_requires_the_admin_role()
    {
        var admin = Endpoints.Where(e => Pattern(e).StartsWith("/api/admin", StringComparison.OrdinalIgnoreCase)).ToList();

        Assert.NotEmpty(admin);
        Assert.All(admin, e =>
        {
            Assert.Contains(e.Metadata.GetOrderedMetadata<IAuthorizeData>(), a => a.Policy == Policies.Admin);
            Assert.Null(e.Metadata.GetMetadata<IAllowAnonymous>());
        });
    }

    // §14: writes must be tied to an account (CSRF and authz rest on it). The Identity endpoints (register, login,
    // password reset, ...) are the only anonymous writes.
    [Fact]
    public void Every_write_outside_the_identity_endpoints_requires_a_signed_in_user()
    {
        var writes = Endpoints
            .Where(e => e.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods.Any(RateLimits.IsWrite) == true)
            .Where(e => !Pattern(e).StartsWith("/api/auth/", StringComparison.OrdinalIgnoreCase))
            .ToList();

        Assert.NotEmpty(writes);
        Assert.All(writes, e =>
        {
            Assert.True(e.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0, $"{Describe(e)} does not require authorization.");
            Assert.Null(e.Metadata.GetMetadata<IAllowAnonymous>());
        });
    }

    // §14: "The /stream endpoint broadcasts every save to every listener and never removes listeners."
    [Fact]
    public void There_is_no_broadcast_stream()
    {
        Assert.DoesNotContain(Endpoints, e => Pattern(e).Contains("stream", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(Endpoints, e => e.Metadata.GetOrderedMetadata<IProducesResponseTypeMetadata>()
            .Any(p => p.ContentTypes.Any(c => c.Contains("event-stream", StringComparison.OrdinalIgnoreCase))));
    }

    // §14: "Admin credentials default to admin / password3."
    [Fact]
    public async Task A_fresh_install_has_no_admin_account_and_no_default_password()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var scratch = await ScratchDatabase.CreateAsync(api.ConnectionString, ct);
        await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:Homebrewery", scratch.ConnectionString));
        using var client = host.CreateClient();

        using var login = await client.PostAsJsonAsync("/api/auth/login?useCookies=true", new { email = "admin", password = "password3" }, ct);
        using var basic = new HttpRequestMessage(HttpMethod.Get, "/api/admin/stats");
        basic.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes("admin:password3")));
        using var stats = await client.SendAsync(basic, ct);
        var (users, admins) = await host.WithServicesAsync(async s => (
            await s.GetRequiredService<AppDbContext>().Users.CountAsync(ct),
            (await s.GetRequiredService<UserManager<AppUser>>().GetUsersInRoleAsync(Roles.Admin)).Count));

        Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, stats.StatusCode);
        Assert.Equal(0, users);
        Assert.Equal(0, admins);
    }

    // §14: "The whole session token, including Google OAuth tokens, is sent to the browser, and the cookie is not
    // HttpOnly."
    [Fact]
    public async Task Cookie_sign_in_gives_scripts_no_token()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail("session");
        await api.Factory.RegisterAsync(email, ct: ct);
        using var client = api.Factory.CreateClient();

        using var login = await client.PostAsJsonAsync("/api/auth/login?useCookies=true", new { email, password = TestUsers.Password }, ct);
        var body = await login.Content.ReadAsStringAsync(ct);
        using var me = await client.GetAsync("/api/account/me", ct);
        var account = await me.Content.ReadFromJsonAsync<JsonElement>(ct);

        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Equal("", body);                                                           // no access or refresh token
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"));
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["email", "handle", "id", "roles"], account.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal));
    }

    private static string Pattern(RouteEndpoint endpoint) => endpoint.RoutePattern.RawText ?? "";

    private static string Describe(RouteEndpoint endpoint) =>
        $"{string.Join(",", endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods ?? [])} {Pattern(endpoint)}";
}
