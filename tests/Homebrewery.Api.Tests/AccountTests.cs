using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Endpoints;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests;

/// <summary>P2.2: registration, cookie login and logout, /api/account/me and handles.</summary>
[Collection(ApiCollection.Name)]
public sealed class AccountTests(ApiFixture api)
{
    [Fact]
    public async Task Register_then_login_with_cookie_signs_in()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail();
        using var client = api.Factory.CreateClient();

        using var register = await client.PostAsJsonAsync("/api/auth/register", new { email, password = TestUsers.Password }, ct);
        using var login = await client.PostAsJsonAsync(
            "/api/auth/login?useCookies=true", new { email, password = TestUsers.Password }, ct);
        var me = await client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.OK, register.StatusCode);
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith(".AspNetCore.Identity.Application=", StringComparison.Ordinal));
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=lax", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.NotNull(me);
        Assert.Equal(email, me.Email);
        Assert.Equal(Handles.FromEmail(email), me.Handle);
        Assert.Empty(me.Roles);
        var stored = await api.Factory.WithServicesAsync(sp => sp.GetRequiredService<UserManager<AppUser>>().FindByEmailAsync(email));
        Assert.Equal(stored?.Id, me.Id);
    }

    [Fact]
    public async Task Registering_a_taken_email_looks_like_a_new_registration()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail();
        using var client = api.Factory.CreateClient();

        using var first = await client.PostAsJsonAsync("/api/auth/register", new { email, password = TestUsers.Password }, ct);
        using var second = await client.PostAsJsonAsync("/api/auth/register", new { email, password = "Other-Passw0rd!" }, ct);
        using var withFirst = await client.PostAsJsonAsync("/api/auth/login", new { email, password = TestUsers.Password }, ct);
        using var withSecond = await client.PostAsJsonAsync("/api/auth/login", new { email, password = "Other-Passw0rd!" }, ct);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(await first.Content.ReadAsStringAsync(ct), await second.Content.ReadAsStringAsync(ct));
        Assert.Equal(first.Content.Headers.ContentType?.MediaType, second.Content.Headers.ContentType?.MediaType);
        Assert.Equal(HttpStatusCode.OK, withFirst.StatusCode);                  // the account did not change
        Assert.Equal(HttpStatusCode.Unauthorized, withSecond.StatusCode);
    }

    [Fact]
    public async Task Password_rules_are_still_reported_on_register()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail();
        await api.Factory.RegisterAsync(email, ct: ct);
        using var client = api.Factory.CreateClient();

        using var weakNew = await client.PostAsJsonAsync("/api/auth/register", new { email = TestUsers.UniqueEmail(), password = "short" }, ct);
        using var weakTaken = await client.PostAsJsonAsync("/api/auth/register", new { email, password = "short" }, ct);

        Assert.Equal(HttpStatusCode.BadRequest, weakNew.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, weakTaken.StatusCode);
        var errors = (await weakTaken.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("errors");
        Assert.DoesNotContain(errors.EnumerateObject(), e => e.Name.StartsWith("Duplicate", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Login_with_a_wrong_password_returns_401()
    {
        var ct = TestContext.Current.CancellationToken;
        var email = TestUsers.UniqueEmail();
        await api.Factory.RegisterAsync(email, ct: ct);
        using var client = api.Factory.CreateClient();

        using var login = await client.PostAsJsonAsync("/api/auth/login?useCookies=true", new { email, password = "Wr0ng-password" }, ct);
        using var me = await client.GetAsync("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, me.StatusCode);
    }

    [Fact]
    public async Task Me_returns_204_when_anonymous()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();

        using var response = await client.GetAsync("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    [Fact]
    public async Task Me_returns_the_signed_in_account()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);

        using var response = await user.Client.GetAsync("/api/account/me", ct);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>(ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(user.Id.ToString(), json.GetProperty("id").GetString());
        Assert.Equal(user.Handle, json.GetProperty("handle").GetString());
        Assert.Equal(user.Email, json.GetProperty("email").GetString());
        Assert.Equal(JsonValueKind.Array, json.GetProperty("roles").ValueKind);
    }

    [Fact]
    public async Task Logout_clears_the_cookie()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);

        using var logout = await user.Client.PostAsync("/api/account/logout", null, ct);
        using var me = await user.Client.GetAsync("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, me.StatusCode);
    }

    [Theory]
    [InlineData("POST", "/api/account/logout")]
    [InlineData("PUT", "/api/account/handle")]
    [InlineData("GET", "/api/admin/stats")]
    public async Task Protected_endpoints_return_401_not_a_redirect_when_anonymous(string method, string path)
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient(new() { AllowAutoRedirect = false });
        using var request = new HttpRequestMessage(new HttpMethod(method), path)
        {
            Content = method == "GET" ? null : JsonContent.Create(new { handle = "someone" }),
        };

        using var response = await client.SendAsync(request, ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    [Fact]
    public async Task New_accounts_get_a_default_handle_from_the_email_de_duplicated_with_a_suffix()
    {
        var ct = TestContext.Current.CancellationToken;
        var name = "jane" + Guid.NewGuid().ToString("N")[..8];
        var expected = $"{name}-doe";

        using var first = await api.Factory.CreateUserAsync($"{name.ToUpperInvariant()}.Doe+news@example.test", ct);
        using var second = await api.Factory.CreateUserAsync($"{name}.doe@other.test", ct);
        using var third = await api.Factory.CreateUserAsync($"{name}-doe@third.test", ct);

        Assert.Equal(expected, first.Handle);
        Assert.Equal($"{expected}-2", second.Handle);
        Assert.Equal($"{expected}-3", third.Handle);
    }

    [Fact]
    public async Task Default_handles_are_padded_or_truncated_to_valid_lengths()
    {
        var ct = TestContext.Current.CancellationToken;
        var suffix = Guid.NewGuid().ToString("N")[..6];

        using var tooShort = await api.Factory.CreateUserAsync($"q@{suffix}.example.test", ct);
        using var tooLong = await api.Factory.CreateUserAsync($"{suffix}{new string('x', 40)}@example.test", ct);

        Assert.StartsWith("user-q", tooShort.Handle, StringComparison.Ordinal);    // "user-q", or "user-q-2", …
        Assert.True(Handles.IsValid(tooShort.Handle));
        Assert.Equal(Handles.MaxLength, tooLong.Handle.Length);
        Assert.StartsWith(suffix, tooLong.Handle, StringComparison.Ordinal);
        Assert.True(Handles.IsValid(tooLong.Handle));
    }

    [Fact]
    public async Task Set_handle_normalizes_to_lower_case_and_updates_me()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var wanted = "New_Handle-" + Guid.NewGuid().ToString("N")[..8];

        using var response = await user.Client.PutAsJsonAsync("/api/account/handle", new { handle = $"  {wanted} " }, ct);
        var body = await response.Content.ReadFromJsonAsync<AccountInfo>(ct);
        var me = await user.Client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(wanted.ToLowerInvariant(), body?.Handle);
        Assert.Equal(wanted.ToLowerInvariant(), me?.Handle);
    }

    [Fact]
    public async Task Setting_your_current_handle_again_succeeds()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);

        using var response = await user.Client.PutAsJsonAsync("/api/account/handle", new { handle = user.Handle.ToUpperInvariant() }, ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Theory]
    [InlineData("ab")]                                     // too short
    [InlineData("abcdefghijklmnopqrstuvwxyz0123456")]      // 33 characters
    [InlineData("has space")]
    [InlineData("dots.not.allowed")]
    [InlineData("héllo")]
    [InlineData("semi;colon")]
    [InlineData("")]
    [InlineData(null)]
    public async Task Set_handle_rejects_invalid_handles_with_400(string? handle)
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);

        using var response = await user.Client.PutAsJsonAsync("/api/account/handle", new { handle }, ct);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        var me = await user.Client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.True(problem.GetProperty("errors").TryGetProperty("handle", out _));
        Assert.Equal(user.Handle, me?.Handle);
    }

    [Fact]
    public async Task Set_handle_returns_409_when_another_account_has_it_in_any_case()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        using var other = await api.Factory.CreateUserAsync(ct: ct);

        using var same = await other.Client.PutAsJsonAsync("/api/account/handle", new { handle = owner.Handle }, ct);
        using var upper = await other.Client.PutAsJsonAsync("/api/account/handle", new { handle = owner.Handle.ToUpperInvariant() }, ct);
        var me = await other.Client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct);

        Assert.Equal(HttpStatusCode.Conflict, same.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, upper.StatusCode);
        Assert.Equal("application/problem+json", same.Content.Headers.ContentType?.MediaType);
        Assert.Equal(other.Handle, me?.Handle);
    }
}
