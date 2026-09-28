using System.Net;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Homebrewery.Api.Pdf;

public static class PdfSetup
{
    /// <summary>
    /// Registers <see cref="PdfOptions"/>, the renderer (a singleton that owns Chromium, closed on shutdown) and the
    /// guarded client for other sites' files. Chromium starts on the first render, not with the host.
    /// </summary>
    public static IServiceCollection AddPdfExport(this IServiceCollection services)
    {
        services.AddOptions<PdfOptions>().BindConfiguration(PdfOptions.SectionName)
            .Validate(o => o.IsValid, "Pdf: MaxConcurrentRenders must be at least 1, sizes at least 1 byte and timeouts positive.")
            .ValidateOnStart();

        services.AddHttpClient(RemoteFileFetcher.ClientName, c =>
            {
                c.Timeout = Timeout.InfiniteTimeSpan;                      // PdfOptions.RemoteFileTimeout, per file
                c.DefaultRequestHeaders.Accept.ParseAdd("*/*");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                ConnectCallback = RemoteFileFetcher.ConnectToPublicAddressAsync,
                UseProxy = false,                                           // a proxy would connect for us, unchecked
                UseCookies = false,
                // Each hop connects through the callback. SocketsHttpHandler never follows https to http: the
                // redirect comes back as a 3xx, which the fetcher leaves out.
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 3,
                AutomaticDecompression = DecompressionMethods.All,          // the size cap counts decompressed bytes
                ConnectTimeout = TimeSpan.FromSeconds(5),
                PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            });
        services.TryAddSingleton(TimeProvider.System);                     // the render timeout's clock
        services.AddSingleton<IRemoteFileFetcher, RemoteFileFetcher>();
        services.AddSingleton<IPdfRenderer, PdfRenderer>();
        return services;
    }
}
