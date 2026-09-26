using System.Net.Http.Json;
using System.Text.Json;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests.Themes;

/// <summary>
/// The OpenAPI document describes the theme, vault and user list endpoints well enough for web/ to generate typed calls:
/// operation ids, the sort whitelist as an enum, the style union and the mixed snippet list.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ThemeAndListOpenApiTests(ApiFixture api)
{
    [Fact]
    public async Task Operations_are_named_and_list_their_error_statuses()
    {
        var paths = (await GetDocumentAsync()).GetProperty("paths");

        Assert.Equal("ListThemes", paths.GetProperty("/api/themes").GetProperty("get").GetProperty("operationId").GetString());
        var bundle = paths.GetProperty("/api/themes/{theme}/bundle").GetProperty("get");
        Assert.Equal("GetThemeBundle", bundle.GetProperty("operationId").GetString());
        Assert.Equal(["200", "404", "422", "423"], bundle.GetProperty("responses").EnumerateObject().Select(p => p.Name).Order());

        var vault = paths.GetProperty("/api/vault").GetProperty("get");
        Assert.Equal("SearchVault", vault.GetProperty("operationId").GetString());
        Assert.Equal(["200", "400"], vault.GetProperty("responses").EnumerateObject().Select(p => p.Name).Order());
        var parameters = vault.GetProperty("parameters").EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);
        Assert.Equal(["author", "dir", "page", "pageSize", "q", "sort"], parameters.Keys.Order());
        Assert.Equal(["relevance", "updated", "created", "views", "title"],
            parameters["sort"].GetProperty("schema").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(["asc", "desc"], parameters["dir"].GetProperty("schema").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("integer", parameters["pageSize"].GetProperty("schema").GetProperty("type").GetString());

        var users = paths.GetProperty("/api/users/{handle}/brews").GetProperty("get");
        Assert.Equal("ListUserBrews", users.GetProperty("operationId").GetString());
        Assert.True(users.GetProperty("responses").TryGetProperty("404", out _));
    }

    [Fact]
    public async Task Bundle_schemas_describe_the_style_union_and_the_snippet_list()
    {
        var schemas = (await GetDocumentAsync()).GetProperty("components").GetProperty("schemas");

        var style = schemas.GetProperty("ThemeStyle");
        Assert.Equal("kind", style.GetProperty("discriminator").GetProperty("propertyName").GetString());
        var mapping = style.GetProperty("discriminator").GetProperty("mapping");
        Assert.Equal(["css", "url"], mapping.EnumerateObject().Select(p => p.Name).Order());
        foreach (var variant in mapping.EnumerateObject())
        {
            var schema = schemas.GetProperty(variant.Value.GetString()!.Split('/')[^1]);
            Assert.Contains("kind", schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()));
        }

        var snippet = schemas.GetProperty("ThemeSnippetRef");
        var oneOf = snippet.GetProperty("oneOf").EnumerateArray().ToList();
        Assert.Equal(2, oneOf.Count);
        Assert.Equal("string", oneOf[0].GetProperty("type").GetString());
        Assert.Equal("object", oneOf[1].GetProperty("type").GetString());
        Assert.Equal(["name", "snippets"], oneOf[1].GetProperty("required").EnumerateArray().Select(e => e.GetString()).Order());

        var summary = schemas.GetProperty("BrewSummary").GetProperty("required").EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Contains("shareId", summary);
        Assert.Contains("updatedAt", summary);
        Assert.Contains("items", schemas.GetProperty("VaultPage").GetProperty("required").EnumerateArray().Select(e => e.GetString()));
    }

    private async Task<JsonElement> GetDocumentAsync()
    {
        using var client = api.Factory.CreateClient();
        return await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json", TestContext.Current.CancellationToken);
    }
}
