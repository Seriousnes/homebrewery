using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Admin;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Tests.Admin;

/// <summary>
/// The admin API for P7.4: stats, user and brew lookup, locks and the review queue (and the authors' review request).
/// Every admin route is 401 anonymous and 403 for signed-in non-admins.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class AdminApiTests(ApiFixture api, AdminApiTests.Accounts accounts) : IClassFixture<AdminApiTests.Accounts>
{
    private const string LockBody = """{"code":455,"editMessage":"Fix the art credits.","shareMessage":"Under review."}""";

    public static TheoryData<string, string> AdminRoutes => new()
    {
        { "GET", "/api/admin/stats" },
        { "GET", "/api/admin/users?q=someone" },
        { "GET", "/api/admin/users/someone/brews" },
        { "GET", "/api/admin/brews/abc123XYZabc" },
        { "PUT", "/api/admin/brews/abc123XYZabc/lock" },
        { "DELETE", "/api/admin/brews/abc123XYZabc/lock" },
        { "DELETE", "/api/admin/brews/abc123XYZabc/lock/review" },
        { "GET", "/api/admin/locks" },
        { "GET", "/api/admin/locks/review-queue" },
        { "GET", "/api/admin/notifications" },
        { "GET", $"/api/admin/notifications/{Guid.Empty}" },
        { "POST", "/api/admin/notifications" },
        { "PUT", $"/api/admin/notifications/{Guid.Empty}" },
        { "DELETE", $"/api/admin/notifications/{Guid.Empty}" },
    };

    [Theory]
    [MemberData(nameof(AdminRoutes))]
    public async Task Admin_routes_are_403_for_non_admins_and_401_anonymous(string method, string path)
    {
        var ct = TestContext.Current.CancellationToken;
        var user = await accounts.UserAsync(ct);
        using var anonymous = api.Factory.CreateClient();

        using var forbidden = await user.Client.SendAsync(Request(method, path), ct);
        using var unauthorized = await anonymous.SendAsync(Request(method, path), ct);

        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        Assert.Equal("application/problem+json", forbidden.Content.Headers.ContentType?.MediaType);
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
    }

    // ---- stats -----------------------------------------------------------------------------------

    [Fact]
    public async Task Stats_count_brews_published_brews_users_locks_and_reviews()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        var before = await StatsAsync(ct);

        using var author = await api.Factory.CreateUserAsync(ct: ct);
        var published = await TestBrews.CreateAsync(author.Client, ct, published: true);
        await TestBrews.CreateAsync(author.Client, ct, published: false);
        using var locked = await admin.Client.PutAsync($"/api/admin/brews/{published.ShareId}/lock", Json(LockBody), ct);
        using var review = await author.Client.PostAsync($"/api/brews/{published.EditId}/lock/review", null, ct);
        var after = await StatsAsync(ct);

        Assert.Equal(before with
        {
            Brews = before.Brews + 2,
            PublishedBrews = before.PublishedBrews + 1,
            Users = before.Users + 1,
            LockedBrews = before.LockedBrews + 1,
            PendingReviews = before.PendingReviews + 1,
        }, after);

        async Task<AdminStats> StatsAsync(CancellationToken token) =>
            (await admin.Client.GetFromJsonAsync<AdminStats>("/api/admin/stats", TestJson.Options, token))!;
    }

    // ---- users -----------------------------------------------------------------------------------

    [Fact]
    public async Task Users_are_found_by_part_of_their_handle_or_email_or_by_id()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        var token = TestBrews.Token();
        using var user = await api.Factory.CreateUserAsync($"Finder-{token}@Example.test", ct);
        await TestBrews.CreateAsync(user.Client, ct);

        var byHandle = await FindAsync(admin.Client, user.Handle[2..^2], ct);
        var byEmail = await FindAsync(admin.Client, $"{token.ToUpperInvariant()}@EXAMPLE", ct);
        var byId = await FindAsync(admin.Client, user.Id.ToString(), ct);
        var nobody = await FindAsync(admin.Client, TestBrews.Token(), ct);

        var found = Assert.Single(byHandle, u => u.Id == user.Id);
        Assert.Equal(user.Handle, found.Handle);
        Assert.Equal(user.Email, found.Email);
        Assert.Equal(1, found.BrewCount);
        Assert.Empty(found.Roles);
        Assert.Contains(byEmail, u => u.Id == user.Id);
        Assert.Equal(user.Id, Assert.Single(byId).Id);
        Assert.Empty(nobody);
    }

    [Fact]
    public async Task Exact_matches_come_first_and_roles_are_listed()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        var name = "exact" + Guid.NewGuid().ToString("N")[..8];
        using var longer = await api.Factory.CreateUserAsync($"{name}-longer@example.test", ct);
        using var exact = await api.Factory.CreateUserAsync($"{name}@example.test", ct);

        var results = await FindAsync(admin.Client, name.ToUpperInvariant(), ct);
        var admins = await FindAsync(admin.Client, admin.Handle, ct);

        Assert.Equal([exact.Handle, longer.Handle], results.Select(u => u.Handle));
        Assert.Equal([Roles.Admin], admins.Single(u => u.Id == admin.Id).Roles);
    }

    [Theory]
    [InlineData("")]
    [InlineData("q=")]
    [InlineData("q=%20%20")]
    public async Task A_missing_query_is_400(string query)
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);

        using var response = await admin.Client.GetAsync($"/api/admin/users?{query}", ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("q", out _));
    }

    [Fact]
    public async Task Admins_list_every_brew_of_a_user_including_private_locked_and_invited_ones()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        using var inviter = await api.Factory.CreateUserAsync(ct: ct);
        var published = await TestBrews.CreateAsync(owner.Client, ct, title: "Public", published: true);
        var unpublished = await TestBrews.CreateAsync(owner.Client, ct, title: "Private", published: false);
        var locked = await TestBrews.CreateAsync(owner.Client, ct, title: "Locked", published: true);
        await api.Factory.LockAsync(locked.ShareId, ct);
        var invitation = await TestBrews.CreateAsync(inviter.Client, ct, title: "Invitation", authors: [owner.Handle]);

        var all = await admin.Client.GetFromJsonAsync<UserBrewList>($"/api/admin/users/{owner.Handle.ToUpperInvariant()}/brews", TestJson.Options, ct);
        var own = await owner.Client.GetFromJsonAsync<UserBrewList>($"/api/users/{owner.Handle}/brews", TestJson.Options, ct);
        var adminAsVisitor = await admin.Client.GetFromJsonAsync<UserBrewList>($"/api/users/{owner.Handle}/brews", TestJson.Options, ct);
        using var unknown = await admin.Client.GetAsync("/api/admin/users/no-such-handle-xyz/brews", ct);

        Assert.Equal(owner.Handle, all!.Handle);
        Assert.True(all.Own);
        Assert.Equal(4, all.Total);
        Assert.Equivalent(own, all, strict: true);                                  // exactly what the user sees
        Assert.Equal(invitation.ShareId, all.Items[^1].ShareId);                     // invitations last
        Assert.Equal(AuthorRole.Invited, all.Items[^1].Role);
        Assert.All(all.Items, b => Assert.NotNull(b.EditId));
        Assert.Contains(all.Items, b => b.ShareId == unpublished.ShareId && !b.Published);
        Assert.Contains(all.Items, b => b.ShareId == locked.ShareId && b.Locked);
        Assert.Equal([published.ShareId], adminAsVisitor!.Items.Select(b => b.ShareId));  // the public list is unchanged
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("application/problem+json", unknown.Content.Headers.ContentType?.MediaType);
    }

    // ---- brew lookup -----------------------------------------------------------------------------

    [Fact]
    public async Task Brews_are_found_by_share_id_edit_id_or_internal_id()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        using var coauthor = await api.Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct, title: "Lookup me", tags: ["meta:theme"], authors: [coauthor.Handle]);
        var id = await api.Factory.WithDbAsync(db => db.Brews.Where(b => b.ShareId == brew.ShareId).Select(b => b.Id).SingleAsync(ct));

        var byShare = await admin.Client.GetFromJsonAsync<AdminBrewInfo>($"/api/admin/brews/{brew.ShareId}", TestJson.Options, ct);
        var byEdit = await admin.Client.GetFromJsonAsync<AdminBrewInfo>($"/api/admin/brews/{brew.EditId}", TestJson.Options, ct);
        var byId = await admin.Client.GetFromJsonAsync<AdminBrewInfo>($"/api/admin/brews/{id}", TestJson.Options, ct);
        using var unknown = await admin.Client.GetAsync("/api/admin/brews/noSuchBrew12", ct);

        Assert.Equivalent(byShare, byEdit, strict: true);
        Assert.Equivalent(byShare, byId, strict: true);
        Assert.Equal(id, byShare!.Id);
        Assert.Equal(brew.EditId, byShare.EditId);
        Assert.Equal("Lookup me", byShare.Title);
        Assert.Equal(["meta:theme"], byShare.Tags);
        Assert.Equal([new BrewAuthorInfo(owner.Handle, AuthorRole.Owner), new BrewAuthorInfo(coauthor.Handle, AuthorRole.Invited)],
            byShare.Authors);
        Assert.Null(byShare.Lock);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    // ---- locks -----------------------------------------------------------------------------------

    [Fact]
    public async Task A_lock_blocks_the_share_page_and_shows_in_the_editor()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct);
        using var anonymous = api.Factory.CreateClient();

        using var lockResponse = await admin.Client.PutAsync($"/api/admin/brews/{brew.ShareId}/lock", Json(LockBody), ct);
        await BrewApi.EnsureStatusAsync(lockResponse, HttpStatusCode.OK, ct);
        var locked = await TestJson.ReadAsync<AdminBrewInfo>(lockResponse, ct);
        using var share = await anonymous.GetAsync($"/api/brews/share/{brew.ShareId}", ct);
        var edit = await BrewApi.GetForEditAsync(owner.Client, brew.EditId, ct);
        var locks = await admin.Client.GetFromJsonAsync<List<LockedBrewInfo>>("/api/admin/locks", TestJson.Options, ct);
        var queue = await admin.Client.GetFromJsonAsync<List<LockedBrewInfo>>("/api/admin/locks/review-queue", TestJson.Options, ct);

        Assert.Equal(455, locked.Lock?.Code);
        Assert.Equal("Fix the art credits.", locked.Lock?.EditMessage);
        Assert.Equal("Under review.", locked.Lock?.ShareMessage);
        Assert.InRange(locked.Lock!.Applied, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(1));
        Assert.Null(locked.Lock.ReviewRequested);

        Assert.Equal(HttpStatusCode.Locked, share.StatusCode);
        var problem = await share.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("Under review.", problem.GetProperty("detail").GetString());
        Assert.Equal(455, problem.GetProperty("code").GetInt32());

        Assert.Equal(new BrewLockInfo(455, "Fix the art credits.", locked.Lock.Applied, null), edit.Lock);
        Assert.Equal(brew.Version, edit.Version);                                          // a lock is not an edit
        Assert.Equal(brew.UpdatedAt, edit.UpdatedAt);

        var listed = Assert.Single(locks!, l => l.ShareId == brew.ShareId);
        Assert.Equal(brew.EditId, listed.EditId);
        Assert.Equal([owner.Handle], listed.Authors);
        Assert.Equal(locked.Lock, listed.Lock);
        Assert.DoesNotContain(queue!, l => l.ShareId == brew.ShareId);
    }

    [Fact]
    public async Task Authors_request_a_review_and_admins_work_the_queue()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        using var invited = await api.Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct, authors: [invited.Handle]);
        using var _ = await admin.Client.PutAsync($"/api/admin/brews/{brew.ShareId}/lock", Json(LockBody), ct);

        using var first = await invited.Client.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        await BrewApi.EnsureStatusAsync(first, HttpStatusCode.OK, ct);
        var requested = await TestJson.ReadAsync<BrewLockInfo>(first, ct);
        using var second = await owner.Client.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        var again = await TestJson.ReadAsync<BrewLockInfo>(second, ct);
        var queue = await admin.Client.GetFromJsonAsync<List<LockedBrewInfo>>("/api/admin/locks/review-queue", TestJson.Options, ct);
        var edit = await BrewApi.GetForEditAsync(owner.Client, brew.EditId, ct);

        Assert.NotNull(requested.ReviewRequested);
        Assert.Equal(requested, again);                                                    // the first request time stays
        Assert.Equal(requested.ReviewRequested, Assert.Single(queue!, l => l.ShareId == brew.ShareId).Lock.ReviewRequested);
        Assert.Equal(requested.ReviewRequested, edit.Lock?.ReviewRequested);

        using var dismiss = await admin.Client.DeleteAsync($"/api/admin/brews/{brew.ShareId}/lock/review", ct);
        await BrewApi.EnsureStatusAsync(dismiss, HttpStatusCode.OK, ct);
        var dismissed = await TestJson.ReadAsync<AdminBrewInfo>(dismiss, ct);
        var queueAfter = await admin.Client.GetFromJsonAsync<List<LockedBrewInfo>>("/api/admin/locks/review-queue", TestJson.Options, ct);
        Assert.NotNull(dismissed.Lock);                                                    // still locked
        Assert.Null(dismissed.Lock.ReviewRequested);
        Assert.DoesNotContain(queueAfter!, l => l.ShareId == brew.ShareId);

        using var unlock = await admin.Client.DeleteAsync($"/api/admin/brews/{brew.ShareId}/lock", ct);
        await BrewApi.EnsureStatusAsync(unlock, HttpStatusCode.OK, ct);
        using var anonymous = api.Factory.CreateClient();
        using var share = await anonymous.GetAsync($"/api/brews/share/{brew.ShareId}", ct);
        using var reviewUnlocked = await owner.Client.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        using var dismissUnlocked = await admin.Client.DeleteAsync($"/api/admin/brews/{brew.ShareId}/lock/review", ct);
        using var unlockAgain = await admin.Client.DeleteAsync($"/api/admin/brews/{brew.ShareId}/lock", ct);

        Assert.Null((await TestJson.ReadAsync<AdminBrewInfo>(unlock, ct)).Lock);
        Assert.Equal(HttpStatusCode.OK, share.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, reviewUnlocked.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, dismissUnlocked.StatusCode);
        Assert.Equal(HttpStatusCode.OK, unlockAgain.StatusCode);                          // idempotent
    }

    [Fact]
    public async Task Relocking_replaces_the_lock_and_clears_the_review_request()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct);
        using var first = await admin.Client.PutAsync($"/api/admin/brews/{brew.ShareId}/lock", Json(LockBody), ct);
        using var review = await owner.Client.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        await BrewApi.EnsureStatusAsync(review, HttpStatusCode.OK, ct);

        using var second = await admin.Client.PutAsJsonAsync($"/api/admin/brews/{brew.ShareId}/lock",
            new { code = 500, editMessage = "  Second <b>\"edit\"</b>  ", shareMessage = "Second share" }, ct);
        var relocked = await TestJson.ReadAsync<AdminBrewInfo>(second, ct);

        Assert.Equal(new AdminLockInfo(500, "Second <b>\"edit\"</b>", "Second share", relocked.Lock!.Applied, null), relocked.Lock);
    }

    [Fact]
    public async Task Review_requests_are_for_the_brews_authors()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        var stranger = await accounts.UserAsync(ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct);
        using var _ = await admin.Client.PutAsync($"/api/admin/brews/{brew.ShareId}/lock", Json(LockBody), ct);
        using var anonymous = api.Factory.CreateClient();

        using var byStranger = await stranger.Client.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        using var byAdmin = await admin.Client.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        using var byAnonymous = await anonymous.PostAsync($"/api/brews/{brew.EditId}/lock/review", null, ct);
        using var unknown = await owner.Client.PostAsync("/api/brews/noSuchEdit12/lock/review", null, ct);

        Assert.Equal(HttpStatusCode.Forbidden, byStranger.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, byAdmin.StatusCode);                        // admins dismiss, not request
        Assert.Equal(HttpStatusCode.Unauthorized, byAnonymous.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Null(await api.Factory.WithDbAsync(db =>
            db.Brews.Where(b => b.ShareId == brew.ShareId).Select(b => b.Lock!.ReviewRequested).SingleAsync(ct)));
    }

    [Theory]
    [InlineData("""{"code":99,"editMessage":"e","shareMessage":"s"}""", "code")]
    [InlineData("""{"code":1000,"editMessage":"e","shareMessage":"s"}""", "code")]
    [InlineData("""{"editMessage":"e","shareMessage":"s"}""", "code")]
    [InlineData("""{"code":455,"editMessage":"  ","shareMessage":"s"}""", "editMessage")]
    [InlineData("""{"code":455,"editMessage":"e"}""", "shareMessage")]
    public async Task Invalid_locks_are_400(string body, string field)
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);
        using var owner = await api.Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct);

        using var response = await admin.Client.PutAsync($"/api/admin/brews/{brew.ShareId}/lock", Json(body), ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal([field], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
        Assert.Null((await BrewApi.GetForEditAsync(owner.Client, brew.EditId, ct)).Lock);
    }

    [Fact]
    public async Task Locking_an_unknown_brew_is_404()
    {
        var ct = TestContext.Current.CancellationToken;
        var admin = await accounts.AdminAsync(ct);

        using var lockUnknown = await admin.Client.PutAsync("/api/admin/brews/noSuchBrew12/lock", Json(LockBody), ct);
        using var unlockUnknown = await admin.Client.DeleteAsync("/api/admin/brews/noSuchBrew12/lock", ct);
        using var dismissUnknown = await admin.Client.DeleteAsync("/api/admin/brews/noSuchBrew12/lock/review", ct);

        Assert.Equal(HttpStatusCode.NotFound, lockUnknown.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, unlockUnknown.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, dismissUnknown.StatusCode);
    }

    private static async Task<List<AdminUserInfo>> FindAsync(HttpClient admin, string q, CancellationToken ct) =>
        (await admin.GetFromJsonAsync<List<AdminUserInfo>>($"/api/admin/users?q={Uri.EscapeDataString(q)}", TestJson.Options, ct))!;

    private static StringContent Json(string json) => new(json, System.Text.Encoding.UTF8, "application/json");

    private static HttpRequestMessage Request(string method, string path) => new(new HttpMethod(method), path)
    {
        Content = method is "GET" or "DELETE" ? null : Json(LockBody),
    };

    /// <summary>An admin and a regular user for the class.</summary>
    public sealed class Accounts(ApiFixture api) : IDisposable
    {
        private TestUser? _admin;
        private TestUser? _user;

        public async Task<TestUser> AdminAsync(CancellationToken ct) => _admin ??= await api.Factory.CreateAdminAsync(ct);

        public async Task<TestUser> UserAsync(CancellationToken ct) => _user ??= await api.Factory.CreateUserAsync(ct: ct);

        public void Dispose()
        {
            _admin?.Dispose();
            _user?.Dispose();
        }
    }
}
