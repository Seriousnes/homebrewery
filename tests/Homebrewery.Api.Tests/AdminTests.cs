using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Admin;
using Homebrewery.Api.Endpoints;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests;

/// <summary>P2.2: the Admin policy and the Admin role seeded from <c>Admin:Emails</c>.</summary>
[Collection(ApiCollection.Name)]
public sealed class AdminTests(ApiFixture api)
{
    [Fact]
    public async Task Admin_endpoints_return_401_when_anonymous()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient(new() { AllowAutoRedirect = false });

        using var response = await client.GetAsync("/api/admin/stats", ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Admin_endpoints_return_403_for_signed_in_non_admins()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);

        using var response = await user.Client.GetAsync("/api/admin/stats", ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    [Fact]
    public async Task Admin_endpoints_answer_admins()
    {
        var ct = TestContext.Current.CancellationToken;
        using var admin = await api.Factory.CreateAdminAsync(ct);

        var stats = await admin.Client.GetFromJsonAsync<AdminStats>("/api/admin/stats", ct);
        var me = await admin.Client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct);

        Assert.True(stats?.Users >= 1);
        Assert.Equal(new[] { Roles.Admin }, me?.Roles);
    }

    [Fact]
    public async Task Listed_emails_get_the_role_on_registration()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail("listed");
        await using var host = WithAdminEmails(email.ToUpperInvariant());            // matching ignores case

        await host.RegisterAsync(email, ct: ct);
        var isAdmin = await IsInAdminRoleAsync(host, email);
        using var admin = await host.SignInUserAsync(email, ct);
        using var stats = await admin.Client.GetAsync("/api/admin/stats", ct);

        Assert.True(isAdmin);
        Assert.Equal(HttpStatusCode.OK, stats.StatusCode);
    }

    [Fact]
    public async Task Listed_emails_get_the_role_at_startup()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail("existing");
        await api.Factory.RegisterAsync(email, ct: ct);                             // not listed on the shared host
        Assert.False(await IsInAdminRoleAsync(api.Factory, email));

        await using var host = WithAdminEmails($"someone-else@homebrewery.test; {email}");
        _ = host.Services;                                                           // start: seeds before any sign-in

        Assert.True(await IsInAdminRoleAsync(host, email));
    }

    [Fact]
    public async Task Listed_emails_get_the_role_on_sign_in()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail("late");
        await using var host = WithAdminEmails(email);
        _ = host.Services;                                                           // started before the account exists
        await api.Factory.RegisterAsync(email, ct: ct);                             // registered where it is not listed
        Assert.False(await IsInAdminRoleAsync(api.Factory, email));

        using var admin = await host.SignInUserAsync(email, ct);
        var me = await admin.Client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct);
        using var stats = await admin.Client.GetAsync("/api/admin/stats", ct);

        Assert.Equal(new[] { Roles.Admin }, me?.Roles);
        Assert.Equal(HttpStatusCode.OK, stats.StatusCode);
    }

    [Fact]
    public async Task Listed_emails_must_be_confirmed_unless_configured_otherwise()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail("unconfirmed");
        await using var host = WithAdminEmails(email, requireConfirmedEmail: true);

        await host.RegisterAsync(email, ct: ct);
        using (var unconfirmed = await host.SignInUserAsync(email, ct))
        {
            using var denied = await unconfirmed.Client.GetAsync("/api/admin/stats", ct);
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        }

        await host.WithServicesAsync(async services =>
        {
            var users = services.GetRequiredService<UserManager<AppUser>>();
            var user = await users.FindByEmailAsync(email);
            user!.EmailConfirmed = true;
            await users.UpdateAsync(user);
        });
        using var confirmed = await host.SignInUserAsync(email, ct);
        using var allowed = await confirmed.Client.GetAsync("/api/admin/stats", ct);

        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    /// <summary>A second host on the test database with its own admin configuration.</summary>
    private WebApplicationFactory<Program> WithAdminEmails(string emails, bool requireConfirmedEmail = false) =>
        api.Factory.WithWebHostBuilder(b => b
            .UseSetting("Admin:Emails", emails)
            .UseSetting("Admin:RequireConfirmedEmail", requireConfirmedEmail ? "true" : "false"));

    private static Task<bool> IsInAdminRoleAsync(WebApplicationFactory<Program> host, string email) =>
        host.WithServicesAsync(async services =>
        {
            var users = services.GetRequiredService<UserManager<AppUser>>();
            var user = await users.FindByEmailAsync(email) ?? throw new InvalidOperationException($"No account for {email}.");
            return await users.IsInRoleAsync(user, Roles.Admin);
        });
}
