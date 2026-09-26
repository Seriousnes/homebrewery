using System.Security.Claims;
using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Api.Themes;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Endpoints;

/// <summary>
/// <c>/api/themes</c> (plan §8.3, §8.7). Public; a signed-in caller also gets their own unpublished user themes.
/// </summary>
public static class ThemeEndpoints
{
    public static RouteGroupBuilder MapThemeEndpoints(this IEndpointRouteBuilder api)
    {
        var themes = api.MapGroup("/themes").WithTags("Themes");

        themes.MapGet("/", ListAsync)
            .WithName("ListThemes")
            .WithSummary("Static themes, published user themes, and the caller's own user themes.");

        themes.MapGet("/{theme}/bundle", GetBundleAsync)
            .WithName("GetThemeBundle")
            .WithSummary("A theme's inheritance chain, root first: stylesheets (URLs or raw user-theme CSS) and snippet sources.")
            .WithDescription(
                "`theme` is a static theme key (e.g. `5ePHB`) or a user theme's share id. 404 when it is neither; 422 " +
                "(problem+json with `chain`) for a cycle, a chain longer than 8 themes, or a base theme that is missing or " +
                "not tagged `meta:theme`; 423 when a theme brew in the chain is locked.")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .ProducesProblem(StatusCodes.Status423Locked);

        return themes;
    }

    internal static async Task<Ok<ThemeList>> ListAsync(ClaimsPrincipal user, ThemeService themes, CancellationToken ct) =>
        TypedResults.Ok(await themes.ListAsync(user.GetUserId(), ct));

    internal static async Task<Results<Ok<ThemeBundle>, ProblemHttpResult>> GetBundleAsync(
        string theme, ThemeService themes, CancellationToken ct) =>
        await themes.GetBundleAsync(theme, ct) switch
        {
            ThemeOutcome.Ok ok => TypedResults.Ok(ok.Bundle),
            ThemeOutcome.NotFound => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Theme not found"),
            ThemeOutcome.BrokenChain broken => TypedResults.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: "Invalid theme chain",
                detail: broken.Detail,
                extensions: new Dictionary<string, object?> { ["chain"] = broken.Chain }),
            ThemeOutcome.Locked locked => TypedResults.Problem(
                statusCode: StatusCodes.Status423Locked,
                title: "Theme locked",
                detail: locked.Message,
                extensions: new Dictionary<string, object?> { ["code"] = locked.Code }),
            var other => throw new InvalidOperationException($"Unexpected outcome {other.GetType().Name}."),
        };
}
