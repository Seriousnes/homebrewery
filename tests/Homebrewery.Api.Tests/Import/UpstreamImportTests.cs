using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Homebrewery.Api.Import;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests.Import;

/// <summary>
/// P2.8: <c>GET /api/import/homebrewery/{shareId}</c> fetches <c>https://homebrewery.naturalcrit.com/download/{id}</c>
/// and nothing else. The upstream is a <see cref="FakeHttpHandler"/>: these tests never use the network.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class UpstreamImportTests(UpstreamImportTests.ImportHost host) : IClassFixture<UpstreamImportTests.ImportHost>
{
    private const string ShareId = "aBc_123-xyZ9";
    private const string BrewText = "```metadata\ntitle: Dragons – Ünicode\n```\n\n# Dragons\n\nThey are big.\n";

    private FakeHttpHandler Upstream => host.Upstream;

    [Fact]
    public async Task A_public_brew_comes_back_as_text_plain()
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(FakeHttpHandler.Text(BrewText));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal(BrewText, await response.Content.ReadAsStringAsync(ct));
        var request = Assert.Single(Upstream.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal(new Uri($"https://homebrewery.naturalcrit.com/download/{ShareId}"), request.Uri);
    }

    [Fact]
    public async Task Anonymous_callers_get_401_and_nothing_is_fetched()
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(FakeHttpHandler.Text(BrewText));
        using var anonymous = host.Factory.CreateClient();

        using var response = await anonymous.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Empty(Upstream.Requests);
    }

    [Theory]
    [InlineData("short")]                               // under 10 characters
    [InlineData("abcdefghijklmno")]                     // over 14
    [InlineData("abc.defghij")]
    [InlineData("abc%2Fdefghij")]                       // an encoded slash stays in the route value
    [InlineData("..%2F..%2Fadmin")]
    [InlineData("..%5C..%5Cadmin1")]
    [InlineData("%2F%2Fevil.example%2Fx")]
    [InlineData("evil.example%3A443")]
    [InlineData("abcdefghij%3Fx%3D1")]                  // ?x=1
    [InlineData("abcdefghij%23frag")]
    [InlineData("abcdefghij%40evil")]                   // @evil
    [InlineData("%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9%C3%A9")]  // éééééééééé: \w is ASCII only
    [InlineData("abcdefghij%20")]
    public async Task Ids_that_are_not_share_ids_are_400_and_nothing_is_fetched(string encodedId)
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(FakeHttpHandler.Text(BrewText));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync(new Uri($"http://localhost/api/import/homebrewery/{encodedId}"), ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("shareId", out _));
        Assert.Empty(Upstream.Requests);
    }

    [Theory]
    [InlineData("../abcdefghij")]
    [InlineData("abcdefghij/../../x")]
    [InlineData("//evil.example/abc")]
    public async Task Paths_that_climb_out_never_reach_the_proxy_with_another_target(string path)
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(FakeHttpHandler.Text(BrewText));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{path}", ct);

        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(Upstream.Requests);
    }

    [Theory]
    [InlineData("abcdefghij")]
    [InlineData("abcdefghij1234")]
    [InlineData("A_B-c_d-E_f")]
    public void Download_uris_are_always_on_the_fixed_host(string shareId)
    {
        var uri = UpstreamImportClient.DownloadUri(shareId);

        Assert.Equal($"https://homebrewery.naturalcrit.com/download/{shareId}", uri.AbsoluteUri);
    }

    [Theory]
    [InlineData("../abcdefgh")]
    [InlineData("abcdefghij?x=1")]
    [InlineData("//evil.example")]
    [InlineData("https://evil.example/abcdef")]
    [InlineData("")]
    public void Crafted_ids_cannot_build_a_download_uri(string shareId)
    {
        Assert.False(UpstreamImportClient.IsValidShareId(shareId));
        Assert.Throws<ArgumentException>(() => UpstreamImportClient.DownloadUri(shareId));
    }

    [Fact]
    public async Task The_host_stays_fixed_even_if_the_client_base_address_is_changed()
    {
        var ct = TestContext.Current.CancellationToken;
        var upstream = new FakeHttpHandler { Respond = FakeHttpHandler.Text(BrewText) };
        await using var tampered = host.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s
            .AddHttpClient<UpstreamImportClient>(c => c.BaseAddress = new Uri("https://evil.example/"))
            .ConfigurePrimaryHttpMessageHandler(() => upstream)));
        using var user = await tampered.CreateUserAsync(ct: ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("homebrewery.naturalcrit.com", Assert.Single(upstream.Requests).Uri.Host);
    }

    [Fact]
    public void The_real_handler_follows_no_redirects_and_decompresses()
    {
        // The shared host is not faked: this is the handler production uses.
        var handler = host.Plain.Services.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(nameof(UpstreamImportClient));
        while (handler is DelegatingHandler delegating) handler = delegating.InnerHandler!;

        var sockets = Assert.IsType<SocketsHttpHandler>(handler);
        Assert.False(sockets.AllowAutoRedirect);
        Assert.Equal(DecompressionMethods.All, sockets.AutomaticDecompression);
        Assert.False(sockets.UseCookies);
    }

    [Fact]
    public async Task Upstream_404_is_404()
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(FakeHttpHandler.Text("<html>Brew not found</html>", "text/html", HttpStatusCode.NotFound));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        await AssertProblemAsync(response, HttpStatusCode.NotFound, ct);
    }

    public static TheoryData<string> UpstreamFailures => ["500", "302", "html", "network", "dropped", "timeout"];

    [Theory]
    [MemberData(nameof(UpstreamFailures))]
    public async Task Upstream_failures_are_502(string failure)
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(failure switch
        {
            "500" => FakeHttpHandler.Text("oops", status: HttpStatusCode.InternalServerError),
            "302" => (_, _) =>
            {
                var redirect = new HttpResponseMessage(HttpStatusCode.Found);
                redirect.Headers.Location = new Uri("http://169.254.169.254/latest/meta-data/");
                return Task.FromResult(redirect);
            },
            "html" => FakeHttpHandler.Text("<html>error page</html>", "text/html"),
            "network" => (_, _) => throw new HttpRequestException("connection refused"),
            "dropped" => (_, _) =>
            {
                var content = new StreamContent(new FailingStream());
                content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
            },
            _ => async (_, token) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(30), token);
                return new HttpResponseMessage(HttpStatusCode.OK);
            },
        });
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        var problem = await AssertProblemAsync(response, HttpStatusCode.BadGateway, ct);
        Assert.Single(Upstream.Requests);                                        // no redirect was followed
        var expectedStatus = failure switch { "500" => 500, "302" => 302, _ => (int?)null };
        Assert.Equal(expectedStatus, problem.TryGetProperty("upstreamStatus", out var status) ? status.GetInt32() : null);
        Assert.DoesNotContain("connection refused", problem.ToString(), StringComparison.Ordinal);   // no internals
    }

    [Fact]
    public async Task A_locked_upstream_brew_reports_its_lock_code()
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset(FakeHttpHandler.Text("<html>locked</html>", "text/html", (HttpStatusCode)455));
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        var problem = await AssertProblemAsync(response, HttpStatusCode.BadGateway, ct);
        Assert.Equal(455, problem.GetProperty("upstreamStatus").GetInt32());
    }

    [Fact]
    public async Task A_declared_length_over_2_MB_is_413_without_reading_the_body()
    {
        var ct = TestContext.Current.CancellationToken;
        var body = new CountingStream(UpstreamImportClient.MaxBytes + 1L);
        Upstream.Reset((_, _) =>
        {
            var content = new StreamContent(body);
            content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
            content.Headers.ContentLength = UpstreamImportClient.MaxBytes + 1L;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        });
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        await AssertProblemAsync(response, HttpStatusCode.RequestEntityTooLarge, ct);
        Assert.Equal(0, body.BytesRead);
    }

    [Fact]
    public async Task An_endless_body_is_abandoned_just_past_2_MB()
    {
        var ct = TestContext.Current.CancellationToken;
        var body = new CountingStream(length: null);                             // never ends, no Content-Length
        Upstream.Reset((_, _) =>
        {
            var content = new StreamContent(body);
            content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        });
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        await AssertProblemAsync(response, HttpStatusCode.RequestEntityTooLarge, ct);
        Assert.InRange(body.BytesRead, UpstreamImportClient.MaxBytes, UpstreamImportClient.MaxBytes + 256 * 1024);
    }

    [Fact]
    public async Task Exactly_2_MB_is_accepted()
    {
        var ct = TestContext.Current.CancellationToken;
        var text = new string('a', UpstreamImportClient.MaxBytes);
        Upstream.Reset((_, _) =>
        {
            var content = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(text)));   // chunked: no length
            content.Headers.ContentType = new MediaTypeHeaderValue("text/plain") { CharSet = "utf-8" };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        });
        var user = await host.UserAsync(ct);

        using var response = await user.Client.GetAsync($"/api/import/homebrewery/{ShareId}", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(text.Length, (await response.Content.ReadAsStringAsync(ct)).Length);
    }

    [Fact]
    public async Task A_byte_order_mark_is_dropped_and_the_charset_is_honoured()
    {
        var ct = TestContext.Current.CancellationToken;
        Upstream.Reset((_, _) =>
        {
            var bytes = Encoding.Latin1.GetBytes("Grüße");
            var content = new ByteArrayContent(bytes);
            content.Headers.ContentType = new MediaTypeHeaderValue("text/plain") { CharSet = "iso-8859-1" };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        });
        var user = await host.UserAsync(ct);

        var latin1 = await user.Client.GetStringAsync($"/api/import/homebrewery/{ShareId}", ct);
        Upstream.Reset(FakeHttpHandler.Text("﻿# Title"));
        var bom = await user.Client.GetStringAsync($"/api/import/homebrewery/{ShareId}", ct);

        Assert.Equal("Grüße", latin1);
        Assert.Equal("# Title", bom);
    }

    private static async Task<JsonElement> AssertProblemAsync(HttpResponseMessage response, HttpStatusCode expected, CancellationToken ct)
    {
        Assert.Equal(expected, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal((int)expected, problem.GetProperty("status").GetInt32());
        return problem;
    }

    /// <summary>
    /// One host for the class whose upstream is <see cref="Upstream"/> (with a 1 s timeout), plus
    /// <see cref="Plain"/>, the shared host with the real handler.
    /// </summary>
    public sealed class ImportHost : IAsyncDisposable
    {
        private readonly ApiFixture _api;
        private TestUser? _user;

        public ImportHost(ApiFixture api)
        {
            _api = api;
            Factory = api.Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s
                .AddHttpClient<UpstreamImportClient>(c => c.Timeout = TimeSpan.FromSeconds(1))
                .ConfigurePrimaryHttpMessageHandler(() => Upstream)));
        }

        public FakeHttpHandler Upstream { get; } = new();

        /// <summary>The host whose upstream is <see cref="Upstream"/>.</summary>
        public WebApplicationFactory<Program> Factory { get; }

        /// <summary>The shared host, with the real upstream handler.</summary>
        public WebApplicationFactory<Program> Plain => _api.Factory;

        public async Task<TestUser> UserAsync(CancellationToken ct) => _user ??= await Factory.CreateUserAsync(ct: ct);

        public async ValueTask DisposeAsync()
        {
            _user?.Dispose();
            await Factory.DisposeAsync();
            Upstream.Dispose();
        }
    }

    /// <summary>A body whose connection drops after a few bytes.</summary>
    private sealed class FailingStream : Stream
    {
        private bool _sent;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_sent) throw new IOException("The response ended prematurely.");
            _sent = true;
            buffer[offset] = (byte)'#';
            return 1;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>A read-only stream of 'a's of the given length (null: endless) that counts what was read.</summary>
    private sealed class CountingStream(long? length) : Stream
    {
        public long BytesRead { get; private set; }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => BytesRead; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = length is { } total ? (int)Math.Min(count, total - BytesRead) : count;
            Array.Fill(buffer, (byte)'a', offset, n);
            BytesRead += n;
            return n;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
