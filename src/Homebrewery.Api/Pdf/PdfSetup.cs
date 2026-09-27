using System.Net;

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
                AllowAutoRedirect = true,                                   // each hop connects through the callback
                MaxAutomaticRedirections = 3,
                AutomaticDecompression = DecompressionMethods.All,          // the size cap counts decompressed bytes
                ConnectTimeout = TimeSpan.FromSeconds(5),
                PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            });
        services.AddSingleton<IRemoteFileFetcher, RemoteFileFetcher>();
        services.AddSingleton<IPdfRenderer, PdfRenderer>();
        return services;
    }
}
