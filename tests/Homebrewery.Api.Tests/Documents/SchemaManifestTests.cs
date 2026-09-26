using System.Reflection;
using System.Text.Json.Nodes;
using Homebrewery.Core.Documents;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>P2.4: loading shared/schema-manifest.json (plan §3.7).</summary>
public sealed class SchemaManifestTests
{
    [Fact]
    public void The_build_copies_the_current_manifest_next_to_the_binaries()
    {
        var copied = Path.Combine(AppContext.BaseDirectory, SchemaManifest.FileName);
        var source = Path.Combine(RepositoryRoot(), "shared", SchemaManifest.FileName);

        Assert.True(File.Exists(copied), $"{copied} is missing; the Api project should copy shared/{SchemaManifest.FileName}.");
        Assert.Equal(File.ReadAllText(source), File.ReadAllText(copied));
    }

    [Fact]
    public void The_real_manifest_loads()
    {
        var manifest = TestDocs.Manifest;

        Assert.Equal("doc", manifest.TopNode);
        Assert.Equal(1, manifest.DocSchemaVersion);
        Assert.Contains("page", manifest.Nodes.Keys);
        Assert.Contains("rawHtml", manifest.Nodes.Keys);
        Assert.Contains("link", manifest.Marks.Keys);
        Assert.Equal(AttributeKind.Html, manifest.Nodes["rawHtml"].Attrs["html"].Kind);
        Assert.Equal(AttributeKind.Url, manifest.Marks["link"].Attrs["href"].Kind);
        Assert.Equal(AttributeKind.PageObjects, manifest.Nodes["page"].Attrs["objects"].Kind);
        Assert.True(manifest.Nodes["paragraph"].AllowsMark("bold"));
        Assert.False(manifest.Nodes["codeBlock"].AllowsMark("bold"));
        Assert.Contains("frontCover", (IEnumerable<string>)manifest.PageMarkers);
    }

    [Fact]
    public void The_safe_attribute_pattern_is_the_one_the_server_expects()
    {
        // DocInspector compiles the client's pattern in ECMAScript mode. If the client changes SAFE_ATTR,
        // re-check the server's assumptions (no on*, style, class, id or URL attributes) and update this test.
        Assert.Equal(@"^(data-[\w-]+|aria-[\w-]+|title|lang|dir|role)$", TestDocs.Manifest.SafeAttributePattern);
    }

    [Fact]
    public void Every_kind_in_the_real_manifest_is_known()
    {
        var kinds = TestDocs.Manifest.Nodes.Values.SelectMany(n => n.Attrs.Values)
            .Concat(TestDocs.Manifest.Marks.Values.SelectMany(m => m.Attrs.Values))
            .Select(a => a.Kind)
            .Distinct()
            .ToList();

        Assert.Contains(AttributeKind.Url, kinds);
        Assert.Contains(AttributeKind.Css, kinds);
        Assert.Contains(AttributeKind.Attributes, kinds);
    }

    [Fact]
    public void An_unknown_attribute_kind_fails_loading()
    {
        var json = ManifestJson();
        json["nodes"]!["paragraph"]!["attrs"]!["align"]!["kind"] = "script";

        var error = Assert.Throws<InvalidDataException>(() => SchemaManifest.Parse(json));
        Assert.Contains("unknown kind 'script'", error.Message);
    }

    [Fact]
    public void Another_format_version_fails_loading()
    {
        var json = ManifestJson();
        json["version"] = 2;

        var error = Assert.Throws<InvalidDataException>(() => SchemaManifest.Parse(json));
        Assert.Contains("format version 2", error.Message);
    }

    [Fact]
    public void Unknown_children_fail_loading()
    {
        var json = ManifestJson();
        json["nodes"]!["page"]!["children"]!.AsArray().Add("ghost");

        Assert.Throws<InvalidDataException>(() => SchemaManifest.Parse(json));
    }

    [Fact]
    public void A_missing_file_names_the_path()
    {
        var path = Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.json");

        var error = Assert.Throws<FileNotFoundException>(() => SchemaManifest.Load(path));
        Assert.Contains(path, error.Message);
    }

    [Theory]
    [InlineData("string|null", JsonValueKindSet.StringNull)]
    [InlineData("array", JsonValueKindSet.Array)]
    [InlineData("any", JsonValueKindSet.Any)]
    [InlineData("bigint", JsonValueKindSet.Any)]
    public void Attribute_types_parse(string text, JsonValueKindSet expected)
    {
        var type = AttrType.Parse(text);

        Assert.Equal(expected is JsonValueKindSet.StringNull or JsonValueKindSet.Any, type.Accepts(System.Text.Json.JsonValueKind.String));
        Assert.Equal(expected is JsonValueKindSet.StringNull or JsonValueKindSet.Any, type.AllowsNull);
        Assert.Equal(expected is JsonValueKindSet.Array or JsonValueKindSet.Any, type.Accepts(System.Text.Json.JsonValueKind.Array));
        Assert.Equal(expected is JsonValueKindSet.Any, type.IsAny);
    }

    public enum JsonValueKindSet { StringNull, Array, Any }

    private static JsonObject ManifestJson() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, SchemaManifest.FileName)))!.AsObject();

    internal static string RepositoryRoot()
    {
        // Recorded by the test project at build time (the binaries may live outside the repository).
        var recorded = typeof(SchemaManifestTests).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "RepositoryRoot")?.Value;
        if (recorded is not null && File.Exists(Path.Combine(recorded, "Directory.Packages.props"))) return recorded;

        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Directory.Packages.props"))) return dir.FullName;
        }

        throw new InvalidOperationException("Directory.Packages.props (the repository root) not found above the test binaries.");
    }
}
