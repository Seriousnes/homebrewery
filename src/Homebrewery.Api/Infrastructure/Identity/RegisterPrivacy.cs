using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>
/// Endpoint filter for the <c>/api/auth</c> group: <c>POST /register</c> answers an email that already has an account
/// like a new registration (200, empty body), instead of Identity's <c>DuplicateUserName</c>/<c>DuplicateEmail</c>
/// errors, which told anyone which emails are registered. The existing account is not changed. Errors that do not
/// depend on existing accounts (the password rules, an invalid email) are still reported.
/// </summary>
/// <remarks>
/// Without email confirmation, trying to sign in with the password just registered still tells the two cases apart.
/// Requiring confirmed emails (with an email sender) and a uniform "check your email" answer would close that too.
/// </remarks>
public static class RegisterPrivacy
{
    private static readonly string[] AccountExistsErrors = ["DuplicateUserName", "DuplicateEmail"];

    public static async ValueTask<object?> HideExistingAccounts(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var result = await next(context);
        var request = context.HttpContext.Request;
        if (!HttpMethods.IsPost(request.Method) || request.Path.Value?.EndsWith("/register", StringComparison.OrdinalIgnoreCase) != true)
        {
            return result;
        }

        if ((result is INestedHttpResult nested ? nested.Result : result) is not ValidationProblem problem) return result;

        var errors = problem.ProblemDetails.Errors;
        if (!errors.Keys.Any(AccountExistsErrors.Contains)) return result;
        var others = errors.Where(e => !AccountExistsErrors.Contains(e.Key)).ToDictionary(e => e.Key, e => e.Value);
        return others.Count == 0 ? TypedResults.Ok() : TypedResults.ValidationProblem(others);
    }
}
