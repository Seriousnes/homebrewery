using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Notifications;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Endpoints;

/// <summary>
/// Site notifications (plan §8.3): the public <c>GET /api/notifications/active</c> here, and the admin CRUD under
/// <c>/api/admin/notifications</c> (<see cref="MapAdminNotificationEndpoints"/>, mapped into the admin group).
/// </summary>
public static class NotificationEndpoints
{
    public static RouteGroupBuilder MapNotificationEndpoints(this IEndpointRouteBuilder api)
    {
        var notifications = api.MapGroup("/notifications").WithTags("Notifications");

        notifications.MapGet("/active", ListActiveAsync)
            .WithName("ListActiveNotifications")
            .WithSummary("Notifications to show now (startsAt <= now < stopsAt), oldest start first.");

        return notifications;
    }

    /// <summary>Adds <c>/notifications</c> CRUD to the admin group (which already requires the Admin policy).</summary>
    public static RouteGroupBuilder MapAdminNotificationEndpoints(this RouteGroupBuilder admin)
    {
        var notifications = admin.MapGroup("/notifications");

        notifications.MapGet("/", ListAsync)
            .WithName("AdminListNotifications")
            .WithSummary("Every notification (past, current and future), newest start first.");

        notifications.MapGet("/{id:guid}", GetAsync)
            .WithName("AdminGetNotification")
            .WithSummary("One notification.")
            .ProducesProblem(StatusCodes.Status404NotFound);

        notifications.MapPost("/", CreateAsync)
            .WithName("AdminCreateNotification")
            .WithSummary("Create a notification (409 when the dismiss key is taken).")
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status409Conflict);

        notifications.MapPut("/{id:guid}", UpdateAsync)
            .WithName("AdminUpdateNotification")
            .WithSummary("Replace a notification's fields.")
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        notifications.MapDelete("/{id:guid}", DeleteAsync)
            .WithName("AdminDeleteNotification")
            .WithSummary("Delete a notification.")
            .ProducesProblem(StatusCodes.Status404NotFound);

        return notifications;
    }

    internal static async Task<Ok<List<NotificationInfo>>> ListActiveAsync(NotificationService service, CancellationToken ct) =>
        TypedResults.Ok(await service.ListActiveAsync(ct));

    internal static async Task<Ok<List<NotificationInfo>>> ListAsync(NotificationService service, CancellationToken ct) =>
        TypedResults.Ok(await service.ListAsync(ct));

    internal static async Task<Results<Ok<NotificationInfo>, ProblemHttpResult>> GetAsync(
        Guid id, NotificationService service, CancellationToken ct) =>
        await service.GetAsync(id, ct) is { } found ? TypedResults.Ok(found) : NotFound();

    internal static async Task<Results<Created<NotificationInfo>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        NotificationInput input, NotificationService service, CancellationToken ct) =>
        await service.CreateAsync(input, ct) switch
        {
            ServiceOutcome<NotificationInfo>.Ok ok => TypedResults.Created($"/api/admin/notifications/{ok.Value.Id}", ok.Value),
            ServiceOutcome<NotificationInfo>.Invalid invalid => TypedResults.ValidationProblem(invalid.Errors),
            var other => other.ToProblem(),
        };

    internal static async Task<Results<Ok<NotificationInfo>, ValidationProblem, ProblemHttpResult>> UpdateAsync(
        Guid id, NotificationInput input, NotificationService service, CancellationToken ct) =>
        await service.UpdateAsync(id, input, ct) switch
        {
            ServiceOutcome<NotificationInfo>.Ok ok => TypedResults.Ok(ok.Value),
            ServiceOutcome<NotificationInfo>.Invalid invalid => TypedResults.ValidationProblem(invalid.Errors),
            var other => other.ToProblem(),
        };

    internal static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(
        Guid id, NotificationService service, CancellationToken ct) =>
        await service.DeleteAsync(id, ct) ? TypedResults.NoContent() : NotFound();

    private static ProblemHttpResult NotFound() =>
        TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: NotificationService.NotFoundTitle);
}
