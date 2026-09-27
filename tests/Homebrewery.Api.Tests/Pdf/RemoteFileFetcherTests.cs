using System.Net;
using System.Net.Sockets;
using Homebrewery.Api.Pdf;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Api.Tests.Pdf;

/// <summary>
/// <see cref="RemoteFileFetcher"/>: the guarded client never connects to the server's own network, and the per-file
/// limits hold. Tests that need an answer use a <see cref="FakeHttpHandler"/>; none uses the network.
/// </summary>
public sealed class RemoteFileFetcherTests
{
    [Theory]
    [InlineData("https://127.0.0.1:{0}/image.png")]
    [InlineData("https://localhost:{0}/image.png")]
    [InlineData("https://[::1]:{0}/image.png")]
    [InlineData("https://[::ffff:127.0.0.1]:{0}/image.png")]
    public async Task The_real_client_never_connects_to_a_local_address(string template)
    {
        var ct = TestContext.Current.CancellationToken;
        using var listener = new TcpListener(IPAddress.IPv6Any, 0) { Server = { DualMode = true } };
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        await using var services = Services();

        var file = await services.GetRequiredService<IRemoteFileFetcher>()
            .FetchAsync(new Uri(string.Format(System.Globalization.CultureInfo.InvariantCulture, template, port)), null, Budget(), ct);

        Assert.Null(file);
        Assert.False(listener.Pending());
    }

    [Fact]
    public async Task A_file_comes_back_with_its_content_type_and_the_browsers_user_agent_is_sent()
    {
        var ct = TestContext.Current.CancellationToken;
        var fake = new FakeHttpHandler
        {
            Respond = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent([1, 2, 3]) { Headers = { ContentType = new("image/png") } },
            }),
        };
        await using var services = Services(fake);

        var file = await services.GetRequiredService<IRemoteFileFetcher>()
            .FetchAsync(new Uri("https://images.example/a.png"), "HeadlessChrome/153", Budget(), ct);

        Assert.NotNull(file);
        Assert.Equal([1, 2, 3], file.Body);
        Assert.Equal("image/png", file.ContentType);
        var request = Assert.Single(fake.Requests);
        Assert.Contains("HeadlessChrome/153", request.Headers, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://images.example/a.png")]
    [InlineData("ftp://images.example/a.png")]
    [InlineData("file:///etc/passwd")]
    public async Task Only_https_is_fetched(string url)
    {
        var ct = TestContext.Current.CancellationToken;
        var fake = new FakeHttpHandler { Respond = FakeHttpHandler.Text("x") };
        await using var services = Services(fake);

        Assert.Null(await services.GetRequiredService<IRemoteFileFetcher>().FetchAsync(new Uri(url), null, Budget(), ct));
        Assert.Empty(fake.Requests);
    }

    [Fact]
    public async Task Errors_and_files_over_the_size_cap_are_left_out()
    {
        var ct = TestContext.Current.CancellationToken;
        var fake = new FakeHttpHandler
        {
            Respond = (request, _) => Task.FromResult(request.RequestUri!.AbsolutePath switch
            {
                "/declared.png" => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[11]) },
                // No Content-Length: the cap applies while reading.
                "/streamed.png" => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new UnknownLengthStream(11)) },
                "/fits.png" => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new UnknownLengthStream(10)) },
                _ => new HttpResponseMessage(HttpStatusCode.NotFound),
            }),
        };
        await using var services = Services(fake, maxFileBytes: 10);
        var fetcher = services.GetRequiredService<IRemoteFileFetcher>();

        Assert.Null(await fetcher.FetchAsync(new Uri("https://images.example/declared.png"), null, Budget(), ct));
        Assert.Null(await fetcher.FetchAsync(new Uri("https://images.example/streamed.png"), null, Budget(), ct));
        Assert.Null(await fetcher.FetchAsync(new Uri("https://images.example/missing.png"), null, Budget(), ct));
        Assert.Equal(10, (await fetcher.FetchAsync(new Uri("https://images.example/fits.png"), null, Budget(), ct))?.Body.Length);
    }

    [Fact]
    public async Task Bytes_are_taken_from_the_renders_budget_as_they_arrive()
    {
        // a.png has arrived but its response is still open; b.png, fetched meanwhile, no longer fits.
        var ct = TestContext.Current.CancellationToken;
        var held = new HeldOpenStream(8);
        var fake = new FakeHttpHandler
        {
            Respond = (request, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(request.RequestUri!.AbsolutePath == "/a.png" ? held : new UnknownLengthStream(8)),
            }),
        };
        await using var services = Services(fake);
        var fetcher = services.GetRequiredService<IRemoteFileFetcher>();
        var budget = Budget(12);

        var a = fetcher.FetchAsync(new Uri("https://images.example/a.png"), null, budget, ct);
        await held.Sent.WaitAsync(TimeSpan.FromSeconds(5), ct);
        var b = await fetcher.FetchAsync(new Uri("https://images.example/b.png"), null, budget, ct);
        held.Release();

        Assert.Null(b);
        Assert.Equal(8, (await a)?.Body.Length);
        Assert.Equal(4, budget.Left);
    }

    [Fact]
    public async Task A_file_over_the_budget_is_left_out_and_gives_its_bytes_back()
    {
        var ct = TestContext.Current.CancellationToken;
        var fake = new FakeHttpHandler
        {
            Respond = (request, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = request.RequestUri!.AbsolutePath == "/declared.png"
                    ? new ByteArrayContent(new byte[5])
                    : new StreamContent(new UnknownLengthStream(5, chunk: 3)),
            }),
        };
        await using var services = Services(fake);
        var fetcher = services.GetRequiredService<IRemoteFileFetcher>();
        var budget = Budget(4);

        Assert.Null(await fetcher.FetchAsync(new Uri("https://images.example/declared.png"), null, budget, ct));  // 5 declared
        Assert.Null(await fetcher.FetchAsync(new Uri("https://images.example/streamed.png"), null, budget, ct));  // 3 fit, then 2 more do not
        Assert.Equal(4, budget.Left);
    }

    [Fact]
    public async Task A_slow_file_is_left_out_after_the_timeout()
    {
        var ct = TestContext.Current.CancellationToken;
        var fake = new FakeHttpHandler
        {
            Respond = async (_, token) =>
            {
                await Task.Delay(Timeout.Infinite, token);
                return new HttpResponseMessage(HttpStatusCode.OK);
            },
        };
        await using var services = Services(fake, timeout: TimeSpan.FromMilliseconds(200));

        Assert.Null(await services.GetRequiredService<IRemoteFileFetcher>().FetchAsync(new Uri("https://slow.example/a.png"), null, Budget(), ct));
    }

    private static ServiceProvider Services(FakeHttpHandler? handler = null, long? maxFileBytes = null, TimeSpan? timeout = null)
    {
        var settings = new Dictionary<string, string?>();
        if (maxFileBytes is { } max) settings["Pdf:MaxRemoteFileBytes"] = max.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (timeout is { } t) settings["Pdf:RemoteFileTimeout"] = t.ToString();
        var services = new ServiceCollection()
            .AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(settings).Build())
            .AddLogging()
            .AddPdfExport();
        if (handler is not null) services.AddHttpClient(RemoteFileFetcher.ClientName).ConfigurePrimaryHttpMessageHandler(() => handler);
        return services.BuildServiceProvider();
    }

    private static RemoteByteBudget Budget(long bytes = 1024) => new(bytes);

    /// <summary>A body of <c>length</c> zero bytes, then an end that waits for <see cref="Release"/>.</summary>
    private sealed class HeldOpenStream(int length) : Stream
    {
        private readonly TaskCompletionSource _sent = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private bool _started;

        /// <summary>Completes when the body has been read and the reader waits for the end.</summary>
        public Task Sent => _sent.Task;

        public void Release() => _release.TrySetResult();

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_started)
            {
                _sent.TrySetResult();
                await _release.Task.WaitAsync(cancellationToken);
                return 0;
            }
            _started = true;
            buffer.Span[..length].Clear();
            return length;
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>A body of <c>length</c> zero bytes whose length is not known up front, at most <c>chunk</c> per read.</summary>
    private sealed class UnknownLengthStream(int length, int chunk = int.MaxValue) : Stream
    {
        private int _left = length;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => 0; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var n = Math.Min(Math.Min(count, chunk), _left);
            Array.Clear(buffer, offset, n);
            _left -= n;
            return n;
        }

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
