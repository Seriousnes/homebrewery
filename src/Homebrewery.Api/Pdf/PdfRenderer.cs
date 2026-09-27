using System.Diagnostics;
using Microsoft.Extensions.Options;
using Microsoft.Playwright;

namespace Homebrewery.Api.Pdf;

/// <summary>Turns an exported brew (the web client's self-contained HTML) into a PDF.</summary>
public interface IPdfRenderer
{
    /// <exception cref="PdfRendererBusyException">Every render slot stayed busy for <see cref="PdfOptions.QueueTimeout"/>.</exception>
    /// <exception cref="PdfRendererUnavailableException">Chromium could not be started (e.g. it is not installed).</exception>
    /// <exception cref="PdfRenderFailedException">The render failed or took longer than <see cref="PdfOptions.RenderTimeout"/>.</exception>
    Task<PdfRenderResult> RenderAsync(string html, CancellationToken ct);
}

/// <param name="Pdf">The PDF file.</param>
/// <param name="RemoteFiles">Other sites' files that were fetched and are in the PDF.</param>
/// <param name="MissingFiles">Files the page asked for that are not in it (blocked, failed, or over a limit).</param>
public sealed record PdfRenderResult(byte[] Pdf, int RemoteFiles, int MissingFiles);

public sealed class PdfRendererBusyException() : Exception("Every PDF render slot is busy.");

public sealed class PdfRendererUnavailableException(string message, Exception inner) : Exception(message, inner);

public sealed class PdfRenderFailedException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// <see cref="IPdfRenderer"/> with headless Chromium (Microsoft.Playwright). One browser, started on the first render
/// and again after a crash; each render gets a fresh browser context:
/// <list type="bullet">
/// <item>JavaScript is off. The exported HTML has no scripts and a CSP that forbids them.</item>
/// <item>Every request goes through <see cref="HandleRouteAsync"/>. The HTML is served as <see cref="DocumentUrl"/>.
/// GET requests for https images, fonts and stylesheets of other sites go to <see cref="IRemoteFileFetcher"/>, within
/// the per-render limits. Everything else is aborted.</item>
/// <item>Chromium's own network is dead as well: a discard proxy for every host, loopback included, and no DNS.
/// Requests that bypass the route handler (preconnect, DNS prefetch) therefore go nowhere.</item>
/// </list>
/// The PDF uses the page size that the HTML's <c>@page</c> rule sets (the exporter writes the measured brew page size),
/// prints backgrounds, and is tagged with an outline from the headings.
/// </summary>
public sealed partial class PdfRenderer(IRemoteFileFetcher fetcher, IOptions<PdfOptions> options, ILogger<PdfRenderer> logger)
    : IPdfRenderer, IAsyncDisposable
{
    /// <summary>The address the HTML is served at. <c>.invalid</c> never resolves, so nothing else can answer for it.</summary>
    public const string DocumentUrl = "https://export.homebrewery.invalid/";

    private static readonly string DocumentHost = new Uri(DocumentUrl).Host;

    /// <summary>Resource types fetched from other sites. Media, scripts, frames, fetches and the rest are aborted.</summary>
    private static readonly HashSet<string> RemoteResourceTypes = new(StringComparer.Ordinal) { "image", "font", "stylesheet" };

    private static readonly string[] BrowserArgs =
    [
        "--proxy-server=http://127.0.0.1:9",        // the discard port: direct connections fail...
        "--proxy-bypass-list=<-loopback>",          // ...loopback included
        "--host-resolver-rules=MAP * ~NOTFOUND",    // and no host name resolves
        "--disable-dev-shm-usage",                  // containers have a small /dev/shm (64 MB in Docker)
    ];

    private readonly SemaphoreSlim _slots = new(options.Value.MaxConcurrentRenders, options.Value.MaxConcurrentRenders);
    private readonly SemaphoreSlim _launch = new(1, 1);
    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task<PdfRenderResult> RenderAsync(string html, CancellationToken ct)
    {
        var settings = options.Value;
        if (!await _slots.WaitAsync(settings.QueueTimeout, ct)) throw new PdfRendererBusyException();
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(settings.RenderTimeout);
            var started = Stopwatch.GetTimestamp();
            var browser = await BrowserAsync(timeout.Token);
            try
            {
                var result = await RenderPageAsync(browser, html, settings, timeout.Token);
                LogRendered(logger, result.Pdf.Length, result.RemoteFiles, result.MissingFiles,
                    (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                return result;
            }
            catch (Exception ex) when (ex is PlaywrightException or TimeoutException or OperationCanceledException)
            {
                ct.ThrowIfCancellationRequested();                   // the client went away
                if (timeout.IsCancellationRequested)
                {
                    throw new PdfRenderFailedException(
                        $"The PDF took longer than {settings.RenderTimeout.TotalSeconds:0} seconds to make.", ex);
                }
                LogRenderFailed(logger, ex);
                throw new PdfRenderFailedException("The PDF could not be made.", ex);
            }
        }
        finally
        {
            _slots.Release();
        }
    }

    private async Task<PdfRenderResult> RenderPageAsync(IBrowser browser, string html, PdfOptions settings, CancellationToken ct)
    {
        await using var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            JavaScriptEnabled = false,
            AcceptDownloads = false,
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
        // A timeout or an aborted request closes the context, which ends whatever it is waiting for.
        await using var closeOnCancel = ct.Register(() => _ = CloseQuietlyAsync(context));
        context.SetDefaultTimeout((float)settings.RenderTimeout.TotalMilliseconds);
        context.SetDefaultNavigationTimeout((float)settings.RenderTimeout.TotalMilliseconds);

        var render = new RenderState(html, settings);
        await context.RouteAsync("**/*", route => HandleRouteAsync(route, render, ct));
        var page = await context.NewPageAsync();
        await page.GotoAsync(DocumentUrl, new PageGotoOptions { WaitUntil = WaitUntilState.Load });
        // Web fonts that load late (after the load event) would print as fallback fonts.
        await page.EvaluateAsync("() => document.fonts.ready.then(() => true)");
        var pdf = await page.PdfAsync(new PagePdfOptions
        {
            PreferCSSPageSize = true,
            PrintBackground = true,
            Tagged = true,
            Outline = true,
        });
        ct.ThrowIfCancellationRequested();
        return new PdfRenderResult(pdf, render.Fetched, render.Missing);
    }

    private async Task HandleRouteAsync(IRoute route, RenderState render, CancellationToken ct)
    {
        try
        {
            var request = route.Request;
            if (request.IsNavigationRequest && request.Url == DocumentUrl && render.TakeDocument())
            {
                await route.FulfillAsync(new RouteFulfillOptions
                {
                    Status = 200,
                    ContentType = "text/html; charset=utf-8",
                    Body = render.Html,
                });
                return;
            }

            if (request.Method != "GET"
                || !RemoteResourceTypes.Contains(request.ResourceType)
                || !Uri.TryCreate(request.Url, UriKind.Absolute, out var uri)
                || uri.Scheme != Uri.UriSchemeHttps
                || string.Equals(uri.Host, DocumentHost, StringComparison.OrdinalIgnoreCase)
                || !render.TakeFileSlot())
            {
                render.CountMissing();
                await route.AbortAsync("blockedbyclient");
                return;
            }

            request.Headers.TryGetValue("user-agent", out var userAgent);
            var file = await fetcher.FetchAsync(uri, userAgent, render.Bytes, ct);
            if (file is null)
            {
                render.CountMissing();
                await route.AbortAsync("failed");
                return;
            }

            render.CountFetched();
            var headers = new Dictionary<string, string>
            {
                // The document's origin is not the file's: fonts need CORS.
                ["access-control-allow-origin"] = "*",
            };
            if (file.ContentType is { } type) headers["content-type"] = type;
            await route.FulfillAsync(new RouteFulfillOptions { Status = 200, Headers = headers, BodyBytes = file.Body });
        }
        catch (Exception ex) when (ex is PlaywrightException or OperationCanceledException)
        {
            // The context closed while this request waited (timeout, aborted request): nothing left to answer.
        }
    }

    private async Task<IBrowser> BrowserAsync(CancellationToken ct)
    {
        if (_browser is { IsConnected: true } ready) return ready;
        await _launch.WaitAsync(ct);
        try
        {
            if (_browser is { IsConnected: true } launched) return launched;
            if (_browser is not null)
            {
                await CloseQuietlyAsync(_browser);
                _browser = null;
            }

            try
            {
                _playwright ??= await Playwright.CreateAsync();
                _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions { Headless = true, Args = BrowserArgs });
                LogLaunched(logger, _browser.Version);
                return _browser;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogLaunchFailed(logger, ex);
                throw new PdfRendererUnavailableException("Chromium could not be started.", ex);
            }
        }
        finally
        {
            _launch.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_browser is not null) await CloseQuietlyAsync(_browser);
        _playwright?.Dispose();
        _slots.Dispose();
        _launch.Dispose();
    }

    private static async Task CloseQuietlyAsync(IBrowserContext context)
    {
        try
        {
            await context.CloseAsync();
        }
        catch (PlaywrightException)
        {
            // Already closed.
        }
    }

    private static async Task CloseQuietlyAsync(IBrowser browser)
    {
        try
        {
            await browser.CloseAsync();
        }
        catch (PlaywrightException)
        {
            // Already gone (crashed or disconnected).
        }
    }

    /// <summary>One render's counters and limits. Route handlers run concurrently.</summary>
    private sealed class RenderState(string html, PdfOptions settings)
    {
        private int _documentTaken;
        private int _slots;
        private int _fetched;
        private int _missing;

        public string Html { get; } = html;
        public RemoteByteBudget Bytes { get; } = new(settings.MaxRemoteBytes);
        public int Fetched => Volatile.Read(ref _fetched);
        public int Missing => Volatile.Read(ref _missing);

        /// <summary>True once: the main frame's navigation. A frame that asks for the document again gets nothing.</summary>
        public bool TakeDocument() => Interlocked.Exchange(ref _documentTaken, 1) == 0;

        public bool TakeFileSlot() => Interlocked.Increment(ref _slots) <= settings.MaxRemoteFiles;

        public void CountFetched() => Interlocked.Increment(ref _fetched);

        public void CountMissing() => Interlocked.Increment(ref _missing);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "PDF export: Chromium {Version} started.")]
    private static partial void LogLaunched(ILogger logger, string version);

    [LoggerMessage(Level = LogLevel.Error, Message =
        "PDF export: Chromium could not be started. The Docker images install it (after a Microsoft.Playwright " +
        "upgrade: docker compose build api). On a host: pwsh src/Homebrewery.Api/bin/Debug/net10.0/playwright.ps1 " +
        "install --only-shell chromium. PLAYWRIGHT_BROWSERS_PATH says where Chromium is looked for.")]
    private static partial void LogLaunchFailed(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Information, Message =
        "PDF export: {Bytes} bytes, {RemoteFiles} files of other sites, {MissingFiles} left out, {ElapsedMs} ms.")]
    private static partial void LogRendered(ILogger logger, int bytes, int remoteFiles, int missingFiles, long elapsedMs);

    [LoggerMessage(Level = LogLevel.Warning, Message = "PDF export: the render failed.")]
    private static partial void LogRenderFailed(ILogger logger, Exception exception);
}
