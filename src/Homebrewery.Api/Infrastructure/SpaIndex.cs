using System.Net.Http.Headers;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// The SPA's <c>index.html</c> for <see cref="ShareShell"/>.
/// <list type="bullet">
/// <item>Normally <c>{web root}/index.html</c> (the Vite build output), read once and cached outside Development. In
/// Development it is read on every request, so a rebuild shows up without a restart.</item>
/// <item>When <c>Spa:DevServerUrls</c> is set, the page comes from the Vite dev server instead, on every request, so
/// /share pages get Vite's module scripts and HMR client like every other page. The setting lists candidates, tried in
/// order starting with the last one that answered; appsettings.Development.json has <c>http://localhost:5173</c> (host
/// runs) and <c>http://web:5173</c> (docker compose). When none answers, the web root file is used.</item>
/// </list>
/// </summary>
public sealed partial class SpaIndex(
    IWebHostEnvironment environment, IConfiguration configuration, IHttpClientFactory httpClients, ILogger<SpaIndex> logger)
{
    /// <summary>Dev server URLs: an array, or one string separated by commas, semicolons or spaces.</summary>
    public const string DevServerUrlsKey = "Spa:DevServerUrls";

    /// <summary>Named <see cref="HttpClient"/> for the dev server.</summary>
    public const string DevServerClient = "SpaDevServer";

    public const string FileName = "index.html";

    private string? _cached;
    private volatile int _preferred;

    /// <summary>The index page, or null when there is none (no web build and no dev server).</summary>
    public async Task<string?> GetAsync(CancellationToken ct)
    {
        var devServers = ConfigurationLists.Read(configuration, DevServerUrlsKey);
        if (devServers.Count > 0 && await FetchAsync(devServers, ct) is { } fetched) return fetched;

        if (_cached is { } cached) return cached;
        var html = await ReadAsync(ct);
        if (html is not null && !environment.IsDevelopment()) _cached = html;
        return html;
    }

    private async Task<string?> ReadAsync(CancellationToken ct)
    {
        var file = environment.WebRootFileProvider.GetFileInfo(FileName);
        if (!file.Exists || file.IsDirectory) return null;
        await using var stream = file.CreateReadStream();
        using var reader = new StreamReader(stream);
        return await reader.ReadToEndAsync(ct);
    }

    private async Task<string?> FetchAsync(List<string> devServers, CancellationToken ct)
    {
        var start = _preferred < devServers.Count ? _preferred : 0;
        var failures = new List<string>();
        for (var i = 0; i < devServers.Count; i++)
        {
            var index = (start + i) % devServers.Count;
            var (html, failure) = await FetchAsync(devServers[index], ct);
            if (html is not null)
            {
                _preferred = index;
                return html;
            }

            failures.Add($"{devServers[index]}: {failure}");
        }

        LogDevServerFailed(string.Join("; ", failures));
        return null;
    }

    private async Task<(string? Html, string? Failure)> FetchAsync(string devServer, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(devServer), "/"));
            // Vite answers only its allowed hosts (localhost and IP addresses by default), not e.g. "web".
            request.Headers.Host = "localhost";
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/html"));
            using var response = await httpClients.CreateClient(DevServerClient).SendAsync(request, ct);
            return response.IsSuccessStatusCode
                ? (await response.Content.ReadAsStringAsync(ct), null)
                : (null, $"HTTP {(int)response.StatusCode}");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or UriFormatException && !ct.IsCancellationRequested)
        {
            return (null, ex.Message);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "No dev server answered for index.html ({Failures}); using the web root's index.html. Spa:DevServerUrls lists the Vite dev servers to try.")]
    private partial void LogDevServerFailed(string failures);
}
