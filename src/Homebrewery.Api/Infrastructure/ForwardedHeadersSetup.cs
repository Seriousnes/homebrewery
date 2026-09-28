using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Forwarded headers from the reverse proxy (a production TLS proxy; locally the router of deploy/stack/shared.yml).
/// </summary>
/// <remarks>
/// <para>The middleware is switched on by ASP.NET Core's own setting <c>ASPNETCORE_FORWARDEDHEADERS_ENABLED=true</c>
/// (configuration key <c>FORWARDEDHEADERS_ENABLED</c>), which the compose files set. That switch runs the middleware
/// first in the pipeline and trusts every peer, which is safe there because the API is reachable only through the proxy
/// (or, locally, on a loopback port). Without the switch (host-only runs, tests) forwarded headers are ignored.</para>
/// <para>This setup adds <c>X-Forwarded-Host</c> to the switch's <c>X-Forwarded-For</c> and <c>X-Forwarded-Proto</c>,
/// so the client IP (rate limits), scheme and host (<see cref="SameOriginWriteGuard"/>, link previews) are the
/// browser's. To trust only some proxies, list them: <c>ForwardedHeaders:KnownNetworks</c> (CIDR, e.g.
/// <c>172.16.0.0/12</c>) and/or <c>ForwardedHeaders:KnownProxies</c> (IP addresses).</para>
/// </remarks>
public static class ForwardedHeadersSetup
{
    public const string KnownNetworksKey = "ForwardedHeaders:KnownNetworks";
    public const string KnownProxiesKey = "ForwardedHeaders:KnownProxies";

    public static IServiceCollection AddProxyForwardedHeaders(this IServiceCollection services)
    {
        // Registered after the web host defaults, so this runs after the switch's own setup (which sets For | Proto and
        // clears the known proxies and networks).
        services.AddOptions<ForwardedHeadersOptions>().Configure<IConfiguration>((o, configuration) =>
        {
            o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;

            var networks = ConfigurationLists.Read(configuration, KnownNetworksKey);
            var proxies = ConfigurationLists.Read(configuration, KnownProxiesKey);
            if (networks.Count == 0 && proxies.Count == 0) return;

            o.KnownIPNetworks.Clear();
            o.KnownProxies.Clear();
            foreach (var network in networks) o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
            foreach (var proxy in proxies) o.KnownProxies.Add(IPAddress.Parse(proxy));
        });
        return services;
    }
}
