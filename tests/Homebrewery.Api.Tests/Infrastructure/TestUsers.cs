using System.Net.Http.Json;
using Homebrewery.Api.Endpoints;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>A registered account and an <see cref="HttpClient"/> signed in as it (auth cookie).</summary>
public sealed record TestUser(Guid Id, string Handle, string Email, string Password, HttpClient Client) : IDisposable
{
    public void Dispose() => Client.Dispose();
}

/// <summary>
/// Account helpers for any <see cref="WebApplicationFactory{TEntryPoint}"/> of the API (the shared
/// <see cref="ApiFixture.Factory"/> or one derived with <c>WithWebHostBuilder</c>). They go through
/// the real endpoints: <c>POST /api/auth/register</c> and <c>POST /api/auth/login?useCookies=true</c>.
/// </summary>
public static class TestUsers
{
    /// <summary>Satisfies Identity's default password rules.</summary>
    public const string Password = "Passw0rd!";

    /// <summary>A fresh address; its local part (the default handle) is unique too.</summary>
    public static string UniqueEmail(string prefix = "user") =>
        $"{prefix}-{Guid.NewGuid().ToString("N")[..10]}@homebrewery.test";

    public static async Task RegisterAsync(this WebApplicationFactory<Program> factory,
        string email, string password = Password, CancellationToken ct = default)
    {
        using var client = factory.CreateClient();
        using var response = await client.PostAsJsonAsync("/api/auth/register", new { email, password }, ct);
        await EnsureSuccessAsync(response, "register", ct);
    }

    /// <summary>A new client signed in with the auth cookie. Dispose it.</summary>
    public static async Task<HttpClient> SignInAsync(this WebApplicationFactory<Program> factory,
        string email, string password = Password, CancellationToken ct = default)
    {
        var client = factory.CreateClient();                    // handles cookies
        try
        {
            using var response = await client.PostAsJsonAsync(
                "/api/auth/login?useCookies=true", new { email, password }, ct);
            await EnsureSuccessAsync(response, "login", ct);
            return client;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    /// <summary>Registers a new account (default: unique email) and signs it in.</summary>
    public static async Task<TestUser> CreateUserAsync(this WebApplicationFactory<Program> factory,
        string? email = null, CancellationToken ct = default)
    {
        email ??= UniqueEmail();
        await factory.RegisterAsync(email, ct: ct);
        return await factory.SignInUserAsync(email, ct);
    }

    /// <summary>Registers a new account, adds it to the Admin role directly, and signs it in.</summary>
    public static async Task<TestUser> CreateAdminAsync(this WebApplicationFactory<Program> factory, CancellationToken ct = default)
    {
        var email = UniqueEmail("admin");
        await factory.RegisterAsync(email, ct: ct);
        await factory.WithServicesAsync(async services =>
        {
            var users = services.GetRequiredService<UserManager<AppUser>>();
            var user = await users.FindByEmailAsync(email) ?? throw new InvalidOperationException($"{email} was not registered.");
            var result = await users.AddToRoleAsync(user, Roles.Admin);
            if (!result.Succeeded) throw new InvalidOperationException(string.Join("; ", result.Errors.Select(e => e.Description)));
        });
        return await factory.SignInUserAsync(email, ct);           // the role claim is issued at sign-in
    }

    /// <summary>Signs in an existing account and reads its id and handle from <c>/api/account/me</c>.</summary>
    public static async Task<TestUser> SignInUserAsync(this WebApplicationFactory<Program> factory,
        string email, CancellationToken ct = default)
    {
        var client = await factory.SignInAsync(email, ct: ct);
        var me = await client.GetFromJsonAsync<AccountInfo>("/api/account/me", ct)
                 ?? throw new InvalidOperationException("/api/account/me returned no account after sign-in.");
        return new TestUser(me.Id, me.Handle, email, Password, client);
    }

    /// <summary>Runs <paramref name="action"/> in a DI scope of the host (UserManager, AppDbContext, …).</summary>
    public static async Task WithServicesAsync(this WebApplicationFactory<Program> factory, Func<IServiceProvider, Task> action)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await action(scope.ServiceProvider);
    }

    /// <inheritdoc cref="WithServicesAsync(WebApplicationFactory{Program}, Func{IServiceProvider, Task})"/>
    public static async Task<T> WithServicesAsync<T>(this WebApplicationFactory<Program> factory, Func<IServiceProvider, Task<T>> action)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await action(scope.ServiceProvider);
    }

    /// <summary>Runs <paramref name="action"/> with a scoped <see cref="AppDbContext"/> of the host.</summary>
    public static Task<T> WithDbAsync<T>(this WebApplicationFactory<Program> factory, Func<AppDbContext, Task<T>> action) =>
        factory.WithServicesAsync(services => action(services.GetRequiredService<AppDbContext>()));

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string step, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(ct);
        throw new HttpRequestException($"{step} failed: {(int)response.StatusCode} {body}", null, response.StatusCode);
    }
}
