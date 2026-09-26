using System.Security.Claims;
using System.Text.Json.Nodes;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure.Identity;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.OpenApi;

namespace Homebrewery.Api.Endpoints;

/// <summary>
/// Public brew lists (plan §8.3): <c>GET /api/vault</c> and <c>GET /api/users/{handle}/brews</c>.
/// </summary>
public static class BrewListEndpoints
{
    public static IEndpointRouteBuilder MapBrewListEndpoints(this IEndpointRouteBuilder api)
    {
        api.MapGet("/vault", VaultAsync)
            .WithTags("Vault")
            .WithName("SearchVault")
            .WithSummary("Search published brews (title, description and text), sorted and paged.")
            .WithDescription(
                "`q` uses web search syntax with the `simple` text search configuration (no stemming, any language). " +
                "`sort`: relevance (default with `q`), updated (default without), created, views, title. `dir`: asc or desc " +
                "(default asc for title, desc otherwise). `pageSize` is clamped to 1-60 (default 20) and `page` to 1-10000. " +
                "An unknown `sort` or `dir`, or a `q` over 256 characters, is a 400 validation problem.")
            .ProducesValidationProblem()
            .AddOpenApiOperationTransformer((operation, _, _) =>
            {
                SetEnum(operation, "sort", BrewListService.Sorts);
                SetEnum(operation, "dir", BrewListService.Directions);
                return Task.CompletedTask;
            });

        api.MapGet("/users/{handle}/brews", UserBrewsAsync)
            .WithTags("Users")
            .WithName("ListUserBrews")
            .WithSummary("A user's brews: published ones for everyone; all of them, with edit ids, for the user.")
            .ProducesProblem(StatusCodes.Status404NotFound);

        return api;
    }

    internal static async Task<Results<Ok<VaultPage>, ValidationProblem>> VaultAsync(
        [AsParameters] VaultQuery query, BrewListService lists, CancellationToken ct) =>
        await lists.VaultAsync(query, ct) switch
        {
            BrewOutcome<VaultPage>.Ok ok => TypedResults.Ok(ok.Value),
            BrewOutcome<VaultPage>.Invalid invalid => TypedResults.ValidationProblem(invalid.Errors, title: "The search is not valid."),
            var other => throw new InvalidOperationException($"Unexpected outcome {other.GetType().Name}."),
        };

    internal static async Task<Results<Ok<UserBrewList>, ProblemHttpResult>> UserBrewsAsync(
        string handle, ClaimsPrincipal user, BrewListService lists, CancellationToken ct) =>
        await lists.UserBrewsAsync(handle, user.GetUserId(), ct) switch
        {
            BrewOutcome<UserBrewList>.Ok ok => TypedResults.Ok(ok.Value),
            BrewOutcome<UserBrewList>.NotFound => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "User not found"),
            var other => throw new InvalidOperationException($"Unexpected outcome {other.GetType().Name}."),
        };

    /// <summary>Lists the accepted values of a string query parameter in the OpenAPI document.</summary>
    private static void SetEnum(OpenApiOperation operation, string name, IReadOnlyList<string> values)
    {
        var parameter = operation.Parameters?.FirstOrDefault(p => p.Name == name);
        if (parameter?.Schema is OpenApiSchema schema) schema.Enum = [.. values.Select(v => (JsonNode)JsonValue.Create(v))];
    }
}
