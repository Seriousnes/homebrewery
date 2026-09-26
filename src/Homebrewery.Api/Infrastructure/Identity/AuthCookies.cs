using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>
/// The <c>Secure</c> attribute of every Identity cookie (the sign-in cookie plus the external and two-factor ones).
/// </summary>
/// <remarks>
/// <para><c>Auth:CookieSecurePolicy</c>:</para>
/// <list type="bullet">
/// <item><c>SameAsRequest</c> (default): <c>Secure</c> when the request is HTTPS. Behind Caddy that is the browser's
/// scheme, because the forwarded-headers middleware (<see cref="ForwardedHeadersSetup"/>, switched on by
/// <c>ASPNETCORE_FORWARDEDHEADERS_ENABLED=true</c>) applies <c>X-Forwarded-Proto</c> first. Plain-HTTP development
/// (http://localhost:8080, TestServer) keeps working.</item>
/// <item><c>Always</c>: <c>Secure</c> on every response. Use it for a deployment that is only reachable over HTTPS
/// when the proxy's scheme cannot be forwarded; browsers then keep the cookie only on https:// (and localhost).</item>
/// </list>
/// <c>None</c> (never <c>Secure</c>) is refused at startup.
/// </remarks>
public sealed class AuthCookieSettings
{
    public const string SectionName = "Auth";

    public CookieSecurePolicy CookieSecurePolicy { get; set; } = CookieSecurePolicy.SameAsRequest;
}

public static class AuthCookies
{
    public const string SecurePolicyKey = $"{AuthCookieSettings.SectionName}:{nameof(AuthCookieSettings.CookieSecurePolicy)}";

    public static IServiceCollection AddAuthCookieSecurity(this IServiceCollection services)
    {
        services.AddOptions<AuthCookieSettings>()
            .BindConfiguration(AuthCookieSettings.SectionName)
            .Validate(s => s.CookieSecurePolicy is CookieSecurePolicy.SameAsRequest or CookieSecurePolicy.Always,
                $"{SecurePolicyKey} must be SameAsRequest or Always.")
            .ValidateOnStart();

        // Every named cookie scheme, registered after AddIdentityApiEndpoints so this runs after Identity's setup.
        services.AddSingleton<IConfigureOptions<CookieAuthenticationOptions>>(sp =>
        {
            var settings = sp.GetRequiredService<IOptions<AuthCookieSettings>>();
            return new ConfigureNamedOptions<CookieAuthenticationOptions>(name: null,
                o => o.Cookie.SecurePolicy = settings.Value.CookieSecurePolicy);
        });
        return services;
    }
}
