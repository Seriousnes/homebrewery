using System.Security.Claims;

namespace Homebrewery.Api.Infrastructure.Identity;

public static class ClaimsPrincipalExtensions
{
    /// <summary>The signed-in user's id (Identity's NameIdentifier claim), or null when anonymous.</summary>
    public static Guid? GetUserId(this ClaimsPrincipal principal) =>
        principal.Identity?.IsAuthenticated == true
        && Guid.TryParse(principal.FindFirstValue(ClaimTypes.NameIdentifier), out var id)
            ? id
            : null;

    /// <summary>The signed-in user's id; for endpoints that require authorization.</summary>
    /// <exception cref="InvalidOperationException">The principal has no user id.</exception>
    public static Guid GetRequiredUserId(this ClaimsPrincipal principal) =>
        principal.GetUserId() ?? throw new InvalidOperationException("The endpoint requires a signed-in user.");
}
