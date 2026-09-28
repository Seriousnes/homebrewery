using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using Homebrewery.Api.Pdf;
using Homebrewery.Api.Tests.Documents;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace Homebrewery.Api.Tests.Pdf;

/// <summary>
/// <see cref="PdfRenderer"/> with real headless Chromium: the Chromium build of the Microsoft.Playwright package must be
/// installed (<c>npm --prefix web exec playwright install chromium</c> installs the same build).
/// Other sites' files come from <see cref="FakeFetcher"/>, so these tests never use the network.
/// </summary>
public sealed class PdfRendererTests(PdfRendererTests.RendererFixture fixture) : IClassFixture<PdfRendererTests.RendererFixture>
{
    // A 2×2 red PNG.
    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=");

    // flow-root: a heading's top margin must not collapse through the page box and push it onto a second sheet.
    private const string PageCss = "@page { size: 5in 7in; margin: 0 } body { margin: 0 } " +
        ".page { display: flow-root; width: 5in; height: 7in; overflow: hidden; break-after: page }";

    private static string Html(string body, string css = "") =>
        $"<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Test brew</title>" +
        $"<style>{PageCss}{css}</style></head><body>{body}</body></html>";

    [Fact]
    public async Task Renders_one_sheet_per_brew_page_at_the_css_page_size_with_an_outline()
    {
        var ct = TestContext.Current.CancellationToken;
        fixture.Fetcher.Reset();

        var result = await fixture.Renderer.RenderAsync(
            Html("<div class=\"page\"><h1>One</h1></div><div class=\"page\"><h2>Two</h2></div><div class=\"page\"><p>Three</p></div>"), ct);

        var pdf = new PdfFile(result.Pdf);
        Assert.True(pdf.IsPdf);
        Assert.Equal(3, pdf.PageCount);
        Assert.All(pdf.MediaBoxes, box =>
        {
            Assert.Equal(360, box.Width, 0.5);                     // 5in
            Assert.Equal(504, box.Height, 0.5);                    // 7in
        });
        Assert.True(pdf.HasOutline);
        Assert.Equal(0, result.MissingFiles);
    }

    [Fact]
    public async Task JavaScript_does_not_run()
    {
        var ct = TestContext.Current.CancellationToken;
        fixture.Fetcher.Reset();

        // With JavaScript the script would add a second page.
        var result = await fixture.Renderer.RenderAsync(Html(
            "<div class=\"page\">One" +
            "<img src=\"data:image/png;base64,AAAA\" onerror=\"document.body.insertAdjacentHTML('beforeend', '<div class=page>x</div>')\"></div>" +
            "<script>document.body.insertAdjacentHTML('beforeend', '<div class=\"page\">Two</div>')</script>"), ct);

        Assert.Equal(1, new PdfFile(result.Pdf).PageCount);
    }

    [Fact]
    public async Task Other_sites_images_and_fonts_come_from_the_fetcher()
    {
        var ct = TestContext.Current.CancellationToken;
        var font = await File.ReadAllBytesAsync(Path.Combine(SchemaManifestTests.RepositoryRoot(),
            "web", "src", "fonts", "open-sans-latin-400-normal.woff2"), ct);
        fixture.Fetcher.Reset(uri => uri.AbsolutePath switch
        {
            "/red.png" => new RemoteFile(Png, "image/png"),
            "/open-sans.woff2" => new RemoteFile(font, "font/woff2"),
            _ => null,
        });

        var result = await fixture.Renderer.RenderAsync(Html(
            "<div class=\"page\"><p style=\"font-family: 'Remote Sans'\">Hello from another site</p>" +
            "<img src=\"https://images.example/red.png\" width=\"40\" height=\"40\">" +
            "<div style=\"width: 40px; height: 40px; background: url(https://images.example/missing.png)\"></div></div>",
            "@font-face { font-family: 'Remote Sans'; src: url(https://fonts.example/open-sans.woff2) format('woff2') }"), ct);

        var pdf = new PdfFile(result.Pdf);
        Assert.Equal(1, pdf.ImageCount);
        Assert.Contains(pdf.FontNames, name => name.Contains("OpenSans", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(2, result.RemoteFiles);
        Assert.Equal(1, result.MissingFiles);
        Assert.Equal(
            ["https://fonts.example/open-sans.woff2", "https://images.example/missing.png", "https://images.example/red.png"],
            fixture.Fetcher.Requested.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Each_render_has_its_own_budget_for_other_sites_bytes()
    {
        var ct = TestContext.Current.CancellationToken;
        var fetcher = new FakeFetcher();
        fetcher.Reset(_ => new RemoteFile(Png, "image/png"));
        await using var renderer = fixture.Create(fetcher, new PdfOptions { MaxRemoteBytes = Png.Length });

        var two = await renderer.RenderAsync(Html(
            "<div class=\"page\"><img src=\"https://images.example/a.png\"><img src=\"https://images.example/b.png\"></div>"), ct);
        var one = await renderer.RenderAsync(Html("<div class=\"page\"><img src=\"https://images.example/c.png\"></div>"), ct);

        Assert.Equal((1, 1), (two.RemoteFiles, two.MissingFiles));   // the budget holds one of the two
        Assert.Equal((1, 0), (one.RemoteFiles, one.MissingFiles));   // and the next render starts with a full one
    }

    [Fact]
    public async Task No_request_reaches_the_network_on_its_own()
    {
        var ct = TestContext.Current.CancellationToken;
        fixture.Fetcher.Reset();
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var local = $"http://127.0.0.1:{port}";

        var result = await fixture.Renderer.RenderAsync(Html(
            $"<link rel=\"preconnect\" href=\"{local}\"><link rel=\"dns-prefetch\" href=\"//internal.example\">" +
            $"<link rel=\"stylesheet\" href=\"{local}/style.css\">" +
            $"<div class=\"page\"><img src=\"{local}/image.png\"><iframe src=\"{local}/frame\"></iframe>" +
            $"<video src=\"{local}/video.mp4\" poster=\"{local}/poster.png\"></video>" +
            $"<img src=\"{PdfRenderer.DocumentUrl}relative.png\"><img src=\"relative.png\"></div>",
            $"@import url({local}/import.css); .page {{ background: url({local}/background.png) }}"), ct);

        Assert.True(new PdfFile(result.Pdf).IsPdf);
        Assert.False(listener.Pending(), "Chromium connected to the local listener.");
        Assert.Empty(fixture.Fetcher.Requested);                   // http and the document's own host are never fetched
        Assert.True(result.MissingFiles >= 6, $"{result.MissingFiles} requests were blocked.");
    }

    [Fact]
    public async Task A_full_renderer_answers_busy_and_a_slow_render_times_out()
    {
        var ct = TestContext.Current.CancellationToken;
        var fetcher = new FakeFetcher();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fetcher.Reset(async (_, token) =>
        {
            entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, token);             // never answers: only the timeout ends the render
            return null;
        });
        // The render timeout runs on a fake clock: it passes when the test advances the clock, never on its own. Real
        // time (Playwright's own timeouts, also RenderTimeout) is far longer than any test run.
        var clock = new FakeTimeProvider();
        var renderTimeout = TimeSpan.FromMinutes(10);
        await using var renderer = fixture.Create(fetcher, new PdfOptions
        {
            MaxConcurrentRenders = 1,
            QueueTimeout = TimeSpan.Zero,                          // a full renderer answers busy at once
            RenderTimeout = renderTimeout,
        }, clock);

        var slow = renderer.RenderAsync(Html("<div class=\"page\"><img src=\"https://images.example/slow.png\"></div>"), ct);
        await Task.WhenAny(entered.Task, slow).WaitAsync(ct);      // the render holds its slot, waiting for the image
        Assert.False(slow.IsCompleted, $"The render ended before it fetched the image: {slow.Exception}");

        await Assert.ThrowsAsync<PdfRendererBusyException>(() => renderer.RenderAsync(Html("<div class=\"page\">x</div>"), ct));
        clock.Advance(renderTimeout);
        var failure = await Assert.ThrowsAsync<PdfRenderFailedException>(() => slow);
        Assert.Equal("The PDF took longer than 600 seconds to make.", failure.Message);

        // The slot is free again, and the browser still works (the clock stands still: this render can't time out).
        fetcher.Reset();
        var result = await renderer.RenderAsync(Html("<div class=\"page\">x</div>"), ct);
        Assert.Equal(1, new PdfFile(result.Pdf).PageCount);
    }

    /// <summary>One renderer (one Chromium) for the class.</summary>
    public sealed class RendererFixture : IAsyncDisposable
    {
        public RendererFixture() => Renderer = Create(Fetcher, new PdfOptions());

        public FakeFetcher Fetcher { get; } = new();

        public PdfRenderer Renderer { get; }

        public PdfRenderer Create(IRemoteFileFetcher fetcher, PdfOptions options, TimeProvider? clock = null) =>
            new(fetcher, Options.Create(options), clock ?? TimeProvider.System, NullLogger<PdfRenderer>.Instance);

        public ValueTask DisposeAsync() => Renderer.DisposeAsync();
    }

    /// <summary>Answers from a function and records what was asked.</summary>
    public sealed class FakeFetcher : IRemoteFileFetcher
    {
        private Func<Uri, CancellationToken, Task<RemoteFile?>> _respond = (_, _) => Task.FromResult<RemoteFile?>(null);

        public ConcurrentQueue<string> Requested { get; private set; } = new();

        public void Reset(Func<Uri, RemoteFile?>? respond = null) =>
            Reset((uri, _) => Task.FromResult(respond?.Invoke(uri)));

        public void Reset(Func<Uri, CancellationToken, Task<RemoteFile?>> respond)
        {
            Requested = new ConcurrentQueue<string>();
            _respond = respond;
        }

        /// <summary>Takes a file's bytes from the budget like <see cref="RemoteFileFetcher"/>; null when it does not fit.</summary>
        public async Task<RemoteFile?> FetchAsync(Uri uri, string? userAgent, RemoteByteBudget budget, CancellationToken ct)
        {
            Requested.Enqueue(uri.AbsoluteUri);
            var file = await _respond(uri, ct);
            return file is not null && budget.TryTake(file.Body.Length) ? file : null;
        }
    }
}
