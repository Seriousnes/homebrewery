using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Tests.Brews;

/// <summary>JSON options matching the API (web defaults, camelCase enum strings).</summary>
internal static class TestJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        var body = await response.Content.ReadAsStringAsync(ct);
        return JsonSerializer.Deserialize<T>(body, Options)
               ?? throw new InvalidOperationException($"Empty body ({(int)response.StatusCode}).");
    }
}

/// <summary>
/// The users of the authorization matrix, created once per test class: an owner, a co-author, an invited user, an
/// unrelated signed-in user and an anonymous client.
/// </summary>
public sealed class BrewActors(ApiFixture api) : IAsyncLifetime
{
    public TestUser Owner { get; private set; } = null!;
    public TestUser Author { get; private set; } = null!;
    public TestUser Invited { get; private set; } = null!;
    public TestUser Other { get; private set; } = null!;
    public HttpClient Anonymous { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        Owner = await api.Factory.CreateUserAsync(TestUsers.UniqueEmail("owner"));
        Author = await api.Factory.CreateUserAsync(TestUsers.UniqueEmail("author"));
        Invited = await api.Factory.CreateUserAsync(TestUsers.UniqueEmail("invited"));
        Other = await api.Factory.CreateUserAsync(TestUsers.UniqueEmail("other"));
        Anonymous = api.Factory.CreateClient();
    }

    public HttpClient ClientFor(Actor actor) => actor switch
    {
        Actor.Owner => Owner.Client,
        Actor.Author => Author.Client,
        Actor.Invited => Invited.Client,
        Actor.Other => Other.Client,
        _ => Anonymous,
    };

    /// <summary>
    /// A new brew owned by <see cref="Owner"/>, with <see cref="Author"/> as author (position 1) and
    /// <see cref="Invited"/> invited (position 2).
    /// </summary>
    public async Task<BrewForEdit> CreateSharedBrewAsync(CancellationToken ct, JsonNode? doc = null)
    {
        var created = await BrewApi.CreateAsync(Owner.Client, new
        {
            doc = doc ?? BrewApi.SimpleDoc("Shared brew"),
            meta = new { title = "Shared", authors = new[] { Author.Handle, Invited.Handle } },
        }, ct);
        await api.Factory.WithDbAsync(async db =>
        {
            var id = await db.Brews.Where(b => b.EditId == created.EditId).Select(b => b.Id).SingleAsync(ct);
            return await db.BrewAuthors.Where(a => a.BrewId == id && a.UserId == Author.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(a => a.Role, AuthorRole.Author), ct);
        });
        return await BrewApi.GetForEditAsync(Owner.Client, created.EditId, ct);
    }

    public ValueTask DisposeAsync()
    {
        Owner?.Dispose();
        Author?.Dispose();
        Invited?.Dispose();
        Other?.Dispose();
        Anonymous?.Dispose();
        return ValueTask.CompletedTask;
    }
}

public enum Actor { Owner, Author, Invited, Other, Anonymous }

/// <summary>Calls to <c>/api/brews</c> and small document builders.</summary>
internal static class BrewApi
{
    public static JsonObject SimpleDoc(string heading, string text = "Some text.") => JsonNode.Parse($$"""
        {"type":"doc","content":[{"type":"page","attrs":{"pid":"p1","kind":"manual"},"content":[
          {"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":{{JsonSerializer.Serialize(heading)}}}]},
          {"type":"paragraph","content":[{"type":"text","text":{{JsonSerializer.Serialize(text)}}}]}
        ]}]}
        """)!.AsObject();

    public static async Task<BrewForEdit> CreateAsync(HttpClient client, object body, CancellationToken ct)
    {
        using var response = await client.PostAsJsonAsync("/api/brews", body, TestJson.Options, ct);
        await EnsureStatusAsync(response, HttpStatusCode.Created, ct);
        return await TestJson.ReadAsync<BrewForEdit>(response, ct);
    }

    public static async Task<BrewForEdit> GetForEditAsync(HttpClient client, string editId, CancellationToken ct)
    {
        using var response = await client.GetAsync($"/api/brews/edit/{editId}", ct);
        await EnsureStatusAsync(response, HttpStatusCode.OK, ct);
        return await TestJson.ReadAsync<BrewForEdit>(response, ct);
    }

    public static Task<HttpResponseMessage> SaveAsync(HttpClient client, string editId, object body, CancellationToken ct) =>
        client.PutAsJsonAsync($"/api/brews/{editId}", body, TestJson.Options, ct);

    /// <summary>A save body: the brew's own doc/style/snippets at <paramref name="baseVersion"/>, plus overrides.</summary>
    public static JsonObject SaveBody(int baseVersion, JsonNode? doc = null, JsonObject? meta = null, string? style = null)
    {
        var body = new JsonObject
        {
            ["baseVersion"] = baseVersion,
            ["doc"] = doc ?? SimpleDoc("Saved heading", "Saved text."),
            ["style"] = style ?? ".page { color: red; }",
        };
        if (meta is not null) body["meta"] = meta;
        return body;
    }

    public static HttpContent Gzip(string json)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(Encoding.UTF8.GetBytes(json));
        }

        var content = new ByteArrayContent(buffer.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        content.Headers.ContentEncoding.Add("gzip");
        return content;
    }

    public static async Task EnsureStatusAsync(HttpResponseMessage response, HttpStatusCode expected, CancellationToken ct)
    {
        if (response.StatusCode == expected) return;
        var body = await response.Content.ReadAsStringAsync(ct);
        throw new Xunit.Sdk.XunitException($"Expected {(int)expected} {expected}, got {(int)response.StatusCode}: {body}");
    }
}
