using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Pdf;

/// <summary>An https file of another site, fetched for a PDF render.</summary>
public sealed record RemoteFile(byte[] Body, string? ContentType);

/// <summary>Fetches the https files (images, fonts, stylesheets) that an exported brew links to on other sites.</summary>
public interface IRemoteFileFetcher
{
    /// <summary>
    /// The file, or null when it is not https, not public, too large, too slow or not there. Its bytes are taken from
    /// <paramref name="budget"/> while they arrive; a file that does not fit is left out and gives its bytes back.
    /// </summary>
    Task<RemoteFile?> FetchAsync(Uri uri, string? userAgent, RemoteByteBudget budget, CancellationToken ct);
}

/// <summary>
/// The bytes that one render may still fetch (<see cref="PdfOptions.MaxRemoteBytes"/>), shared by its concurrent fetches.
/// Taken as the bytes arrive, so fetches running at the same time cannot hold more than the budget between them.
/// </summary>
public sealed class RemoteByteBudget(long bytes)
{
    private long _left = bytes;

    public long Left => Volatile.Read(ref _left);

    /// <summary>Takes <paramref name="bytes"/>; false, and nothing taken, when fewer are left.</summary>
    public bool TryTake(long bytes)
    {
        var left = Volatile.Read(ref _left);
        while (left >= bytes)
        {
            var seen = Interlocked.CompareExchange(ref _left, left - bytes, left);
            if (seen == left) return true;
            left = seen;
        }
        return false;
    }

    public void Return(long bytes) => Interlocked.Add(ref _left, bytes);
}

/// <summary>
/// <see cref="IRemoteFileFetcher"/> over the <see cref="ClientName"/> client. That client connects to public addresses
/// only (<see cref="ConnectToPublicAddressAsync"/>), checked on every connection, redirects included, so neither a
/// brew's URL nor a later DNS answer reaches the server's own network. https only, no proxy, no cookies, at most three
/// redirects; <see cref="PdfOptions.MaxRemoteFileBytes"/> and <see cref="PdfOptions.RemoteFileTimeout"/> per file, and
/// the render's <see cref="RemoteByteBudget"/>.
/// </summary>
public sealed partial class RemoteFileFetcher(IHttpClientFactory clients, IOptions<PdfOptions> options, ILogger<RemoteFileFetcher> logger)
    : IRemoteFileFetcher
{
    /// <summary>The named <see cref="HttpClient"/> (registered by <see cref="PdfSetup.AddPdfExport"/>).</summary>
    public const string ClientName = "pdf-remote-files";

    public async Task<RemoteFile?> FetchAsync(Uri uri, string? userAgent, RemoteByteBudget budget, CancellationToken ct)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps) return null;
        var settings = options.Value;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(settings.RemoteFileTimeout);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            // Some font services (Google Fonts) answer by browser: send Chromium's own user agent.
            if (!string.IsNullOrEmpty(userAgent)) request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
            using var response = await clients.CreateClient(ClientName)
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                LogFailed(logger, uri.Host, $"HTTP {(int)response.StatusCode}");
                return null;
            }
            if (response.Content.Headers.ContentLength > Math.Min(settings.MaxRemoteFileBytes, budget.Left))
            {
                LogFailed(logger, uri.Host, "too large");
                return null;
            }
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            var body = await ReadAtMostAsync(stream, settings.MaxRemoteFileBytes, budget, timeout.Token);
            if (body is null)
            {
                LogFailed(logger, uri.Host, "too large");
                return null;
            }
            return new RemoteFile(body, response.Content.Headers.ContentType?.ToString());
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException || (ex is OperationCanceledException && !ct.IsCancellationRequested))
        {
            LogFailed(logger, uri.Host, ex is OperationCanceledException ? "timed out" : ex.Message);
            return null;
        }
    }

    /// <summary>
    /// The stream's bytes, taken from <paramref name="budget"/> chunk by chunk, or null when there are more than
    /// <paramref name="max"/> or than the budget has left. A file that is not kept gives its bytes back.
    /// </summary>
    private static async Task<byte[]?> ReadAtMostAsync(Stream stream, long max, RemoteByteBudget budget, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        var kept = false;
        try
        {
            int read;
            while ((read = await stream.ReadAsync(chunk, ct)) > 0)
            {
                if (buffer.Length + read > max || !budget.TryTake(read)) return null;
                buffer.Write(chunk, 0, read);
            }
            kept = true;
            return buffer.ToArray();
        }
        finally
        {
            if (!kept) budget.Return(buffer.Length);
        }
    }

    /// <summary>
    /// <see cref="SocketsHttpHandler.ConnectCallback"/>: resolves the host and connects to one of its public addresses
    /// (<see cref="PublicAddress.IsPublic"/>); a host with none fails the request.
    /// </summary>
    public static async ValueTask<Stream> ConnectToPublicAddressAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var host = context.DnsEndPoint.Host;
        var addresses = IPAddress.TryParse(host, out var literal) ? [literal] : await Dns.GetHostAddressesAsync(host, ct);
        var allowed = addresses.Where(PublicAddress.IsPublic).ToArray();
        if (allowed.Length == 0)
        {
            throw new HttpRequestException(HttpRequestError.ConnectionError, $"{host} does not resolve to a public address.");
        }

        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(allowed, context.DnsEndPoint.Port, ct);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "PDF export: a file from {Host} was left out ({Reason}).")]
    private static partial void LogFailed(ILogger logger, string host, string reason);
}
