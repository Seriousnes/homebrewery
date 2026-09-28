using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core.Documents;
using static Homebrewery.Api.Tests.Documents.TestDocs;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>
/// RV-15: the manifest's <c>enum</c> / <c>integer</c> / <c>min</c> / <c>max</c> attribute constraints
/// (web/src/editor/schema/manifest.ts ATTR_CONSTRAINTS), read from the real shared/schema-manifest.json and enforced by
/// DocInspector: a value outside them is dropped with a warning, like a value of the wrong JSON type.
/// </summary>
public sealed class AttributeConstraintTests
{
    private const string FirstBlock = "doc.content[0].content[0]";

    /// <summary>Every constrained attribute of the real manifest: (nodes|marks, type, attribute).</summary>
    public static TheoryData<string, string, string> ConstrainedAttributes()
    {
        var data = new TheoryData<string, string, string>();
        foreach (var (type, node) in Manifest.Nodes.OrderBy(n => n.Key, StringComparer.Ordinal))
        {
            foreach (var attr in node.Attrs.Values.Where(a => a.HasConstraints).OrderBy(a => a.Name, StringComparer.Ordinal))
            {
                data.Add("nodes", type, attr.Name);
            }
        }

        foreach (var (type, mark) in Manifest.Marks.OrderBy(m => m.Key, StringComparer.Ordinal))
        {
            foreach (var attr in mark.Attrs.Values.Where(a => a.HasConstraints).OrderBy(a => a.Name, StringComparer.Ordinal))
            {
                data.Add("marks", type, attr.Name);
            }
        }

        return data;
    }

    // ---- reading the manifest ---------------------------------------------------------------------

    [Fact]
    public void The_real_manifest_carries_the_constraints_the_client_declares()
    {
        var nodes = Manifest.Nodes;

        Assert.Equal(["1", "2", "3", "4", "5", "6"], nodes["heading"].Attrs["level"].Enum!.Select(Json));
        Assert.Equal(["1", "2", "null"], nodes["page"].Attrs["columns"].Enum!.Select(Json));
        Assert.Equal(["\"manual\"", "\"auto\""], nodes["page"].Attrs["kind"].Enum!.Select(Json));
        Assert.Equal(["1", "2", "3", "4", "5", "6"], nodes["toc"].Attrs["depth"].Enum!.Select(Json));
        Assert.Contains("null", nodes["paragraph"].Attrs["align"].Enum!.Select(Json));

        var colspan = nodes["tableCell"].Attrs["colspan"];
        Assert.True(colspan.Integer);
        Assert.Equal(1, colspan.Min);
        Assert.Null(colspan.Max);
        Assert.Null(colspan.Enum);

        var start = nodes["orderedList"].Attrs["start"];
        Assert.True(start.Integer);
        Assert.Null(start.Min);

        Assert.False(nodes["paragraph"].Attrs["classes"].HasConstraints);
        Assert.True(ConstrainedAttributes().Count >= 14, "the manifest lost constraints; update this test if that was intended");
    }

    [Fact]
    public void Every_default_keeps_its_own_constraints()
    {
        var specs = Manifest.Nodes.Values.SelectMany(n => n.Attrs.Values.Select(a => (Owner: n.Name, Attr: a)))
            .Concat(Manifest.Marks.Values.SelectMany(m => m.Attrs.Values.Select(a => (Owner: m.Name, Attr: a))))
            .Where(x => x.Attr.HasConstraints);

        foreach (var (owner, attr) in specs)
        {
            Assert.True(attr.Violation(attr.Default) is null, $"{owner}.{attr.Name}: default {Json(attr.Default)} {attr.Violation(attr.Default)}");
        }
    }

    [Theory]
    [InlineData("\"left\"", "must be a non-empty array")]
    [InlineData("[]", "must be a non-empty array")]
    [InlineData("[{\"a\":1}]", "must hold strings, numbers, booleans or null")]
    [InlineData("[[1]]", "must hold strings, numbers, booleans or null")]
    public void A_malformed_enum_fails_loading(string enumJson, string message)
    {
        var json = ManifestJson();
        json["nodes"]!["paragraph"]!["attrs"]!["align"]!["enum"] = JsonNode.Parse(enumJson);

        var error = Assert.Throws<InvalidDataException>(() => SchemaManifest.Parse(json));
        Assert.Contains($"nodes.paragraph.attrs.align.enum {message}", error.Message);
    }

    [Theory]
    [InlineData("integer", "\"yes\"", "nodes.orderedList.attrs.start.integer must be a boolean")]
    [InlineData("min", "\"1\"", "nodes.orderedList.attrs.start.min must be a number")]
    [InlineData("max", "true", "nodes.orderedList.attrs.start.max must be a number")]
    [InlineData("max", "-5", "nodes.orderedList.attrs.start.min must not be greater than")]
    public void Malformed_numeric_constraints_fail_loading(string key, string valueJson, string message)
    {
        var json = ManifestJson();
        var start = json["nodes"]!["orderedList"]!["attrs"]!["start"]!.AsObject();
        start["min"] = 0;
        start[key] = JsonNode.Parse(valueJson);

        var error = Assert.Throws<InvalidDataException>(() => SchemaManifest.Parse(json));
        Assert.Contains(message, error.Message);
    }

    // ---- enforcing them ---------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(ConstrainedAttributes))]
    public void Every_allowed_value_is_kept(string owner, string type, string attr)
    {
        var spec = Spec(owner, type, attr);
        var samples = AllowedSamples(spec).ToList();
        Assert.NotEmpty(samples);

        foreach (var value in samples)
        {
            var (doc, path) = Place(owner, type, attr, value);
            var result = Inspect(doc);

            Assert.True(result.IsValid, $"{type}.{attr} = {Json(value)}: {string.Join("; ", result.Errors.SelectMany(e => e.Value))}");
            Assert.DoesNotContain(result.Warnings, w => w.StartsWith($"{path}.attrs.{attr}:", StringComparison.Ordinal));
            var attrs = AttrsAt(result, path);
            Assert.True(attrs is not null && attrs.ContainsKey(attr), $"{type}.{attr} = {Json(value)} was dropped");
            Assert.Equal(Json(value), Json(attrs![attr]));
        }
    }

    [Theory]
    [MemberData(nameof(ConstrainedAttributes))]
    public void Values_outside_the_constraints_are_dropped_with_a_warning(string owner, string type, string attr)
    {
        var spec = Spec(owner, type, attr);
        var samples = ViolatingSamples(spec).ToList();
        Assert.NotEmpty(samples);

        foreach (var value in samples)
        {
            var violation = spec.Violation(value);
            Assert.NotNull(violation);
            var (doc, path) = Place(owner, type, attr, value);

            var result = Inspect(doc);

            Assert.True(result.IsValid, $"{type}.{attr} = {Json(value)} must be dropped, not rejected");
            Assert.Contains($"{path}.attrs.{attr}: {violation}", result.Warnings);
            var attrs = AttrsAt(result, path);
            Assert.False(attrs?.ContainsKey(attr) ?? false, $"{type}.{attr} = {Json(value)} was stored");
        }
    }

    [Theory]
    [InlineData("page", "columns", "3", "must be one of 1, 2, null")]
    [InlineData("page", "kind", "\"x\"", "must be one of \"manual\", \"auto\"")]
    [InlineData("heading", "level", "7", "must be one of 1, 2, 3, 4, 5, 6")]
    [InlineData("heading", "level", "0", "must be one of 1, 2, 3, 4, 5, 6")]
    [InlineData("toc", "depth", "9", "must be one of 1, 2, 3, 4, 5, 6")]
    [InlineData("paragraph", "align", "\"Left\"", "must be one of \"left\", \"right\", \"center\", \"justify\", null")]
    [InlineData("tableCell", "colspan", "0", "must be at least 1")]
    [InlineData("tableHeader", "rowspan", "-2", "must be at least 1")]
    [InlineData("tableCell", "rowspan", "1.5", "must be a whole number")]
    [InlineData("orderedList", "start", "2.5", "must be a whole number")]
    [InlineData("image", "width", "12.5", "must be a whole number")]
    [InlineData("image", "height", "0", "must be at least 1")]
    public void The_review_examples_are_dropped(string type, string attr, string valueJson, string reason)
    {
        var (doc, path) = Place("nodes", type, attr, JsonNode.Parse(valueJson));

        var result = Inspect(doc);

        Assert.True(result.IsValid);
        Assert.Contains($"{path}.attrs.{attr}: {reason}", result.Warnings);
        Assert.False(AttrsAt(result, path)?.ContainsKey(attr) ?? false);
    }

    [Fact]
    public void Numbers_are_compared_in_their_stored_form()
    {
        var result = Inspect(DocWith(
            Node("heading", Attrs(("level", JsonNode.Parse("2.0")), ("id", "kept")), Text("x")),
            Node("orderedList", Attrs(("start", JsonNode.Parse("-3.00"))), Node("listItem", null, P("y")))));

        Assert.True(result.IsValid);
        Assert.Empty(result.Warnings);
        var content = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]!;
        Assert.Equal("2", Json(content[0]!["attrs"]!["level"]));
        Assert.Equal("-3", Json(content[1]!["attrs"]!["start"]));
    }

    [Fact]
    public void Only_the_invalid_attribute_is_dropped()
    {
        var result = Inspect(Doc(PageWith(
            Attrs(("pid", "p1"), ("kind", "auto"), ("columns", 3), ("pageNumber", true)),
            Node("heading", Attrs(("level", 7), ("id", "intro"), ("classes", new JsonArray("wide"))), Text("x")))));

        Assert.True(result.IsValid);
        var page = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!;
        Assert.Equal(["pid", "kind", "pageNumber"], page["attrs"]!.AsObject().Select(a => a.Key));
        Assert.Equal(["id", "classes"], page["content"]![0]!["attrs"]!.AsObject().Select(a => a.Key));
        Assert.Equal(2, result.Warnings.Count);
    }

    [Fact]
    public void A_max_constraint_from_a_newer_client_is_enforced()
    {
        // No attribute of today's manifest has a max; the loader must still read and enforce one.
        var json = ManifestJson();
        var start = json["nodes"]!["orderedList"]!["attrs"]!["start"]!.AsObject();
        start["min"] = -10;
        start["max"] = 100;
        var inspector = new DocInspector(SchemaManifest.Parse(json), new RawHtmlSanitizer(clock: SteppingClock.Stopped()));

        InspectResult Run(int value)
        {
            var doc = DocWith(Node("orderedList", Attrs(("start", value)), Node("listItem", null, P("y"))));
            using var parsed = JsonDocument.Parse(doc.ToJsonString());
            return inspector.Inspect(parsed.RootElement);
        }

        Assert.Empty(Run(100).Warnings);
        Assert.Empty(Run(-10).Warnings);
        Assert.Contains($"{FirstBlock}.attrs.start: must be at most 100", Run(101).Warnings);
        Assert.Contains($"{FirstBlock}.attrs.start: must be at least -10", Run(-11).Warnings);
    }

    [Fact]
    public void An_enum_without_null_drops_null_even_when_the_type_allows_it()
    {
        var json = ManifestJson();
        json["nodes"]!["paragraph"]!["attrs"]!["align"]!["enum"] = new JsonArray("left", "right");
        var inspector = new DocInspector(SchemaManifest.Parse(json), new RawHtmlSanitizer(clock: SteppingClock.Stopped()));
        using var parsed = JsonDocument.Parse(DocWith(P(Attrs(("align", null)), Text("x"))).ToJsonString());

        var result = inspector.Inspect(parsed.RootElement);

        Assert.True(result.IsValid);
        Assert.Contains($"{FirstBlock}.attrs.align: must be one of \"left\", \"right\"", result.Warnings);
    }

    // ---- helpers ----------------------------------------------------------------------------------

    private static AttrSpec Spec(string owner, string type, string attr) =>
        owner == "nodes" ? Manifest.Nodes[type].Attrs[attr] : Manifest.Marks[type].Attrs[attr];

    /// <summary>Values the constraints allow: every enum value, else numbers at and around the bounds.</summary>
    private static IEnumerable<JsonNode?> AllowedSamples(AttrSpec spec)
    {
        if (spec.Enum is { } values)
        {
            foreach (var value in values) yield return value?.DeepClone();
            yield break;
        }

        if (spec.Type.AllowsNull) yield return null;
        if (!spec.Type.Accepts(JsonValueKind.Number)) yield break;
        var low = spec.Min ?? -3;
        var high = spec.Max ?? low + 100;
        foreach (var n in new[] { low, low + 1, high, spec.Min is null ? 0 : low + 7 }.Distinct())
        {
            if (n <= high) yield return JsonValue.Create(n);
        }

        if (!spec.Integer && low + 0.5 <= high) yield return JsonValue.Create(low + 0.5);
    }

    /// <summary>Values of the right JSON type that the constraints refuse.</summary>
    private static IEnumerable<JsonNode?> ViolatingSamples(AttrSpec spec)
    {
        var candidates = new List<JsonNode?>();
        if (spec.Enum is { } values)
        {
            var numbers = values.Where(v => v?.GetValueKind() == JsonValueKind.Number).Select(v => v!.GetValue<double>()).ToList();
            if (numbers.Count > 0) candidates.AddRange([JsonValue.Create(numbers.Max() + 1), JsonValue.Create(numbers.Min() - 1), JsonValue.Create(numbers.Min() + 0.5)]);
            var strings = values.Where(v => v?.GetValueKind() == JsonValueKind.String).Select(v => v!.GetValue<string>()).ToList();
            if (strings.Count > 0) candidates.AddRange([JsonValue.Create("x-not-allowed"), JsonValue.Create(strings[0].ToUpperInvariant())]);
            if (!values.Contains(null)) candidates.Add(null);
            if (spec.Type.Accepts(JsonValueKind.Number) && numbers.Count == 0) candidates.Add(JsonValue.Create(1));
            if (spec.Type.Accepts(JsonValueKind.String) && strings.Count == 0) candidates.Add(JsonValue.Create("x"));
        }

        if (spec.Integer) candidates.Add(JsonValue.Create((spec.Min ?? 0) + 1.5));
        if (spec.Min is { } min) candidates.Add(JsonValue.Create(min - 1));
        if (spec.Max is { } max) candidates.Add(JsonValue.Create(max + 1));

        return candidates.Where(c => spec.Type.Accepts(c?.GetValueKind() ?? JsonValueKind.Null) && spec.Violation(c) is not null);
    }

    /// <summary>A valid one-page document holding a node (or mark) of <paramref name="type"/>, and that node's path.</summary>
    private static (JsonObject Doc, string Path) Place(string owner, string type, string attr, JsonNode? value)
    {
        var attrs = Attrs((attr, value?.DeepClone()));
        if (owner == "marks")
        {
            if (type == "link") attrs["href"] ??= "https://example.com";
            return (DocWith(P(null, Text("x", Mark(type, attrs)))), $"{FirstBlock}.content[0].marks[0]");
        }

        return type switch
        {
            "page" => (Doc(PageWith(attrs, P("x"))), "doc.content[0]"),
            "paragraph" or "heading" => (DocWith(Node(type, attrs, Text("x"))), FirstBlock),
            "toc" => (DocWith(Node("toc", attrs)), FirstBlock),
            "orderedList" => (DocWith(Node("orderedList", attrs, Node("listItem", null, P("x")))), FirstBlock),
            "tableCell" or "tableHeader" => (
                DocWith(Node("table", null, Node("tableRow", null, Node(type, attrs, P("x"))))),
                $"{FirstBlock}.content[0].content[0]"),
            "image" => (DocWith(P(null, Node("image", WithSrc(attrs)))), $"{FirstBlock}.content[0]"),
            _ => throw new Xunit.Sdk.XunitException(
                $"'{type}.{attr}' has constraints but AttributeConstraintTests.Place cannot build a '{type}' node yet; add it."),
        };

        static JsonObject WithSrc(JsonObject a)
        {
            a["src"] = "https://example.com/a.png";
            return a;
        }
    }

    /// <summary>The stored attrs of the node (or mark) at <paramref name="path"/>, or null when it has none.</summary>
    private static JsonObject? AttrsAt(InspectResult result, string path)
    {
        JsonNode? node = JsonNode.Parse(result.SanitizedJson);
        foreach (var step in path.Split('.').Skip(1))
        {
            var bracket = step.IndexOf('[', StringComparison.Ordinal);
            var name = step[..bracket];
            var index = int.Parse(step[(bracket + 1)..^1], CultureInfo.InvariantCulture);
            node = node![name]![index];
        }

        return node!["attrs"] as JsonObject;
    }

    private static string Json(JsonNode? node) => node?.ToJsonString() ?? "null";

    private static JsonObject ManifestJson() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, SchemaManifest.FileName)))!.AsObject();
}
