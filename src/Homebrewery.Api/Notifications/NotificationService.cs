using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Core;
using Homebrewery.Core.Documents;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Notifications;

/// <summary>Site notifications: the public active list and the admin CRUD (plan §8.3).</summary>
public sealed class NotificationService(AppDbContext db, TimeProvider clock)
{
    public const int MaxDismissKey = 100;
    public const int MaxTitle = 200;
    public const int MaxBody = 10_000;
    public const string DismissKeyIndexName = "ix_notifications_dismiss_key";
    public const string NotFoundTitle = "Notification not found";

    /// <summary>Notifications shown now (<c>starts_at &lt;= now &lt; stops_at</c>), oldest start first.</summary>
    public async Task<List<NotificationInfo>> ListActiveAsync(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        return await Project(db.Notifications.AsNoTracking().Where(n => n.StartsAt <= now && n.StopsAt > now)
                .OrderBy(n => n.StartsAt).ThenBy(n => n.CreatedAt))
            .ToListAsync(ct);
    }

    /// <summary>Every notification, newest start first.</summary>
    public async Task<List<NotificationInfo>> ListAsync(CancellationToken ct) =>
        await Project(db.Notifications.AsNoTracking().OrderByDescending(n => n.StartsAt).ThenByDescending(n => n.CreatedAt))
            .ToListAsync(ct);

    public async Task<NotificationInfo?> GetAsync(Guid id, CancellationToken ct) =>
        await Project(db.Notifications.AsNoTracking().Where(n => n.Id == id)).SingleOrDefaultAsync(ct);

    public async Task<ServiceOutcome<NotificationInfo>> CreateAsync(NotificationInput input, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);
        var notification = new Notification { CreatedAt = Truncate(clock.GetUtcNow()) };
        Apply(notification, input, errors);
        if (errors.Count > 0) return new ServiceOutcome<NotificationInfo>.Invalid(errors);

        db.Notifications.Add(notification);
        return await SaveAsync(notification, ct);
    }

    public async Task<ServiceOutcome<NotificationInfo>> UpdateAsync(Guid id, NotificationInput input, CancellationToken ct)
    {
        var notification = await db.Notifications.SingleOrDefaultAsync(n => n.Id == id, ct);
        if (notification is null) return new ServiceOutcome<NotificationInfo>.NotFound(NotFoundTitle);

        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);
        Apply(notification, input, errors);
        if (errors.Count > 0) return new ServiceOutcome<NotificationInfo>.Invalid(errors);
        return await SaveAsync(notification, ct);
    }

    /// <summary>False when there was no such notification.</summary>
    public async Task<bool> DeleteAsync(Guid id, CancellationToken ct) =>
        await db.Notifications.Where(n => n.Id == id).ExecuteDeleteAsync(ct) > 0;

    private async Task<ServiceOutcome<NotificationInfo>> SaveAsync(Notification notification, CancellationToken ct)
    {
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (DbErrors.IsUniqueViolation(ex, DismissKeyIndexName))
        {
            return new ServiceOutcome<NotificationInfo>.Conflict("Dismiss key taken",
                $"Another notification uses the dismiss key '{notification.DismissKey}'.");
        }

        return new ServiceOutcome<NotificationInfo>.Ok(ToInfo(notification));
    }

    private void Apply(Notification notification, NotificationInput input, Dictionary<string, string[]> errors)
    {
        var dismissKey = StoredText.Clean(input.DismissKey ?? "").Trim();
        if (dismissKey.Length == 0) BrewRules.Add(errors, "dismissKey", "is required");
        else if (dismissKey.Length > MaxDismissKey) BrewRules.Add(errors, "dismissKey", $"must be at most {MaxDismissKey} characters");

        var title = StoredText.Clean(input.Title ?? "").Trim();
        if (title.Length == 0) BrewRules.Add(errors, "title", "is required");
        else if (title.Length > MaxTitle) BrewRules.Add(errors, "title", $"must be at most {MaxTitle} characters");

        var body = StoredText.Clean(input.Body ?? "").Trim();
        if (body.Length > MaxBody) BrewRules.Add(errors, "body", $"must be at most {MaxBody} characters");

        var startsAt = Truncate((input.StartsAt ?? clock.GetUtcNow()).ToUniversalTime());
        DateTimeOffset stopsAt = default;
        if (input.StopsAt is not { } stops) BrewRules.Add(errors, "stopsAt", "is required");
        else
        {
            stopsAt = Truncate(stops.ToUniversalTime());
            if (stopsAt <= startsAt) BrewRules.Add(errors, "stopsAt", "must be after startsAt");
        }

        notification.DismissKey = dismissKey;
        notification.Title = title;
        notification.Body = body;
        notification.StartsAt = startsAt;
        notification.StopsAt = stopsAt;
    }

    private static IQueryable<NotificationInfo> Project(IQueryable<Notification> query) =>
        query.Select(n => new NotificationInfo(n.Id, n.DismissKey, n.Title, n.Body, n.StartsAt, n.StopsAt, n.CreatedAt));

    private static NotificationInfo ToInfo(Notification n) =>
        new(n.Id, n.DismissKey, n.Title, n.Body, n.StartsAt, n.StopsAt, n.CreatedAt);

    /// <summary>PostgreSQL stores microseconds; truncating keeps responses equal to what is stored.</summary>
    private static DateTimeOffset Truncate(DateTimeOffset value) => value.AddTicks(-(value.Ticks % 10));
}
