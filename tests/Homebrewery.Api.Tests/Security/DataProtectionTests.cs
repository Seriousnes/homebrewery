using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P8 hardening: with <c>DataProtection:KeysPath</c> the key ring that encrypts sign-in cookies lives in that directory
/// (a volume in the production image), so a new container accepts the cookies an earlier one issued.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class DataProtectionTests(ApiFixture api)
{
    [Fact]
    public async Task A_new_host_with_the_same_key_directory_accepts_earlier_sign_ins()
    {
        var ct = TestContext.Current.CancellationToken;
        var keys = Directory.CreateTempSubdirectory("hb-keys-");
        var otherKeys = Directory.CreateTempSubdirectory("hb-keys-other-");
        try
        {
            var email = TestUsers.UniqueEmail("keys");
            await api.Factory.RegisterAsync(email, ct: ct);

            string cookie;
            await using (var first = HostWithKeys(keys.FullName))
            {
                cookie = (await AuthCookieTests.SignInCookieAsync(first, email, HomebreweryApiFactory.Origin)).NameValue;
                Assert.NotEmpty(keys.GetFiles("key-*.xml"));
                Assert.Equal(email, await MeAsync(first, cookie, ct));
            }

            await using (var restarted = HostWithKeys(keys.FullName))
            {
                Assert.Equal(email, await MeAsync(restarted, cookie, ct));
            }

            await using (var otherRing = HostWithKeys(otherKeys.FullName))
            {
                Assert.Null(await MeAsync(otherRing, cookie, ct));             // proves the keys came from the directory
            }

            Assert.Single(keys.GetFiles("key-*.xml"));
        }
        finally
        {
            TryDelete(keys);
            TryDelete(otherKeys);
        }
    }

    [Fact]
    public async Task A_key_directory_that_cannot_be_created_stops_the_host()
    {
        var file = Path.GetTempFileName();                                      // a file where the directory should be
        try
        {
            await using var host = HostWithKeys(file);

            var error = Assert.ThrowsAny<Exception>(() => host.Services);

            Assert.Contains("Data Protection keys cannot be created or read", error.ToString(), StringComparison.Ordinal);
            Assert.Contains(DataProtectionSetup.KeysPathKey, error.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public void Relative_key_paths_resolve_against_the_content_root()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [DataProtectionSetup.KeysPathKey] = "keys" })
            .Build();
        var environment = new TestEnvironment { ContentRootPath = Path.Combine(Path.GetTempPath(), "hb-root") };

        var directory = DataProtectionSetup.KeysDirectory(configuration, environment);

        Assert.Equal(Path.Combine(Path.GetTempPath(), "hb-root", "keys"), directory?.FullName);
        Assert.Null(DataProtectionSetup.KeysDirectory(new ConfigurationBuilder().Build(), environment));
    }

    private WebApplicationFactory<Program> HostWithKeys(string path) =>
        api.Factory.WithWebHostBuilder(b => b.UseSetting(DataProtectionSetup.KeysPathKey, path));

    /// <summary>The signed-in account's email for <paramref name="cookie"/>, or null when the host treats it as anonymous.</summary>
    private static async Task<string?> MeAsync(WebApplicationFactory<Program> host, string cookie, CancellationToken ct)
    {
        using var client = host.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false });
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/account/me");
        request.Headers.TryAddWithoutValidation("Cookie", cookie);
        using var response = await client.SendAsync(request, ct);
        if (response.StatusCode == HttpStatusCode.NoContent) return null;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<Me>(ct))?.Email;
    }

    private static void TryDelete(DirectoryInfo directory)
    {
        try
        {
            directory.Delete(recursive: true);
        }
        catch (IOException)
        {
            // Best effort on Windows.
        }
    }

    private sealed record Me(string Email);

    private sealed class TestEnvironment : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Testing";
        public string ApplicationName { get; set; } = "Homebrewery.Api";
        public string ContentRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}
