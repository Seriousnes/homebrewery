using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Homebrewery.Api.Tests.Operations;

/// <summary>A host of the API whose log entries are captured (<see cref="LogCapture"/>), request logs down to Debug.</summary>
public sealed class CapturedLogHost(ApiFixture api) : IAsyncDisposable
{
    public const string RequestCategory = "Homebrewery.Api.Infrastructure.RequestLogging";

    public LogCapture Logs { get; } = new();

    private WebApplicationFactory<Program>? _factory;

    public WebApplicationFactory<Program> Factory => _factory ??= api.Factory.WithWebHostBuilder(b => b
        .UseSetting($"Logging:LogLevel:{RequestCategory}", "Debug")
        .ConfigureTestServices(s => s.AddSingleton<ILoggerProvider>(Logs)));

    /// <summary>The <c>RequestFinished</c> entries (<see cref="RequestLogging"/>, event 1).</summary>
    public IReadOnlyList<CapturedLog> Requests() =>
        [.. Logs.ForCategory(RequestCategory).Where(e => e.EventId.Name == "RequestFinished")];

    public async ValueTask DisposeAsync()
    {
        if (_factory is not null) await _factory.DisposeAsync();
    }
}

/// <summary>
/// Request logging (plan P8.4): one entry per request with the method, the route template
/// (never the raw path or query), the status and the duration, and no cookies, bodies or other request data anywhere
/// in the log (the hosting diagnostics' RequestPath scope is off).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class RequestLoggingTests(ApiFixture api) : IAsyncLifetime
{
    private readonly CapturedLogHost _host = new(api);

    public ValueTask InitializeAsync()
    {
        _ = _host.Factory.Services;                 // start the host before the tests clear the log
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => _host.DisposeAsync();

    [Fact]
    public async Task A_request_is_logged_once_with_its_route_template_and_no_request_data()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = _host.Factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/brews/edit/SECRETEDITID42?token=secret-query-value");
        request.Headers.Add("Cookie", "hb-session=secret-cookie-value");
        request.Headers.Add("User-Agent", "secret-agent/1.0");
        _host.Logs.Clear();

        using var response = await client.SendAsync(request, ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        var entry = Assert.Single(_host.Requests());
        Assert.Equal(LogLevel.Information, entry.Level);
        Assert.Equal(1, entry.EventId.Id);
        Assert.Equal("GET", entry.State["Method"]);
        Assert.Equal("/api/brews/edit/{editId}", entry.State["Route"]);
        Assert.Equal(401, entry.State["StatusCode"]);
        var elapsed = Assert.IsType<double>(entry.State["ElapsedMs"]);
        Assert.InRange(elapsed, 0, 60_000);
        Assert.StartsWith("GET /api/brews/edit/{editId} responded 401 in ", entry.Message, StringComparison.Ordinal);

        foreach (var log in _host.Logs.Entries)
        {
            var text = log.AllText();
            Assert.DoesNotContain("SECRETEDITID42", text, StringComparison.Ordinal);
            Assert.DoesNotContain("secret-", text, StringComparison.Ordinal);
            Assert.All(log.Scopes, scope => Assert.False(scope.ContainsKey("RequestPath"), $"{log.Category} has a RequestPath scope"));
        }
    }

    [Fact]
    public async Task Entries_carry_the_RequestId_that_problem_responses_return_as_traceId()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = _host.Factory.CreateClient();
        _host.Logs.Clear();

        using var response = await client.GetAsync("/api/no-such-endpoint/abc", ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<Dictionary<string, object>>(ct);
        var traceId = problem?["traceId"]?.ToString();
        Assert.False(string.IsNullOrEmpty(traceId));
        var entry = Assert.Single(_host.Requests());
        Assert.Equal("/api/{**path}", entry.State["Route"]);
        Assert.Equal(404, entry.State["StatusCode"]);
        Assert.Contains(entry.Scopes, s => s.TryGetValue("RequestId", out var id) && Equals(id, traceId));
    }

    [Fact]
    public async Task Successful_health_probes_are_Debug_entries()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = _host.Factory.CreateClient();
        _host.Logs.Clear();

        (await client.GetAsync(HealthEndpoints.Path, ct)).Dispose();
        (await client.GetAsync(HealthEndpoints.LivePath, ct)).Dispose();
        (await client.GetAsync(HealthEndpoints.ReadyPath, ct)).Dispose();

        var entries = _host.Requests();
        Assert.Equal([HealthEndpoints.Path, HealthEndpoints.LivePath, HealthEndpoints.ReadyPath], entries.Select(e => e.State["Route"]));
        Assert.All(entries, e => Assert.Equal(LogLevel.Debug, e.Level));
        Assert.All(entries, e => Assert.Equal(200, e.State["StatusCode"]));
    }

    [Fact]
    public async Task Requests_without_an_endpoint_log_their_path_without_the_query()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = _host.Factory.CreateClient();
        _host.Logs.Clear();

        using var response = await client.GetAsync("/assets/missing-file.js?v=secret-query-value", ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var entry = Assert.Single(_host.Requests());
        Assert.Equal("/assets/missing-file.js", entry.State["Route"]);
        Assert.Equal(LogLevel.Information, entry.Level);         // a miss is not a Debug-level static file
        Assert.DoesNotContain("secret", entry.AllText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Client_side_routes_log_the_SPA_fallback_template()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = _host.Factory.CreateClient();
        _host.Logs.Clear();

        (await client.GetAsync("/user/some-private-handle", ct)).Dispose();

        var entry = Assert.Single(_host.Requests());
        Assert.DoesNotContain("some-private-handle", entry.AllText(), StringComparison.Ordinal);
        Assert.StartsWith("/{*", (string)entry.State["Route"]!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_exception_that_escapes_the_pipeline_is_logged_as_a_500_Error_and_rethrown()
    {
        var logs = new LogCapture();
        using var factory = new LoggerFactory([logs]);
        var middleware = new RequestLogging(_ => throw new InvalidOperationException("boom"), factory.CreateLogger<RequestLogging>());
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.Path = "/api/brews";
        context.SetEndpoint(new RouteEndpoint(_ => Task.CompletedTask, RoutePatternFactory.Parse("/api/brews"), 0, null, "CreateBrew"));

        await Assert.ThrowsAsync<InvalidOperationException>(() => middleware.InvokeAsync(context));

        var entry = Assert.Single(logs.Entries);
        Assert.Equal(LogLevel.Error, entry.Level);
        Assert.Equal(500, entry.State["StatusCode"]);
        Assert.Equal("/api/brews", entry.State["Route"]);
        Assert.Equal("POST", entry.State["Method"]);
    }

    [Theory]
    [InlineData(200, "/healthz", true, LogLevel.Debug)]
    [InlineData(200, "/healthz/ready", true, LogLevel.Debug)]
    [InlineData(503, "/healthz", true, LogLevel.Error)]
    [InlineData(200, "/assets/app.js", false, LogLevel.Debug)]
    [InlineData(304, "/assets/app.js", false, LogLevel.Debug)]
    [InlineData(404, "/assets/app.js", false, LogLevel.Information)]
    [InlineData(200, "/api/brews/edit/{editId}", true, LogLevel.Information)]
    [InlineData(409, "/api/brews/{editId}", true, LogLevel.Information)]
    [InlineData(500, "/api/brews", true, LogLevel.Error)]
    public void Levels(int status, string route, bool hasEndpoint, LogLevel expected) =>
        Assert.Equal(expected, RequestLogging.LevelFor(status, route, hasEndpoint));

    [Fact]
    public void Long_paths_without_an_endpoint_are_cut()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/" + new string('a', RequestLogging.MaxPathLength * 2);

        var route = RequestLogging.RouteOf(null, context.Request);

        Assert.Equal(RequestLogging.MaxPathLength + 1, route.Length);
        Assert.EndsWith("…", route, StringComparison.Ordinal);
        Assert.Equal("/", RequestLogging.RouteOf(null, new DefaultHttpContext().Request));
    }

    [Fact]
    public void Route_templates_get_a_leading_slash()
    {
        var endpoint = new RouteEndpoint(_ => Task.CompletedTask, RoutePatternFactory.Parse("api/x/{id}"), 0, null, null);

        Assert.Equal("/api/x/{id}", RequestLogging.RouteOf(endpoint, new DefaultHttpContext().Request));
    }
}
