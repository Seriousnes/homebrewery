using System.Net;
using System.Net.Http.Json;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>
/// P2.3 "Done when": owner, author, invited, other signed-in user and anonymous against every brew endpoint.
/// Every case runs against a fresh brew, so mutating calls cannot affect each other.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class BrewAuthorizationMatrixTests(BrewActors actors) : IClassFixture<BrewActors>
{
    public enum Endpoint { GetForEdit, GetForShare, Create, Save, Delete, Clone }

    public static TheoryData<Endpoint, Actor, HttpStatusCode> Matrix => new()
    {
        { Endpoint.GetForEdit, Actor.Owner, HttpStatusCode.OK },
        { Endpoint.GetForEdit, Actor.Author, HttpStatusCode.OK },
        { Endpoint.GetForEdit, Actor.Invited, HttpStatusCode.OK },
        { Endpoint.GetForEdit, Actor.Other, HttpStatusCode.Forbidden },
        { Endpoint.GetForEdit, Actor.Anonymous, HttpStatusCode.Unauthorized },

        { Endpoint.GetForShare, Actor.Owner, HttpStatusCode.OK },
        { Endpoint.GetForShare, Actor.Author, HttpStatusCode.OK },
        { Endpoint.GetForShare, Actor.Invited, HttpStatusCode.OK },
        { Endpoint.GetForShare, Actor.Other, HttpStatusCode.OK },
        { Endpoint.GetForShare, Actor.Anonymous, HttpStatusCode.OK },

        { Endpoint.Create, Actor.Owner, HttpStatusCode.Created },
        { Endpoint.Create, Actor.Author, HttpStatusCode.Created },
        { Endpoint.Create, Actor.Invited, HttpStatusCode.Created },
        { Endpoint.Create, Actor.Other, HttpStatusCode.Created },
        { Endpoint.Create, Actor.Anonymous, HttpStatusCode.Unauthorized },

        { Endpoint.Save, Actor.Owner, HttpStatusCode.OK },
        { Endpoint.Save, Actor.Author, HttpStatusCode.OK },
        { Endpoint.Save, Actor.Invited, HttpStatusCode.OK },
        { Endpoint.Save, Actor.Other, HttpStatusCode.Forbidden },
        { Endpoint.Save, Actor.Anonymous, HttpStatusCode.Unauthorized },

        { Endpoint.Delete, Actor.Owner, HttpStatusCode.OK },
        { Endpoint.Delete, Actor.Author, HttpStatusCode.OK },
        { Endpoint.Delete, Actor.Invited, HttpStatusCode.OK },
        { Endpoint.Delete, Actor.Other, HttpStatusCode.Forbidden },
        { Endpoint.Delete, Actor.Anonymous, HttpStatusCode.Unauthorized },

        { Endpoint.Clone, Actor.Owner, HttpStatusCode.Created },
        { Endpoint.Clone, Actor.Author, HttpStatusCode.Created },
        { Endpoint.Clone, Actor.Invited, HttpStatusCode.Created },
        { Endpoint.Clone, Actor.Other, HttpStatusCode.Created },
        { Endpoint.Clone, Actor.Anonymous, HttpStatusCode.Unauthorized },
    };

    [Theory]
    [MemberData(nameof(Matrix))]
    public async Task Access_matches_the_matrix(Endpoint endpoint, Actor actor, HttpStatusCode expected)
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var client = actors.ClientFor(actor);

        using var response = await CallAsync(client, endpoint, brew.EditId, brew.ShareId, brew.Version, ct);

        await BrewApi.EnsureStatusAsync(response, expected, ct);
        if (expected is HttpStatusCode.Unauthorized) Assert.Null(response.Headers.Location);       // no login redirect
        if (expected is HttpStatusCode.Forbidden)
        {
            Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        }
    }

    [Theory]
    [InlineData(Endpoint.GetForEdit)]
    [InlineData(Endpoint.GetForShare)]
    [InlineData(Endpoint.Save)]
    [InlineData(Endpoint.Delete)]
    [InlineData(Endpoint.Clone)]
    public async Task Unknown_ids_are_404_for_signed_in_users(Endpoint endpoint)
    {
        var ct = TestContext.Current.CancellationToken;

        using var response = await CallAsync(actors.Other.Client, endpoint, "noSuchEdit01", "noSuchShare1", 1, ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.NotFound, ct);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    private static Task<HttpResponseMessage> CallAsync(
        HttpClient client, Endpoint endpoint, string editId, string shareId, int version, CancellationToken ct) => endpoint switch
    {
        Endpoint.GetForEdit => client.GetAsync($"/api/brews/edit/{editId}", ct),
        Endpoint.GetForShare => client.GetAsync($"/api/brews/share/{shareId}", ct),
        Endpoint.Create => client.PostAsJsonAsync("/api/brews", new { doc = BrewApi.SimpleDoc("New") }, ct),
        Endpoint.Save => BrewApi.SaveAsync(client, editId, BrewApi.SaveBody(version), ct),
        Endpoint.Delete => client.DeleteAsync($"/api/brews/{editId}", ct),
        Endpoint.Clone => client.PostAsync($"/api/brews/{shareId}/clone", null, ct),
        _ => throw new ArgumentOutOfRangeException(nameof(endpoint)),
    };
}
