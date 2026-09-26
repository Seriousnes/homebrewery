using Homebrewery.Api.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Query;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>Brews for list, search and theme tests: created through the API, adjusted directly in the database.</summary>
internal static class TestBrews
{
    /// <summary>A word no other brew contains, so a search for it finds only this test's brews.</summary>
    public static string Token() => $"tok{Guid.NewGuid().ToString("N")[..12]}";

    /// <summary>Creates a brew through <c>POST /api/brews</c>; the client's user is its owner.</summary>
    public static Task<BrewForEdit> CreateAsync(
        HttpClient owner, CancellationToken ct,
        string title = "A brew",
        string description = "",
        string body = "Some text.",
        bool published = true,
        string[]? tags = null,
        string? theme = null,
        string? style = null,
        object? snippets = null,
        string[]? authors = null) =>
        BrewApi.CreateAsync(owner, new
        {
            doc = BrewApi.SimpleDoc("Heading", body),
            style,
            snippets,
            meta = new { title, description, tags = tags ?? [], published, theme, authors },
        }, ct);

    /// <summary>Runs an <c>UPDATE</c> on the brew with this share id (views, timestamps, theme, ...).</summary>
    public static Task UpdateAsync(this WebApplicationFactory<Program> factory, string shareId,
        Action<UpdateSettersBuilder<Brew>> set, CancellationToken ct) =>
        factory.WithDbAsync(db => db.Brews.Where(b => b.ShareId == shareId).ExecuteUpdateAsync(set, ct));

    /// <summary>Applies a moderation lock to the brew with this share id.</summary>
    public static Task LockAsync(this WebApplicationFactory<Program> factory, string shareId, CancellationToken ct) =>
        factory.WithDbAsync(async db =>
        {
            var brew = await db.Brews.SingleAsync(b => b.ShareId == shareId, ct);
            brew.Lock = new BrewLock
            {
                Code = 455,
                EditMessage = "Please fix the art credits.",
                ShareMessage = "This brew is under review.",
                Applied = DateTimeOffset.UtcNow,
            };
            return await db.SaveChangesAsync(ct);
        });
}
