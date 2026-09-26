using System.Net.Http.Json;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Documents;
using Homebrewery.Api.Tests.Infrastructure;

namespace Homebrewery.Api.Tests;

/// <summary>
/// The OpenAPI document web/ generates its client from: its committed copy <c>shared/openapi.json</c> must match what
/// the API serves, and <c>web/src/api/schema.d.ts</c> (openapi-typescript) must cover it.
/// </summary>
/// <remarks>
/// After changing an endpoint or a DTO, regenerate both (Git Bash / sh):
/// <code>
/// HB_UPDATE_OPENAPI=1 dotnet test --project tests/Homebrewery.Api.Tests --filter-class Homebrewery.Api.Tests.OpenApiExportTests
/// npm --prefix web run api:types
/// </code>
/// PowerShell: <c>$env:HB_UPDATE_OPENAPI=1; dotnet test ...; Remove-Item Env:HB_UPDATE_OPENAPI</c>.
/// </remarks>
[Collection(ApiCollection.Name)]
public sealed class OpenApiExportTests(ApiFixture api)
{
    public const string UpdateVariable = "HB_UPDATE_OPENAPI";

    private static readonly JsonSerializerOptions Pretty = new()
    {
        WriteIndented = true,
        IndentSize = 2,
        NewLine = "\n",
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,          // a file for people and tools, not HTML
    };

    private static string SharedPath => Path.Combine(SchemaManifestTests.RepositoryRoot(), "shared", "openapi.json");

    private static string SchemaTypesPath => Path.Combine(SchemaManifestTests.RepositoryRoot(), "web", "src", "api", "schema.d.ts");

    [Fact]
    public async Task Shared_openapi_json_is_the_current_document()
    {
        var live = await GetDocumentAsync();

        if (Environment.GetEnvironmentVariable(UpdateVariable) == "1")
        {
            await File.WriteAllTextAsync(SharedPath, live.ToJsonString(Pretty) + "\n", TestContext.Current.CancellationToken);
            return;
        }

        Assert.True(File.Exists(SharedPath), $"{SharedPath} is missing. {Regenerate}");
        var committed = JsonNode.Parse(await File.ReadAllTextAsync(SharedPath, TestContext.Current.CancellationToken));
        Assert.True(JsonNode.DeepEquals(committed, live), $"shared/openapi.json is out of date. {Regenerate}");
    }

    [Fact]
    public void Schema_types_cover_every_path_of_the_shared_document()
    {
        Assert.True(File.Exists(SchemaTypesPath), $"{SchemaTypesPath} is missing. {Regenerate}");
        var types = File.ReadAllText(SchemaTypesPath);
        var shared = JsonNode.Parse(File.ReadAllText(SharedPath))!;

        var missing = shared["paths"]!.AsObject().Select(p => p.Key)
            .Where(path => !types.Contains($"\"{path}\": {{", StringComparison.Ordinal))
            .ToList();
        var schemas = shared["components"]!["schemas"]!.AsObject().Select(s => s.Key)
            .Where(name => !types.Contains($" {name}:", StringComparison.Ordinal))
            .ToList();

        Assert.True(missing.Count == 0, $"schema.d.ts lacks paths {string.Join(", ", missing)}. {Regenerate}");
        Assert.True(schemas.Count == 0, $"schema.d.ts lacks schemas {string.Join(", ", schemas)}. {Regenerate}");
    }

    [Fact]
    public async Task Every_app_operation_is_named_tagged_and_typed()
    {
        var paths = (await GetDocumentAsync())["paths"]!.AsObject();
        var operationIds = new List<string>();

        foreach (var (path, item) in paths)
        {
            if (path.StartsWith("/api/auth/", StringComparison.Ordinal)) continue;          // MapIdentityApi's own endpoints
            foreach (var (method, operation) in item!.AsObject())
            {
                var where = $"{method.ToUpperInvariant()} {path}";
                var id = operation!["operationId"]?.GetValue<string>();
                Assert.False(string.IsNullOrEmpty(id), $"{where} has no operationId (WithName).");
                operationIds.Add(id!);
                Assert.True(operation["tags"]?.AsArray().Count > 0, $"{where} has no tag.");
                Assert.False(string.IsNullOrEmpty(operation["summary"]?.GetValue<string>()), $"{where} has no summary.");

                foreach (var (status, response) in operation["responses"]!.AsObject())
                {
                    if (status is "204" || !status.StartsWith('2')) continue;
                    var content = response!["content"]?.AsObject();
                    Assert.True(content?.Count > 0 && content.All(c => c.Value?["schema"] is not null),
                        $"{where} {status} has no typed content.");
                }
            }
        }

        Assert.Equal(operationIds.Count, operationIds.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task The_p2_7_and_p2_8_endpoints_are_documented()
    {
        var document = await GetDocumentAsync();
        var paths = document["paths"]!.AsObject();

        string OperationId(string path, string method) => paths[path]![method]!["operationId"]!.GetValue<string>();

        Assert.Equal("ListActiveNotifications", OperationId("/api/notifications/active", "get"));
        Assert.Equal("ImportFromHomebrewery", OperationId("/api/import/homebrewery/{shareId}", "get"));
        Assert.Equal("RequestLockReview", OperationId("/api/brews/{editId}/lock/review", "post"));
        Assert.Equal("AdminGetStats", OperationId("/api/admin/stats", "get"));
        Assert.Equal("AdminFindUsers", OperationId("/api/admin/users", "get"));
        Assert.Equal("AdminGetBrew", OperationId("/api/admin/brews/{id}", "get"));
        Assert.Equal("AdminLockBrew", OperationId("/api/admin/brews/{shareId}/lock", "put"));
        Assert.Equal("AdminUnlockBrew", OperationId("/api/admin/brews/{shareId}/lock", "delete"));
        Assert.Equal("AdminDismissLockReview", OperationId("/api/admin/brews/{shareId}/lock/review", "delete"));
        Assert.Equal("AdminListLocks", OperationId("/api/admin/locks", "get"));
        Assert.Equal("AdminLockReviewQueue", OperationId("/api/admin/locks/review-queue", "get"));
        Assert.Equal("AdminListNotifications", OperationId("/api/admin/notifications", "get"));
        Assert.Equal("AdminCreateNotification", OperationId("/api/admin/notifications", "post"));
        Assert.Equal("AdminGetNotification", OperationId("/api/admin/notifications/{id}", "get"));
        Assert.Equal("AdminUpdateNotification", OperationId("/api/admin/notifications/{id}", "put"));
        Assert.Equal("AdminDeleteNotification", OperationId("/api/admin/notifications/{id}", "delete"));

        var import = paths["/api/import/homebrewery/{shareId}"]!["get"]!["responses"]!.AsObject();
        Assert.Equal(["200", "400", "401", "404", "413", "429", "502"], import.Select(r => r.Key).Order(StringComparer.Ordinal));
        Assert.NotNull(import["200"]!["content"]!["text/plain"]);

        var admin = paths["/api/admin/stats"]!["get"]!["responses"]!.AsObject();
        Assert.Contains("401", admin.Select(r => r.Key));
        Assert.Contains("403", admin.Select(r => r.Key));

        Assert.False(paths.ContainsKey("/share/{shareId}"));                                  // HTML, not API
        Assert.False(paths.ContainsKey("/api/admin/ping"));
        Assert.True(document["servers"] is null || document["servers"]!.AsArray().Count == 0);
        Assert.Equal("Homebrewery API", document["info"]!["title"]!.GetValue<string>());

        var schemas = document["components"]!["schemas"]!.AsObject();
        foreach (var name in new[] { "NotificationInfo", "NotificationInput", "AdminStats", "AdminUserInfo", "AdminBrewInfo",
                     "AdminLockInfo", "LockedBrewInfo", "LockRequest", "BrewLockInfo" })
        {
            Assert.True(schemas.ContainsKey(name), $"schema {name} is missing");
        }
    }

    private const string Regenerate =
        "Regenerate with HB_UPDATE_OPENAPI=1 dotnet test --project tests/Homebrewery.Api.Tests --filter-class " +
        "Homebrewery.Api.Tests.OpenApiExportTests, then npm --prefix web run api:types.";

    /// <summary>
    /// The served document with CRLF in its strings turned into LF: descriptions from multi-line XML comments carry the
    /// source files' line endings, which depend on the checkout (Windows or Linux), and the export must not.
    /// </summary>
    private async Task<JsonNode> GetDocumentAsync()
    {
        using var client = api.Factory.CreateClient();
        var document = (await client.GetFromJsonAsync<JsonNode>(ApiDocument.Path, TestContext.Current.CancellationToken))!;
        NormalizeNewlines(document);
        return document;
    }

    private static void NormalizeNewlines(JsonNode node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (key, value) in obj.ToList())
                {
                    if (value is JsonValue v && v.TryGetValue<string>(out var s) && s.Contains('\r')) obj[key] = s.Replace("\r\n", "\n");
                    else if (value is not null) NormalizeNewlines(value);
                }

                break;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    if (array[i] is JsonValue v && v.TryGetValue<string>(out var s) && s.Contains('\r')) array[i] = s.Replace("\r\n", "\n");
                    else if (array[i] is { } item) NormalizeNewlines(item);
                }

                break;
        }
    }
}
