using System.Security.Claims;
using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Core;
using Homebrewery.Data;
using Homebrewery.Data.Configurations;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Endpoints;

/// <summary>
/// <c>/api/account/*</c> (plan §8.3). Registration and login are MapIdentityApi's <c>/api/auth/*</c>;
/// the SPA logs in with <c>POST /api/auth/login?useCookies=true</c>.
/// </summary>
public static class AccountEndpoints
{
    public static RouteGroupBuilder MapAccountEndpoints(this IEndpointRouteBuilder api)
    {
        var account = api.MapGroup("/account").WithTags("Account");

        account.MapGet("/me", GetMeAsync)
            .WithName("GetAccount")
            .WithSummary("The signed-in account, or 204 when anonymous.");
        account.MapPost("/logout", LogoutAsync)
            .RequireAuthorization()
            .WithName("Logout")
            .WithSummary("Sign out (clears the auth cookie).")
            .ProducesProblem(StatusCodes.Status401Unauthorized);
        account.MapPut("/handle", SetHandleAsync)
            .RequireAuthorization()
            .WithName("SetHandle")
            .WithSummary("Set the public handle used in /user/{handle}.")
            .WithDescription(Handles.Rules + " Case-insensitive; stored in lower case. 409 when taken.")
            .ProducesProblem(StatusCodes.Status409Conflict);

        return account;
    }

    internal static async Task<Results<Ok<AccountInfo>, NoContent>> GetMeAsync(
        ClaimsPrincipal principal, UserManager<AppUser> users)
    {
        if (principal.Identity?.IsAuthenticated != true) return TypedResults.NoContent();
        var user = await users.GetUserAsync(principal);
        return user is null ? TypedResults.NoContent() : TypedResults.Ok(await AccountInfo.CreateAsync(users, user));
    }

    internal static async Task<NoContent> LogoutAsync(SignInManager<AppUser> signIn)
    {
        await signIn.SignOutAsync();
        return TypedResults.NoContent();
    }

    internal static async Task<Results<Ok<AccountInfo>, ValidationProblem, ProblemHttpResult, UnauthorizedHttpResult>> SetHandleAsync(
        SetHandleRequest request, ClaimsPrincipal principal, AppUserManager users, CancellationToken ct)
    {
        var user = await users.GetUserAsync(principal);
        if (user is null) return TypedResults.Unauthorized();

        var handle = Handles.Normalize(request.Handle);
        if (!Handles.IsValid(handle))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["handle"] = [Handles.Rules] });
        }

        if (handle != user.Handle)
        {
            if (await users.IsHandleTakenAsync(handle, user.Id, ct)) return HandleTaken(handle);

            user.Handle = handle;
            IdentityResult result;
            try
            {
                result = await users.UpdateAsync(user);
            }
            catch (DbUpdateException ex) when (DbErrors.IsUniqueViolation(ex, AppUserConfiguration.HandleIndexName))
            {
                return HandleTaken(handle);                        // lost a race with another account
            }

            if (!result.Succeeded)
            {
                return TypedResults.ValidationProblem(result.Errors
                    .GroupBy(e => e.Code == HandleValidator.ErrorCode ? "handle" : e.Code)
                    .ToDictionary(g => g.Key, g => g.Select(e => e.Description).ToArray()));
            }
        }

        return TypedResults.Ok(await AccountInfo.CreateAsync(users, user));
    }

    private static ProblemHttpResult HandleTaken(string handle) => TypedResults.Problem(
        statusCode: StatusCodes.Status409Conflict,
        title: "Handle taken",
        detail: $"The handle '{handle}' is already in use.");
}

/// <summary>The signed-in account (<c>GET /api/account/me</c>).</summary>
/// <param name="Roles">Role names, e.g. <c>["Admin"]</c>; empty for regular users.</param>
public sealed record AccountInfo(Guid Id, string Handle, string? Email, IReadOnlyList<string> Roles)
{
    internal static async Task<AccountInfo> CreateAsync(UserManager<AppUser> users, AppUser user) =>
        new(user.Id, user.Handle, user.Email, [.. (await users.GetRolesAsync(user)).Order(StringComparer.Ordinal)]);
}

/// <summary>Body of <c>PUT /api/account/handle</c>.</summary>
public sealed record SetHandleRequest(string? Handle);
