using Homebrewery.Api.Admin;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Infrastructure.Identity;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Endpoints;

/// <summary>
/// <c>/api/admin/*</c> (plan §8.3, P7.4). The whole group requires the <see cref="Policies.Admin"/> policy, so every
/// endpoint added here is admin-only (401 anonymous, 403 signed-in non-admin).
/// </summary>
public static class AdminEndpoints
{
    public static RouteGroupBuilder MapAdminEndpoints(this IEndpointRouteBuilder api)
    {
        var admin = api.MapGroup("/admin")
            .RequireAuthorization(Policies.Admin)
            .WithTags("Admin")
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

        admin.MapGet("/stats", GetStatsAsync)
            .WithName("AdminGetStats")
            .WithSummary("Site totals: brews, published brews, users, locked brews and pending lock reviews.");

        admin.MapGet("/users", FindUsersAsync)
            .WithName("AdminFindUsers")
            .WithSummary("Accounts whose handle or email contains q (case-insensitive), or whose id is q; at most 50, exact matches first.")
            .ProducesValidationProblem();

        admin.MapGet("/users/{handle}/brews", ListUserBrewsAsync)
            .WithName("AdminListUserBrews")
            .WithSummary("Every brew of an account as the account itself sees them: unpublished, locked and invited ones included, with edit ids and roles.")
            .ProducesProblem(StatusCodes.Status404NotFound);

        admin.MapGet("/brews/{id}", GetBrewAsync)
            .WithName("AdminGetBrew")
            .WithSummary("A brew (without its document) by internal id, share id or edit id.")
            .ProducesProblem(StatusCodes.Status404NotFound);

        admin.MapPut("/brews/{shareId}/lock", LockAsync)
            .WithName("AdminLockBrew")
            .WithSummary("Lock a brew: its share page shows shareMessage (423) and its editor shows editMessage. Replaces an existing lock.")
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status404NotFound);

        admin.MapDelete("/brews/{shareId}/lock", UnlockAsync)
            .WithName("AdminUnlockBrew")
            .WithSummary("Remove a brew's lock (a no-op when it is not locked).")
            .ProducesProblem(StatusCodes.Status404NotFound);

        admin.MapDelete("/brews/{shareId}/lock/review", DismissReviewAsync)
            .WithName("AdminDismissLockReview")
            .WithSummary("Dismiss the authors' review request and keep the lock (409 when the brew is not locked).")
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        admin.MapGet("/locks", ListLocksAsync)
            .WithName("AdminListLocks")
            .WithSummary("Every locked brew, most recently locked first.");

        admin.MapGet("/locks/review-queue", ReviewQueueAsync)
            .WithName("AdminLockReviewQueue")
            .WithSummary("Locked brews whose authors asked for a review, oldest request first.");

        admin.MapAdminNotificationEndpoints();
        return admin;
    }

    internal static async Task<Ok<AdminStats>> GetStatsAsync(AdminService admin, CancellationToken ct) =>
        TypedResults.Ok(await admin.GetStatsAsync(ct));

    internal static async Task<Results<Ok<List<AdminUserInfo>>, ValidationProblem, ProblemHttpResult>> FindUsersAsync(
        string? q, AdminService admin, CancellationToken ct) =>
        await admin.FindUsersAsync(q, ct) switch
        {
            ServiceOutcome<List<AdminUserInfo>>.Ok ok => TypedResults.Ok(ok.Value),
            ServiceOutcome<List<AdminUserInfo>>.Invalid invalid => TypedResults.ValidationProblem(invalid.Errors),
            var other => other.ToProblem(),
        };

    internal static async Task<Results<Ok<UserBrewList>, ProblemHttpResult>> ListUserBrewsAsync(
        string handle, BrewListService lists, CancellationToken ct) =>
        await lists.UserBrewsAsync(handle, callerId: null, ct, asOwner: true) switch
        {
            BrewOutcome<UserBrewList>.Ok ok => TypedResults.Ok(ok.Value),
            BrewOutcome<UserBrewList>.NotFound => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "User not found"),
            var other => throw new InvalidOperationException($"Unexpected outcome {other.GetType().Name}."),
        };

    internal static async Task<Results<Ok<AdminBrewInfo>, ProblemHttpResult>> GetBrewAsync(
        string id, AdminService admin, CancellationToken ct) =>
        await admin.FindBrewAsync(id, ct) is { } brew
            ? TypedResults.Ok(brew)
            : TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: AdminService.BrewNotFound);

    internal static async Task<Results<Ok<AdminBrewInfo>, ValidationProblem, ProblemHttpResult>> LockAsync(
        string shareId, LockRequest request, AdminService admin, CancellationToken ct) =>
        Map(await admin.LockAsync(shareId, request, ct));

    internal static async Task<Results<Ok<AdminBrewInfo>, ValidationProblem, ProblemHttpResult>> UnlockAsync(
        string shareId, AdminService admin, CancellationToken ct) =>
        Map(await admin.UnlockAsync(shareId, ct));

    internal static async Task<Results<Ok<AdminBrewInfo>, ValidationProblem, ProblemHttpResult>> DismissReviewAsync(
        string shareId, AdminService admin, CancellationToken ct) =>
        Map(await admin.DismissReviewAsync(shareId, ct));

    internal static async Task<Ok<List<LockedBrewInfo>>> ListLocksAsync(AdminService admin, CancellationToken ct) =>
        TypedResults.Ok(await admin.ListLocksAsync(ct));

    internal static async Task<Ok<List<LockedBrewInfo>>> ReviewQueueAsync(AdminService admin, CancellationToken ct) =>
        TypedResults.Ok(await admin.ReviewQueueAsync(ct));

    private static Results<Ok<AdminBrewInfo>, ValidationProblem, ProblemHttpResult> Map(ServiceOutcome<AdminBrewInfo> outcome) =>
        outcome switch
        {
            ServiceOutcome<AdminBrewInfo>.Ok ok => TypedResults.Ok(ok.Value),
            ServiceOutcome<AdminBrewInfo>.Invalid invalid => TypedResults.ValidationProblem(invalid.Errors),
            var other => other.ToProblem(),
        };
}
