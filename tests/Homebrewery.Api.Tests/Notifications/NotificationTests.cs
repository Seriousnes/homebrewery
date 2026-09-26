using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Notifications;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Notifications;

/// <summary>P2.7 notifications: the public active list and the admin CRUD under <c>/api/admin/notifications</c>.</summary>
[Collection(ApiCollection.Name)]
public sealed class NotificationTests(ApiFixture api, NotificationTests.Admin admin) : IClassFixture<NotificationTests.Admin>
{
    [Fact]
    public async Task Only_notifications_running_now_are_active()
    {
        var ct = TestContext.Current.CancellationToken;
        var now = DateTimeOffset.UtcNow;
        var current = await CreateAsync(now.AddHours(-1), now.AddHours(1), ct);
        var later = await CreateAsync(now.AddHours(1), now.AddHours(2), ct);
        var over = await CreateAsync(now.AddHours(-2), now.AddMinutes(-1), ct);
        var alsoCurrent = await CreateAsync(now.AddMinutes(-5), now.AddDays(1), ct);
        using var anonymous = api.Factory.CreateClient();

        var active = await anonymous.GetFromJsonAsync<List<NotificationInfo>>("/api/notifications/active", TestJson.Options, ct);

        var keys = active!.Select(n => n.DismissKey).ToList();
        Assert.Contains(current.DismissKey, keys);
        Assert.Contains(alsoCurrent.DismissKey, keys);
        Assert.DoesNotContain(later.DismissKey, keys);
        Assert.DoesNotContain(over.DismissKey, keys);
        Assert.True(keys.IndexOf(current.DismissKey) < keys.IndexOf(alsoCurrent.DismissKey));   // oldest start first
        Assert.Equal(current, active!.Single(n => n.DismissKey == current.DismissKey));
    }

    [Fact]
    public async Task Admins_create_read_update_and_delete()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = await admin.ClientAsync(ct);
        var key = "maintenance-" + TestBrews.Token();
        var startsAt = new DateTimeOffset(2030, 1, 1, 12, 0, 0, TimeSpan.FromHours(2));

        using var create = await client.PostAsJsonAsync("/api/admin/notifications",
            new { dismissKey = $"  {key}  ", title = " Maintenance ", body = "Down \u0000for an hour.", startsAt, stopsAt = startsAt.AddHours(1) }, ct);
        await BrewApi.EnsureStatusAsync(create, HttpStatusCode.Created, ct);
        var created = await TestJson.ReadAsync<NotificationInfo>(create, ct);

        Assert.Equal($"/api/admin/notifications/{created.Id}", create.Headers.Location?.OriginalString);
        Assert.Equal(key, created.DismissKey);                                              // trimmed
        Assert.Equal("Maintenance", created.Title);
        Assert.Equal("Down for an hour.", created.Body);                                    // NUL removed, not a 500
        Assert.Equal(startsAt, created.StartsAt);
        Assert.Equal(TimeSpan.Zero, created.StartsAt.Offset);                               // stored as UTC

        var fetched = await client.GetFromJsonAsync<NotificationInfo>($"/api/admin/notifications/{created.Id}", TestJson.Options, ct);
        var all = await client.GetFromJsonAsync<List<NotificationInfo>>("/api/admin/notifications", TestJson.Options, ct);
        Assert.Equal(created, fetched);
        Assert.Contains(created, all!);

        using var update = await client.PutAsJsonAsync($"/api/admin/notifications/{created.Id}",
            new { dismissKey = key, title = "Maintenance moved", body = "", startsAt, stopsAt = startsAt.AddHours(3) }, ct);
        await BrewApi.EnsureStatusAsync(update, HttpStatusCode.OK, ct);
        var updated = await TestJson.ReadAsync<NotificationInfo>(update, ct);
        Assert.Equal("Maintenance moved", updated.Title);
        Assert.Equal(startsAt.AddHours(3), updated.StopsAt);
        Assert.Equal(created.CreatedAt, updated.CreatedAt);

        using var delete = await client.DeleteAsync($"/api/admin/notifications/{created.Id}", ct);
        using var again = await client.DeleteAsync($"/api/admin/notifications/{created.Id}", ct);
        using var gone = await client.GetAsync($"/api/admin/notifications/{created.Id}", ct);
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        Assert.Equal("application/problem+json", gone.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Invalid_notifications_are_400_with_field_errors()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = await admin.ClientAsync(ct);
        var now = DateTimeOffset.UtcNow;

        using var empty = await client.PostAsJsonAsync("/api/admin/notifications", new { }, ct);
        using var backwards = await client.PostAsJsonAsync("/api/admin/notifications",
            new { dismissKey = TestBrews.Token(), title = "t", startsAt = now, stopsAt = now.AddMinutes(-1) }, ct);
        using var tooLong = await client.PostAsJsonAsync("/api/admin/notifications", new
        {
            dismissKey = new string('k', NotificationService.MaxDismissKey + 1),
            title = new string('t', NotificationService.MaxTitle + 1),
            body = new string('b', NotificationService.MaxBody + 1),
            stopsAt = now.AddDays(1),
        }, ct);

        Assert.Equal(["dismissKey", "stopsAt", "title"], await ErrorKeysAsync(empty, ct));
        Assert.Equal(["stopsAt"], await ErrorKeysAsync(backwards, ct));
        Assert.Equal(["body", "dismissKey", "title"], await ErrorKeysAsync(tooLong, ct));
    }

    [Fact]
    public async Task Dismiss_keys_are_unique()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = await admin.ClientAsync(ct);
        var first = await CreateAsync(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(1), ct);
        var second = await CreateAsync(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(1), ct);
        var body = new { dismissKey = first.DismissKey, title = "dup", stopsAt = DateTimeOffset.UtcNow.AddDays(1) };

        using var create = await client.PostAsJsonAsync("/api/admin/notifications", body, ct);
        using var update = await client.PutAsJsonAsync($"/api/admin/notifications/{second.Id}", body, ct);

        Assert.Equal(HttpStatusCode.Conflict, create.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, update.StatusCode);
        Assert.Equal("application/problem+json", update.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Updating_an_unknown_notification_is_404()
    {
        var ct = TestContext.Current.CancellationToken;
        var client = await admin.ClientAsync(ct);

        using var response = await client.PutAsJsonAsync($"/api/admin/notifications/{Guid.NewGuid()}",
            new { dismissKey = TestBrews.Token(), title = "t", stopsAt = DateTimeOffset.UtcNow.AddDays(1) }, ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task The_admin_crud_is_for_admins_only()
    {
        var ct = TestContext.Current.CancellationToken;
        using var user = await api.Factory.CreateUserAsync(ct: ct);
        using var anonymous = api.Factory.CreateClient();
        var body = new { dismissKey = TestBrews.Token(), title = "t", stopsAt = DateTimeOffset.UtcNow.AddDays(1) };

        using var list = await user.Client.GetAsync("/api/admin/notifications", ct);
        using var create = await user.Client.PostAsJsonAsync("/api/admin/notifications", body, ct);
        using var anonymousCreate = await anonymous.PostAsJsonAsync("/api/admin/notifications", body, ct);

        Assert.Equal(HttpStatusCode.Forbidden, list.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousCreate.StatusCode);
    }

    private async Task<NotificationInfo> CreateAsync(DateTimeOffset startsAt, DateTimeOffset stopsAt, CancellationToken ct)
    {
        var client = await admin.ClientAsync(ct);
        using var response = await client.PostAsJsonAsync("/api/admin/notifications",
            new { dismissKey = "n-" + TestBrews.Token(), title = "Notice", body = "Body", startsAt, stopsAt }, ct);
        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        return await TestJson.ReadAsync<NotificationInfo>(response, ct);
    }

    private static async Task<string[]> ErrorKeysAsync(HttpResponseMessage response, CancellationToken ct)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        return [.. problem.GetProperty("errors").EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal)];
    }

    /// <summary>One admin account for the class.</summary>
    public sealed class Admin(ApiFixture api) : IDisposable
    {
        private TestUser? _admin;

        public async Task<HttpClient> ClientAsync(CancellationToken ct) => (_admin ??= await api.Factory.CreateAdminAsync(ct)).Client;

        public void Dispose() => _admin?.Dispose();
    }
}
