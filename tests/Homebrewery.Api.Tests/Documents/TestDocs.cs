using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core.Documents;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>Builders for editor documents (plan §3.3) and the real manifest/inspector.</summary>
internal static class TestDocs
{
    /// <summary>The manifest the API build copies next to the test binaries (shared/schema-manifest.json).</summary>
    public static SchemaManifest Manifest { get; } =
        SchemaManifest.Load(Path.Combine(AppContext.BaseDirectory, SchemaManifest.FileName));

    /// <summary>The inspector with a clock that stands still: no raw HTML runs out of time on a busy machine.</summary>
    public static DocInspector Inspector { get; } = new(Manifest, new RawHtmlSanitizer(clock: SteppingClock.Stopped()));

    public static InspectResult Inspect(JsonNode doc)
    {
        using var parsed = JsonDocument.Parse(doc.ToJsonString(), new JsonDocumentOptions { MaxDepth = DocInspector.MaxJsonDepth });
        return Inspector.Inspect(parsed.RootElement);
    }

    public static JsonObject Doc(params JsonNode[] pages) => new() { ["type"] = "doc", ["content"] = new JsonArray(pages) };

    public static JsonObject Page(params JsonNode[] blocks) => Node("page", null, blocks);

    public static JsonObject PageWith(JsonObject attrs, params JsonNode[] blocks) => Node("page", attrs, blocks);

    /// <summary>A one-page document holding <paramref name="blocks"/>.</summary>
    public static JsonObject DocWith(params JsonNode[] blocks) => Doc(Page(blocks));

    public static JsonObject P(string text) => Node("paragraph", null, Text(text));

    public static JsonObject P(JsonObject? attrs, params JsonNode[] inline) => Node("paragraph", attrs, inline);

    public static JsonObject H(int level, string text) => Node("heading", new JsonObject { ["level"] = level }, Text(text));

    public static JsonObject Text(string text, params JsonNode[] marks)
    {
        var node = new JsonObject { ["type"] = "text", ["text"] = text };
        if (marks.Length > 0) node["marks"] = new JsonArray(marks);
        return node;
    }

    public static JsonObject Mark(string type, JsonObject? attrs = null)
    {
        var mark = new JsonObject { ["type"] = type };
        if (attrs is not null) mark["attrs"] = attrs;
        return mark;
    }

    public static JsonObject Node(string type, JsonObject? attrs = null, params JsonNode[] content)
    {
        var node = new JsonObject { ["type"] = type };
        if (attrs is not null) node["attrs"] = attrs;
        if (content.Length > 0) node["content"] = new JsonArray(content);
        return node;
    }

    public static JsonObject Attrs(params (string Key, JsonNode? Value)[] values)
    {
        var attrs = new JsonObject();
        foreach (var (key, value) in values) attrs[key] = value;
        return attrs;
    }

    /// <summary>The stored document example from plan §3.3.</summary>
    public const string PlanExample = """
        {
          "type": "doc",
          "content": [
            {
              "type": "page",
              "attrs": {
                "pid": "k3f9a1qe", "kind": "manual", "columns": 2, "markers": [], "pageNumber": true,
                "footer": "Part 1 | The Wandering Inn",
                "objects": [
                  { "id": "o1", "kind": "image", "src": "https://example.com/inn-sketch.png", "classes": [],
                    "style": "position:absolute;bottom:0;right:-80px;height:45%" }
                ],
                "classes": [], "style": null
              },
              "content": [
                { "type": "heading", "attrs": { "level": 1, "id": "the-wandering-inn" },
                  "content": [{ "type": "text", "text": "The Wandering Inn" }] },
                { "type": "paragraph",
                  "content": [{ "type": "text", "text": "Travelers speak of an inn that is never in the same place twice." }] },
                { "type": "themeBlock", "attrs": { "classes": ["note"] },
                  "content": [
                    { "type": "heading", "attrs": { "level": 5 }, "content": [{ "type": "text", "text": "Rumors" }] },
                    { "type": "paragraph", "content": [{ "type": "text", "text": "The innkeeper never ages." }] }
                  ] },
                { "type": "paragraph",
                  "content": [{ "type": "text", "text": "The common room smells of cedar," }] }
              ]
            },
            {
              "type": "page",
              "attrs": { "pid": "p7x2qe0m", "kind": "auto", "columns": 2, "pageNumber": true,
                         "footer": "Part 1 | The Wandering Inn", "markers": [], "objects": [] },
              "content": [
                { "type": "paragraph", "attrs": { "continuation": true },
                  "content": [{ "type": "text", "text": "pipe smoke and rain that never falls outside." }] }
              ]
            }
          ]
        }
        """;
}
