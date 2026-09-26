using System.Security.Claims;
using Homebrewery.Core;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>
/// <see cref="SignInManager{TUser}"/> that grants the Admin role to listed emails before the principal
/// is built, so the role claim is in the cookie from the first sign-in. Runs for password, two-factor
/// and external sign-ins and for cookie refreshes (security stamp validation).
/// </summary>
public sealed class AppSignInManager(
    UserManager<AppUser> userManager,
    IHttpContextAccessor contextAccessor,
    IUserClaimsPrincipalFactory<AppUser> claimsFactory,
    IOptions<IdentityOptions> optionsAccessor,
    ILogger<SignInManager<AppUser>> logger,
    IAuthenticationSchemeProvider schemes,
    IUserConfirmation<AppUser> confirmation,
    AdminAccounts admins)
    : SignInManager<AppUser>(userManager, contextAccessor, claimsFactory, optionsAccessor, logger, schemes, confirmation)
{
    public override async Task SignInWithClaimsAsync(
        AppUser user, AuthenticationProperties? authenticationProperties, IEnumerable<Claim> additionalClaims)
    {
        await admins.EnsureRoleAsync(UserManager, user);
        await base.SignInWithClaimsAsync(user, authenticationProperties, additionalClaims);
    }
}
