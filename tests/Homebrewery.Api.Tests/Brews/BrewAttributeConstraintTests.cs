using System.Net;
using System.Text.Json.Nodes;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>
/// RV-15 end to end: a save with attribute values outside the manifest's enum/integer/min constraints succeeds, and
/// the stored document has those attributes dropped (the client falls back to their defaults).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class BrewAttributeConstraintTests(BrewActors actors) : IClassFixture<BrewActors>
{
    [Fact]
    public async Task A_save_drops_values_the_manifest_does_not_allow()
    {
        var ct = TestContext.Current.CancellationToken;
        var brew = await actors.CreateSharedBrewAsync(ct);
        var doc = JsonNode.Parse("""
            {"type":"doc","content":[{"type":"page","attrs":{"pid":"p1","kind":"sideways","columns":3},"content":[
              {"type":"heading","attrs":{"level":7,"id":"intro"},"content":[{"type":"text","text":"Intro"}]},
              {"type":"toc","attrs":{"depth":9}},
              {"type":"table","content":[{"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"colspan":0,"rowspan":2},"content":[{"type":"paragraph"}]}]}]}]}]}
            """)!;

        using var response = await BrewApi.SaveAsync(actors.Owner.Client, brew.EditId, BrewApi.SaveBody(brew.Version, doc), ct);

        await BrewApi.EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        var stored = JsonNode.Parse((await BrewApi.GetForEditAsync(actors.Owner.Client, brew.EditId, ct)).Doc.Json)!;
        var page = stored["content"]![0]!;
        Assert.Equal("""{"pid":"p1"}""", page["attrs"]!.ToJsonString());
        Assert.Equal("""{"id":"intro"}""", page["content"]![0]!["attrs"]!.ToJsonString());
        Assert.Null(page["content"]![1]!["attrs"]);
        Assert.Equal("""{"rowspan":2}""", page["content"]![2]!["content"]![0]!["content"]![0]!["attrs"]!.ToJsonString());
    }
}
