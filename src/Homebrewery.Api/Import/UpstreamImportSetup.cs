using System.Net;

namespace Homebrewery.Api.Import;

public static class UpstreamImportSetup
{
    /// <summary>Upstream request timeout.</summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    /// <summary>Registers the typed <see cref="HttpClient"/> of <see cref="UpstreamImportClient"/>.</summary>
    public static IServiceCollection AddUpstreamImport(this IServiceCollection services)
    {
        services.AddHttpClient<UpstreamImportClient>(c =>
            {
                c.BaseAddress = UpstreamImportClient.Upstream;             // informational: the client builds absolute URIs
                c.Timeout = Timeout;
                c.DefaultRequestHeaders.UserAgent.ParseAdd("HomebreweryImport/1.0");
                c.DefaultRequestHeaders.Accept.ParseAdd("text/plain");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                AllowAutoRedirect = false,                                  // a redirect must not reach another host
                AutomaticDecompression = DecompressionMethods.All,          // the size cap counts decompressed bytes
                UseCookies = false,
                ConnectTimeout = TimeSpan.FromSeconds(10),
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            });
        return services;
    }
}
