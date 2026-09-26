namespace Homebrewery.Api.Notifications;

/// <summary>A site notification (banner).</summary>
/// <param name="DismissKey">Unique key; the client remembers it when the user dismisses the notification.</param>
/// <param name="Body">Plain text (never markdown or HTML).</param>
/// <param name="StartsAt">Shown from this time (inclusive).</param>
/// <param name="StopsAt">Shown until this time (exclusive).</param>
public sealed record NotificationInfo(
    Guid Id,
    string DismissKey,
    string Title,
    string Body,
    DateTimeOffset StartsAt,
    DateTimeOffset StopsAt,
    DateTimeOffset CreatedAt);

/// <summary>Body of <c>POST /api/admin/notifications</c> and <c>PUT /api/admin/notifications/{id}</c>.</summary>
/// <param name="DismissKey">Required, unique, at most 100 characters (409 when another notification uses it).</param>
/// <param name="Title">Required, at most 200 characters.</param>
/// <param name="Body">Plain text, at most 10000 characters.</param>
/// <param name="StartsAt">Default: now.</param>
/// <param name="StopsAt">Required; after <paramref name="StartsAt"/>.</param>
public sealed record NotificationInput(
    string? DismissKey,
    string? Title,
    string? Body,
    DateTimeOffset? StartsAt,
    DateTimeOffset? StopsAt);
