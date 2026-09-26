using System.Buffers;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Homebrewery.Api.Import;

/// <summary>
/// Downloads a brew's Homebrewery markdown from the public Homebrewery (plan §8.3, P2.8) for the import page. Upstream's
/// <c>GET /download/{shareId}</c> answers <c>text/plain</c> with the brew text, prefixed by its <c>```metadata</c> and
/// <c>```css</c> blocks (legacy/server/page-routes.js).
/// </summary>
/// <remarks>
/// Not an open proxy: the host is fixed (<see cref="Upstream"/>, whatever the HttpClient's base address), the share id
/// must match <see cref="IsValidShareId"/> (letters, digits, <c>_</c> and <c>-</c> only, so it cannot add path
/// segments, a query or another host), redirects are not followed, and the body is streamed and abandoned past
/// <see cref="MaxBytes"/>.
/// </remarks>
public sealed partial class UpstreamImportClient(HttpClient http, ILogger<UpstreamImportClient> logger)
{
    /// <summary>The only host this client requests.</summary>
    public static readonly Uri Upstream = new("https://homebrewery.naturalcrit.com/");

    /// <summary>Largest brew text accepted (decompressed bytes).</summary>
    public const int MaxBytes = 2 * 1024 * 1024;

    /// <summary>Upstream share ids: <c>^[\w-]{10,14}$</c> with ASCII <c>\w</c>.</summary>
    [GeneratedRegex(@"\A[A-Za-z0-9_-]{10,14}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ShareIdPattern();

    public static bool IsValidShareId(string? shareId) => shareId is not null && ShareIdPattern().IsMatch(shareId);

    /// <summary><c>https://homebrewery.naturalcrit.com/download/{shareId}</c>.</summary>
    /// <exception cref="ArgumentException">The id is not a valid share id.</exception>
    public static Uri DownloadUri(string shareId)
    {
        if (!IsValidShareId(shareId)) throw new ArgumentException("Not a Homebrewery share id.", nameof(shareId));
        var uri = new Uri(Upstream, "download/" + shareId);
        // Belt and braces: the pattern already rules out anything that could change the host or path.
        if (uri.Host != Upstream.Host || uri.Scheme != Upstream.Scheme || uri.AbsolutePath != "/download/" + shareId
            || uri.Query.Length > 0)
        {
            throw new ArgumentException("Not a Homebrewery share id.", nameof(shareId));
        }

        return uri;
    }

    /// <summary>Fetches the brew text of <paramref name="shareId"/>.</summary>
    public async Task<ImportOutcome> DownloadAsync(string shareId, CancellationToken ct)
    {
        if (!IsValidShareId(shareId)) return new ImportOutcome.InvalidId();

        using var request = new HttpRequestMessage(HttpMethod.Get, DownloadUri(shareId));
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode == HttpStatusCode.NotFound) return new ImportOutcome.NotFound();
            if (response.StatusCode != HttpStatusCode.OK)
            {
                return Failed(shareId, $"HTTP {(int)response.StatusCode}", (int)response.StatusCode);   // redirects: never followed
            }

            var mediaType = response.Content.Headers.ContentType?.MediaType;
            if (!string.Equals(mediaType, "text/plain", StringComparison.OrdinalIgnoreCase))
            {
                return Failed(shareId, $"unexpected content type '{mediaType}'");  // e.g. an HTML error page
            }

            if (response.Content.Headers.ContentLength > MaxBytes) return new ImportOutcome.TooLarge();

            await using var body = await response.Content.ReadAsStreamAsync(ct);
            var bytes = await ReadCappedAsync(body, ct);
            if (bytes is null) return new ImportOutcome.TooLarge();

            return new ImportOutcome.Ok(Decode(bytes, response.Content.Headers.ContentType?.CharSet));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)       // incl. a connection dropped mid-body
        {
            return Failed(shareId, ex.Message);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return Failed(shareId, "timed out");
        }
    }

    /// <summary>The whole body, or null as soon as it passes <see cref="MaxBytes"/> (the rest is never read).</summary>
    private static async Task<byte[]?> ReadCappedAsync(Stream body, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = ArrayPool<byte>.Shared.Rent(81920);
        try
        {
            int read;
            while ((read = await body.ReadAsync(chunk.AsMemory(0, 81920), ct)) > 0)
            {
                if (buffer.Length + read > MaxBytes) return null;
                buffer.Write(chunk, 0, read);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(chunk);
        }

        return buffer.ToArray();
    }

    private static string Decode(byte[] bytes, string? charset)
    {
        Encoding encoding;
        try
        {
            encoding = string.IsNullOrWhiteSpace(charset) ? Encoding.UTF8 : Encoding.GetEncoding(charset.Trim('"'));
        }
        catch (ArgumentException)
        {
            encoding = Encoding.UTF8;
        }

        var text = encoding.GetString(bytes);
        return text.Length > 0 && text[0] == '﻿' ? text[1..] : text;
    }

    private ImportOutcome.Failed Failed(string shareId, string reason, int? upstreamStatus = null)
    {
        LogFailed(shareId, reason);
        return new ImportOutcome.Failed(reason, upstreamStatus);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Import of Homebrewery brew {ShareId} failed: {Reason}.")]
    private partial void LogFailed(string shareId, string reason);
}

/// <summary>What <see cref="UpstreamImportClient.DownloadAsync"/> produced.</summary>
public abstract record ImportOutcome
{
    private ImportOutcome()
    {
    }

    /// <summary>The brew's markdown.</summary>
    public sealed record Ok(string Text) : ImportOutcome;

    /// <summary>Not a share id (400).</summary>
    public sealed record InvalidId : ImportOutcome;

    /// <summary>Upstream has no such brew (404).</summary>
    public sealed record NotFound : ImportOutcome;

    /// <summary>Over <see cref="UpstreamImportClient.MaxBytes"/> (413).</summary>
    public sealed record TooLarge : ImportOutcome;

    /// <summary>
    /// Upstream failed, timed out, redirected or answered something other than text (502). <paramref name="UpstreamStatus"/>
    /// is upstream's HTTP status when it answered with one other than 200 and 404 (a locked brew answers its lock code).
    /// <paramref name="Reason"/> is for logs only.
    /// </summary>
    public sealed record Failed(string Reason, int? UpstreamStatus = null) : ImportOutcome;
}
