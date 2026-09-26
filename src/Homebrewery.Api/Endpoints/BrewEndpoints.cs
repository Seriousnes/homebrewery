using System.Security.Claims;
using Homebrewery.Api.Admin;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Infrastructure.Identity;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

namespace Homebrewery.Api.Endpoints;

/// <summary>
/// <c>/api/brews/*</c> (plan §8.3, §8.4). Errors are problem+json: 400 validation problems (<c>errors</c> keyed by
/// field or document path such as <c>doc.content[0].attrs.style</c>), 401 when a signed-in user is required, 403 for
/// non-authors, 404 for unknown ids, 409 <see cref="SaveConflict"/> for stale saves and 423 for locked brews.
/// Write bodies may be gzip-compressed (<c>Content-Encoding: gzip</c>) and are capped at 20 MB before and after
/// decompression.
/// </summary>
public static class BrewEndpoints
{
    public static RouteGroupBuilder MapBrewEndpoints(this IEndpointRouteBuilder api)
    {
        var brews = api.MapGroup("/brews").WithTags("Brews");
        var bodyLimit = new RequestSizeLimit(BrewRules.MaxRequestBytes);

        brews.MapGet("/edit/{editId}", GetForEditAsync)
            .RequireAuthorization()
            .WithName("GetBrewForEdit")
            .WithSummary("The full brew for the editor (authors only), including the version to save against.")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound);

        brews.MapGet("/share/{shareId}", GetForShareAsync)
            .WithName("GetBrewForShare")
            .WithSummary("The read-only brew. Counts a view unless the caller is an author.")
            .WithDescription("A locked brew answers 423 with the lock's share message as `detail` and its code as `code`.")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status423Locked);

        brews.MapPost("/", CreateAsync)
            .RequireAuthorization()
            .WithMetadata(bodyLimit)
            .WithName("CreateBrew")
            .WithSummary("Create a brew (new or imported); the caller becomes its owner.")
            .WithDescription("Optional `Idempotency-Key` header (1-128 visible ASCII characters, e.g. a UUID; surrounding quotes are " +
                             "stripped): within 24 hours, the same user sending the same key with the same request again gets 201 with " +
                             "the brew the first request created (as it is now) instead of a second brew; the same key with a different " +
                             "request is 422. A malformed key is 400 with errors['Idempotency-Key'].")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity);

        brews.MapPut("/{editId}", SaveAsync)
            .RequireAuthorization()
            .WithMetadata(bodyLimit)
            .WithName("SaveBrew")
            .WithSummary("Save the whole brew against baseVersion (409 with the server version when stale).")
            .WithDescription("Only doc, style, snippets and the metadata fields are written. An invited author becomes an author on their first save. Only the owner may change meta.authors.")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge);

        brews.MapDelete("/{editId}", DeleteAsync)
            .RequireAuthorization()
            .WithName("DeleteBrew")
            .WithSummary("Leave the brew as an author; the brew is deleted when no owner or author remains.")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound);

        brews.MapPost("/{shareId}/clone", CloneAsync)
            .RequireAuthorization()
            .WithName("CloneBrew")
            .WithSummary("Copy a brew by share id into a new, unpublished brew owned by the caller.")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status423Locked);

        brews.MapPost("/{editId}/lock/review", RequestLockReviewAsync)
            .RequireAuthorization()
            .WithName("RequestLockReview")
            .WithSummary("Ask the moderators to review this brew's lock (authors only). Asking again keeps the first request time.")
            .WithDescription("409 when the brew is not locked. The admin review queue lists the brew until an admin unlocks it or dismisses the request.")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        return brews;
    }

    internal static async Task<Results<Ok<BrewLockInfo>, ProblemHttpResult>> RequestLockReviewAsync(
        string editId, ClaimsPrincipal user, AdminService admin, CancellationToken ct) =>
        await admin.RequestReviewAsync(editId, user.GetRequiredUserId(), ct) switch
        {
            ServiceOutcome<BrewLockInfo>.Ok ok => TypedResults.Ok(ok.Value),
            var other => other.ToProblem(),
        };

    internal static async Task<Results<Ok<BrewForEdit>, ProblemHttpResult>> GetForEditAsync(
        string editId, ClaimsPrincipal user, BrewService brews, CancellationToken ct) =>
        await brews.GetForEditAsync(editId, user.GetRequiredUserId(), ct) switch
        {
            BrewOutcome<BrewForEdit>.Ok ok => TypedResults.Ok(ok.Value),
            var other => Problem(other),
        };

    internal static async Task<Results<Ok<BrewForShare>, ProblemHttpResult>> GetForShareAsync(
        string shareId, ClaimsPrincipal user, BrewService brews, CancellationToken ct) =>
        await brews.GetForShareAsync(shareId, user.GetUserId(), ct) switch
        {
            BrewOutcome<BrewForShare>.Ok ok => TypedResults.Ok(ok.Value),
            var other => Problem(other),
        };

    internal static async Task<Results<Created<BrewForEdit>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        CreateBrewRequest request, ClaimsPrincipal user, BrewService brews, HttpRequest http, CancellationToken ct,
        [FromHeader(Name = CreateIdempotency.HeaderName)] string? idempotencyKey = null) =>
        // The parameter documents the header in OpenAPI; binding drops an empty value, which is malformed, not absent.
        await brews.CreateAsync(request, user.GetRequiredUserId(), CreateIdempotency.HeaderValue(http.Headers) ?? idempotencyKey, ct) switch
        {
            BrewOutcome<BrewForEdit>.Ok ok => TypedResults.Created($"/api/brews/edit/{ok.Value.EditId}", ok.Value),
            BrewOutcome<BrewForEdit>.Invalid invalid => Invalid(invalid.Errors),
            var other => Problem(other),
        };

    internal static async Task<Results<Ok<SaveBrewResponse>, Conflict<SaveConflict>, ValidationProblem, ProblemHttpResult>> SaveAsync(
        string editId, SaveBrewRequest request, ClaimsPrincipal user, BrewService brews, CancellationToken ct) =>
        await brews.SaveAsync(editId, request, user.GetRequiredUserId(), ct) switch
        {
            BrewOutcome<SaveBrewResponse>.Ok ok => TypedResults.Ok(ok.Value),
            BrewOutcome<SaveBrewResponse>.Conflict conflict => TypedResults.Conflict(new SaveConflict(conflict.ServerVersion)),
            BrewOutcome<SaveBrewResponse>.Invalid invalid => Invalid(invalid.Errors),
            var other => Problem(other),
        };

    internal static async Task<Results<Ok<DeleteBrewResponse>, ProblemHttpResult>> DeleteAsync(
        string editId, ClaimsPrincipal user, BrewService brews, CancellationToken ct) =>
        await brews.DeleteAsync(editId, user.GetRequiredUserId(), ct) switch
        {
            BrewOutcome<DeleteBrewResponse>.Ok ok => TypedResults.Ok(ok.Value),
            var other => Problem(other),
        };

    internal static async Task<Results<Created<BrewForEdit>, ProblemHttpResult>> CloneAsync(
        string shareId, ClaimsPrincipal user, BrewService brews, CancellationToken ct) =>
        await brews.CloneAsync(shareId, user.GetRequiredUserId(), ct) switch
        {
            BrewOutcome<BrewForEdit>.Ok ok => TypedResults.Created($"/api/brews/edit/{ok.Value.EditId}", ok.Value),
            var other => Problem(other),
        };

    private static ValidationProblem Invalid(IDictionary<string, string[]> errors) =>
        TypedResults.ValidationProblem(errors, title: "The brew is not valid.");

    private static ProblemHttpResult Problem<T>(BrewOutcome<T> outcome) => outcome switch
    {
        BrewOutcome<T>.NotFound => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Brew not found"),
        BrewOutcome<T>.Forbidden f => TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Forbidden", detail: f.Detail),
        BrewOutcome<T>.Locked l => TypedResults.Problem(
            statusCode: StatusCodes.Status423Locked,
            title: "Brew locked",
            detail: l.Message,
            extensions: new Dictionary<string, object?> { ["code"] = l.Code }),
        BrewOutcome<T>.Invalid i => TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "The brew is not valid.",
            extensions: new Dictionary<string, object?> { ["errors"] = i.Errors }),
        BrewOutcome<T>.Conflict c => TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "Version conflict",
            extensions: new Dictionary<string, object?> { ["serverVersion"] = c.ServerVersion }),
        BrewOutcome<T>.KeyReused => TypedResults.Problem(statusCode: StatusCodes.Status422UnprocessableEntity, title: "Idempotency-Key reused",
            detail: "This Idempotency-Key was used for a different request. Send that request again, or use a new key."),
        _ => throw new InvalidOperationException($"Unexpected outcome {outcome.GetType().Name}."),
    };
}
