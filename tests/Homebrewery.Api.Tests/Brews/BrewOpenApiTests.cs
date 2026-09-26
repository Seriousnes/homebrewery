using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>
/// The OpenAPI document describes the brew endpoints well enough for web/ to generate its client from it:
/// operation ids, required fields, integer types, string enums and an unconstrained document type.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class BrewOpenApiTests(ApiFixture api)
{
    [Fact]
    public async Task Brew_endpoints_are_described()
    {
        var doc = await GetDocumentAsync();
        var paths = doc.GetProperty("paths");

        Assert.Equal("GetBrewForEdit", Operation(paths, "/api/brews/edit/{editId}", "get").GetProperty("operationId").GetString());
        Assert.Equal("GetBrewForShare", Operation(paths, "/api/brews/share/{shareId}", "get").GetProperty("operationId").GetString());
        Assert.Equal("CreateBrew", Operation(paths, "/api/brews", "post").GetProperty("operationId").GetString());
        Assert.Equal("SaveBrew", Operation(paths, "/api/brews/{editId}", "put").GetProperty("operationId").GetString());
        Assert.Equal("DeleteBrew", Operation(paths, "/api/brews/{editId}", "delete").GetProperty("operationId").GetString());
        Assert.Equal("CloneBrew", Operation(paths, "/api/brews/{shareId}/clone", "post").GetProperty("operationId").GetString());

        var save = Operation(paths, "/api/brews/{editId}", "put").GetProperty("responses");
        Assert.Equal(["200", "400", "401", "403", "404", "409", "413"], save.EnumerateObject().Select(p => p.Name).Order());
        Assert.Equal("#/components/schemas/SaveConflict",
            save.GetProperty("409").GetProperty("content").GetProperty("application/json").GetProperty("schema").GetProperty("$ref").GetString());
        Assert.True(Operation(paths, "/api/brews/share/{shareId}", "get").GetProperty("responses").TryGetProperty("423", out _));
    }

    [Fact]
    public async Task Brew_schemas_are_typed_for_client_generation()
    {
        var schemas = (await GetDocumentAsync()).GetProperty("components").GetProperty("schemas");

        var save = schemas.GetProperty("SaveBrewRequest");
        Assert.Equal(["baseVersion", "doc"], save.GetProperty("required").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("integer", save.GetProperty("properties").GetProperty("baseVersion").GetProperty("type").GetString());

        Assert.Equal(["owner", "author", "invited"], schemas.GetProperty("AuthorRole").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.False(schemas.GetProperty("RawJson").TryGetProperty("type", out _));           // any JSON value

        var edit = schemas.GetProperty("BrewForEdit");
        Assert.Contains("version", edit.GetProperty("required").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains("baseVersion", edit.GetProperty("properties").GetProperty("version").GetProperty("description").GetString());
    }

    private async Task<JsonElement> GetDocumentAsync()
    {
        using var client = api.Factory.CreateClient();
        return await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json", TestContext.Current.CancellationToken);
    }

    private static JsonElement Operation(JsonElement paths, string path, string method) =>
        paths.GetProperty(path).GetProperty(method);
}
