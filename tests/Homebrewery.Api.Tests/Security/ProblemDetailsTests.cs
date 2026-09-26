using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Notifications;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.RequestDecompression;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P2.7 ProblemDetails and request limits: unhandled exceptions and bodyless API errors are problem+json; request
/// bodies are capped at 20 MB and may be gzip-compressed.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ProblemDetailsTests(ApiFixture api)
{
    [Fact]
    public async Task Unhandled_exceptions_are_500_problems_without_internals()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var host = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
            s.AddScoped<NotificationService>(_ => throw new InvalidOperationException("secret connection detail"))));
        using var client = host.CreateClient();

        using var response = await client.GetAsync("/api/notifications/active", ct);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Content.ReadAsStringAsync(ct);
        Assert.Equal(500, JsonDocument.Parse(body).RootElement.GetProperty("status").GetInt32());
        Assert.DoesNotContain("secret connection detail", body, StringComparison.Ordinal);    // details only in Development
    }

    [Fact]
    public async Task Binding_errors_are_400_problems_when_minimal_apis_throw_as_in_development()
    {
        var ct = TestContext.Current.CancellationToken;
        // Development sets ThrowOnBadRequest, so binding failures reach the exception handler instead of a plain 400.
        await using var host = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
            s.Configure<Microsoft.AspNetCore.Routing.RouteHandlerOptions>(o => o.ThrowOnBadRequest = true)));
        using var user = await host.CreateUserAsync(ct: ct);
        var brew = await BrewApi.CreateAsync(user.Client, new { }, ct);

        using var noBaseVersion = await user.Client.PutAsync($"/api/brews/{brew.EditId}",
            new StringContent("""{"doc":{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]}}""", System.Text.Encoding.UTF8, "application/json"), ct);
        using var truncated = await user.Client.PostAsync("/api/brews", new StringContent("""{"doc":""", System.Text.Encoding.UTF8, "application/json"), ct);
        using var badPage = await user.Client.GetAsync("/api/vault?q=x&page=abc", ct);

        foreach (var response in new[] { noBaseVersion, truncated, badPage })
        {
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        }
    }

    [Theory]
    [InlineData("GET", "/api/admin/stats", HttpStatusCode.Unauthorized)]                  // authorization: empty 401
    [InlineData("POST", "/api/account/logout", HttpStatusCode.Unauthorized)]
    [InlineData("GET", "/api/brews/edit/abc123XYZabc", HttpStatusCode.Unauthorized)]
    [InlineData("GET", "/api/nothing/here", HttpStatusCode.NotFound)]
    public async Task Bodyless_api_errors_become_problems(string method, string path, HttpStatusCode expected)
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();

        using var response = await client.SendAsync(new HttpRequestMessage(new HttpMethod(method), path), ct);

        Assert.Equal(expected, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal((int)expected, problem.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task Non_api_errors_are_left_alone()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();

        using var response = await client.GetAsync("/assets/missing.png", ct);          // a file path: no SPA fallback

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotEqual("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public void Kestrel_caps_request_bodies_at_20_MB()
    {
        var kestrel = api.Factory.Services.GetRequiredService<IOptions<KestrelServerOptions>>().Value;

        Assert.Equal(20L * 1024 * 1024, kestrel.Limits.MaxRequestBodySize);
        Assert.Equal(BrewRules.MaxRequestBytes, kestrel.Limits.MaxRequestBodySize);
    }

    [Fact]
    public void Gzip_brotli_and_deflate_bodies_are_decompressed()
    {
        var options = api.Factory.Services.GetRequiredService<IOptions<RequestDecompressionOptions>>().Value;

        Assert.Equal(["br", "deflate", "gzip"], options.DecompressionProviders.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Bodies_that_inflate_past_the_cap_are_413_problems()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        var padding = new string(' ', (int)BrewRules.MaxRequestBytes);
        var json = $$$"""{{{{padding}}}"meta":{"title":"too big"}}""";

        using var response = await user.Client.PostAsync("/api/brews", BrewApi.Gzip(json), ct);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }
}
