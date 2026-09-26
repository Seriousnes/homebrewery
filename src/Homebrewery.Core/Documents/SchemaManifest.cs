using System.Collections.Frozen;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Homebrewery.Core.Documents;

/// <summary>
/// The editor schema as the client describes it in <c>shared/schema-manifest.json</c> (plan §3.7).
/// The web build writes the file from the TipTap schema (<c>npm --prefix web run schema</c>), so the
/// client schema stays the single source of truth; <see cref="DocInspector"/> validates every saved
/// document against it.
/// </summary>
/// <remarks>
/// Loading fails on anything the server would not know how to check, e.g. a manifest format version
/// other than <see cref="SupportedFormatVersion"/> or an attribute <c>kind</c> this class does not know.
/// A new kind means a new kind of risky value (a URL, HTML, CSS …), so the server must learn it before
/// it accepts documents that use it.
/// </remarks>
public sealed partial class SchemaManifest
{
    /// <summary>File name of the manifest next to the API binaries (copied there by the build).</summary>
    public const string FileName = "schema-manifest.json";

    /// <summary>The manifest format (<c>version</c>) this class reads.</summary>
    public const int SupportedFormatVersion = 1;

    private SchemaManifest(
        int docSchemaVersion,
        string topNode,
        FrozenSet<string> genericTypes,
        string safeAttributePattern,
        FrozenSet<string> reservedAttributes,
        FrozenSet<string> reservedClasses,
        FrozenSet<string> pageMarkers,
        FrozenSet<string> iconFonts,
        FrozenDictionary<string, NodeSpec> nodes,
        FrozenDictionary<string, MarkSpec> marks,
        FrozenDictionary<string, Regex> content)
    {
        DocSchemaVersion = docSchemaVersion;
        TopNode = topNode;
        GenericTypes = genericTypes;
        SafeAttributePattern = safeAttributePattern;
        ReservedAttributes = reservedAttributes;
        ReservedClasses = reservedClasses;
        PageMarkers = pageMarkers;
        IconFonts = iconFonts;
        Nodes = nodes;
        Marks = marks;
        _content = content;
    }

    /// <summary>Each node type's content expression compiled to a regex over its children's types (see <see cref="ContentMatches"/>).</summary>
    private readonly FrozenDictionary<string, Regex> _content;

    /// <summary>The document schema version (<c>brews.doc_schema_version</c>) the manifest describes.</summary>
    public int DocSchemaVersion { get; }

    /// <summary>Type of the root node (<c>doc</c>).</summary>
    public string TopNode { get; }

    /// <summary>Node types that carry the generic <c>classes</c>, <c>style</c>, <c>id</c> and <c>attributes</c>.</summary>
    public FrozenSet<string> GenericTypes { get; }

    /// <summary>The client's SAFE_ATTR pattern (JavaScript syntax) for keys of <c>attrs.attributes</c>.</summary>
    public string SafeAttributePattern { get; }

    /// <summary>Attribute names the schema renders itself; never stored in <c>attrs.attributes</c>.</summary>
    public FrozenSet<string> ReservedAttributes { get; }

    /// <summary>Classes the editor adds itself; never stored in <c>classes</c>.</summary>
    public FrozenSet<string> ReservedClasses { get; }

    public FrozenSet<string> PageMarkers { get; }

    public FrozenSet<string> IconFonts { get; }

    public FrozenDictionary<string, NodeSpec> Nodes { get; }

    public FrozenDictionary<string, MarkSpec> Marks { get; }

    /// <summary>
    /// Whether children of the types <paramref name="childTypes"/>, in this order, match the content expression of
    /// node type <paramref name="type"/> (ProseMirror's <c>NodeType.validContent</c>). A type without an expression
    /// accepts no children.
    /// </summary>
    public bool ContentMatches(string type, IEnumerable<string> childTypes)
    {
        var sequence = new StringBuilder();
        foreach (var child in childTypes) sequence.Append(child).Append(' ');
        return _content.TryGetValue(type, out var content) ? content.IsMatch(sequence.ToString()) : sequence.Length == 0;
    }

    /// <summary>Reads and checks a manifest file.</summary>
    /// <exception cref="FileNotFoundException">The file does not exist.</exception>
    /// <exception cref="InvalidDataException">The file is not a manifest this server can use.</exception>
    public static SchemaManifest Load(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException(
                $"The schema manifest was not found at '{path}'. The API build copies shared/{FileName} next to its " +
                "binaries; regenerate it with 'npm --prefix web run schema' or set Schema:ManifestPath.", path);
        }

        using var stream = File.OpenRead(path);
        try
        {
            return Parse(stream);
        }
        catch (InvalidDataException ex)
        {
            throw new InvalidDataException($"{path}: {ex.Message}", ex);
        }
    }

    /// <inheritdoc cref="Parse(JsonNode?)"/>
    public static SchemaManifest Parse(Stream json) => Parse(ParseJson(() => JsonNode.Parse(json)));

    /// <inheritdoc cref="Parse(JsonNode?)"/>
    public static SchemaManifest Parse(string json) => Parse(ParseJson(() => JsonNode.Parse(json)));

    /// <summary>Checks and converts a parsed manifest.</summary>
    /// <exception cref="InvalidDataException">The JSON is not a manifest this server can use.</exception>
    public static SchemaManifest Parse(JsonNode? json)
    {
        var root = json as JsonObject ?? throw Invalid("the manifest must be a JSON object");
        var format = ReadInt(root, "version");
        if (format != SupportedFormatVersion)
        {
            throw Invalid($"manifest format version {format} is not supported (expected {SupportedFormatVersion})");
        }

        var generic = ReadObject(root, "generic");
        var nodes = ReadObject(root, "nodes").ToFrozenDictionary(
            p => p.Key, p => ReadNode(p.Key, p.Value as JsonObject ?? throw Invalid($"nodes.{p.Key} must be an object")),
            StringComparer.Ordinal);
        var marks = ReadObject(root, "marks").ToFrozenDictionary(
            p => p.Key, p => ReadMark(p.Key, p.Value as JsonObject ?? throw Invalid($"marks.{p.Key} must be an object")),
            StringComparer.Ordinal);

        var topNode = ReadString(root, "topNode");
        if (!nodes.ContainsKey(topNode)) throw Invalid($"topNode '{topNode}' is not a node type");
        if (!nodes.ContainsKey("text")) throw Invalid("there is no 'text' node type");
        foreach (var (name, node) in nodes)
        {
            foreach (var child in node.Children)
            {
                if (!nodes.ContainsKey(child)) throw Invalid($"nodes.{name}.children names unknown node type '{child}'");
            }
        }

        var content = nodes.Where(n => n.Value.Content is not null).ToFrozenDictionary(
            n => n.Key, n => CompileContent(n.Key, n.Value.Content!, nodes), StringComparer.Ordinal);

        return new SchemaManifest(
            docSchemaVersion: ReadInt(root, "docSchemaVersion"),
            topNode: topNode,
            genericTypes: ReadStringSet(generic, "types"),
            safeAttributePattern: ReadString(generic, "safeAttributePattern"),
            reservedAttributes: ReadStringSet(generic, "reservedAttributes"),
            reservedClasses: ReadStringSet(generic, "reservedClasses"),
            pageMarkers: ReadStringSet(root, "pageMarkers"),
            iconFonts: ReadStringSet(root, "iconFonts"),
            nodes: nodes,
            marks: marks,
            content: content);
    }

    [GeneratedRegex(@"\w+|[()|*+?{},]|\S", RegexOptions.CultureInvariant)]
    private static partial Regex ContentToken();

    /// <summary>
    /// Compiles a ProseMirror content expression (<c>paragraph block*</c>, <c>(tableCell | tableHeader)*</c>, …) to a
    /// regex over the child types, each followed by a space. Names are node types or groups (<c>block</c> = every
    /// type whose <c>group</c> lists it), as in ProseMirror's <c>ContentMatch.parse</c>.
    /// </summary>
    private static Regex CompileContent(string owner, string expression, FrozenDictionary<string, NodeSpec> nodes)
    {
        var tokens = ContentToken().Matches(expression).Select(m => m.Value).ToList();
        var pos = 0;
        var pattern = Choice();
        if (pos < tokens.Count) throw Unexpected();
        return new Regex($@"\A(?:{pattern})\z", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

        string Choice()
        {
            var options = new List<string> { Sequence() };
            while (Eat("|")) options.Add(Sequence());
            return string.Join("|", options);
        }

        string Sequence()
        {
            var sequence = new StringBuilder();
            while (pos < tokens.Count && tokens[pos] is not (")" or "|")) sequence.Append(Repeat());
            return sequence.Length > 0 ? sequence.ToString() : throw Unexpected();
        }

        string Repeat()
        {
            var atom = Atom();
            while (true)
            {
                if (Eat("*")) atom = $"(?:{atom})*";
                else if (Eat("+")) atom = $"(?:{atom})+";
                else if (Eat("?")) atom = $"(?:{atom})?";
                else if (Eat("{"))
                {
                    var min = Number();
                    var max = Eat(",") ? (pos < tokens.Count && tokens[pos] != "}" ? Number() : "") : min;
                    if (!Eat("}")) throw Unexpected();
                    atom = $"(?:{atom}){{{min},{max}}}";
                }
                else return atom;
            }
        }

        string Atom()
        {
            if (Eat("("))
            {
                var inner = Choice();
                return Eat(")") ? $"(?:{inner})" : throw Unexpected();
            }

            if (pos >= tokens.Count || !(char.IsLetterOrDigit(tokens[pos][0]) || tokens[pos][0] == '_')) throw Unexpected();
            var name = tokens[pos++];
            List<string> types = nodes.ContainsKey(name)
                ? [name]
                : [.. nodes.Values.Where(n => n.Groups.Contains(name)).Select(n => n.Name).Order(StringComparer.Ordinal)];
            if (types.Count == 0) throw Invalid($"nodes.{owner}.content names unknown node type or group '{name}'");
            return $"(?:{string.Join("|", types.Select(t => Regex.Escape(t) + " "))})";
        }

        string Number()
        {
            if (pos >= tokens.Count || !int.TryParse(tokens[pos], NumberStyles.None, CultureInfo.InvariantCulture, out var n)) throw Unexpected();
            pos++;
            return n.ToString(CultureInfo.InvariantCulture);
        }

        bool Eat(string token)
        {
            if (pos >= tokens.Count || tokens[pos] != token) return false;
            pos++;
            return true;
        }

        InvalidDataException Unexpected() => Invalid($"nodes.{owner}.content '{expression}' is not a content expression this server can read");
    }

    private static JsonNode? ParseJson(Func<JsonNode?> parse)
    {
        try
        {
            return parse();
        }
        catch (JsonException ex)
        {
            throw Invalid($"the manifest is not valid JSON ({ex.Message})");
        }
    }

    private static NodeSpec ReadNode(string name, JsonObject node) => new(
        Name: name,
        Attrs: ReadAttrs($"nodes.{name}", node),
        Content: node["content"]?.GetValue<string>(),
        Inline: ReadBool(node, "inline"),
        Leaf: ReadBool(node, "leaf"),
        Textblock: ReadBool(node, "textblock"),
        Marks: node["marks"]?.GetValue<string>() ?? "",
        Children: ReadStringSet(node, "children"),
        AllowsEmpty: ReadBool(node, "allowsEmpty"))
    {
        Groups = (node["group"]?.GetValue<string>() ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToFrozenSet(StringComparer.Ordinal),
    };

    private static MarkSpec ReadMark(string name, JsonObject mark) => new(
        Name: name,
        Attrs: ReadAttrs($"marks.{name}", mark),
        Excludes: mark["excludes"]?.GetValue<string>() ?? name);

    private static FrozenDictionary<string, AttrSpec> ReadAttrs(string path, JsonObject owner)
    {
        var attrs = owner["attrs"] as JsonObject ?? throw Invalid($"{path}.attrs must be an object");
        return attrs.ToFrozenDictionary(
            p => p.Key,
            p =>
            {
                var spec = p.Value as JsonObject ?? throw Invalid($"{path}.attrs.{p.Key} must be an object");
                var kindName = spec["kind"]?.GetValue<string>();
                var kind = kindName is null ? AttributeKind.None : ParseKind(kindName)
                    ?? throw Invalid($"{path}.attrs.{p.Key} has an unknown kind '{kindName}'; DocInspector must learn it first");
                return ReadConstraints($"{path}.attrs.{p.Key}", spec,
                    new AttrSpec(p.Key, AttrType.Parse(ReadString(spec, "type")), kind, spec["default"]?.DeepClone()));
            },
            StringComparer.Ordinal);
    }

    /// <summary>
    /// The optional value constraints of an attribute (web/src/editor/schema/manifest.ts <c>AttributeConstraints</c>):
    /// <c>enum</c> (the only values the client schema keeps; strings, numbers, booleans or null), <c>integer</c>
    /// (numbers must be whole) and <c>min</c>/<c>max</c> (inclusive bounds for numbers).
    /// </summary>
    private static AttrSpec ReadConstraints(string path, JsonObject spec, AttrSpec attr)
    {
        List<JsonNode?>? allowed = null;
        if (spec.TryGetPropertyValue("enum", out var enumNode))
        {
            if (enumNode is not JsonArray values || values.Count == 0) throw Invalid($"{path}.enum must be a non-empty array");
            allowed = [];
            foreach (var value in values)
            {
                if (value is not null && (value is not JsonValue v
                    || v.GetValueKind() is not (JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)))
                {
                    throw Invalid($"{path}.enum must hold strings, numbers, booleans or null");
                }

                if (value?.GetValueKind() == JsonValueKind.Number)
                {
                    // Stored as a double, the form DocInspector compares (StoredText.ToNumber).
                    allowed.Add(AttrSpec.TryGetNumber(value, out var number)
                        ? JsonValue.Create(number)
                        : throw Invalid($"{path}.enum holds a number this server cannot read"));
                    continue;
                }

                allowed.Add(value?.DeepClone());
            }
        }

        var integer = false;
        if (spec.TryGetPropertyValue("integer", out var integerNode))
        {
            integer = integerNode is JsonValue iv && iv.TryGetValue<bool>(out var b) ? b : throw Invalid($"{path}.integer must be a boolean");
        }

        var min = ReadBound(path, spec, "min");
        var max = ReadBound(path, spec, "max");
        if (min > max) throw Invalid($"{path}.min must not be greater than {path}.max");

        return attr with { Enum = allowed, Integer = integer, Min = min, Max = max };
    }

    private static double? ReadBound(string path, JsonObject spec, string key)
    {
        if (!spec.TryGetPropertyValue(key, out var node)) return null;
        return AttrSpec.TryGetNumber(node, out var d)
            ? d
            : throw Invalid($"{path}.{key} must be a number");
    }

    private static AttributeKind? ParseKind(string kind) => kind switch
    {
        "url" => AttributeKind.Url,
        "html" => AttributeKind.Html,
        "css" => AttributeKind.Css,
        "classes" => AttributeKind.Classes,
        "attributes" => AttributeKind.Attributes,
        "pageObjects" => AttributeKind.PageObjects,
        "text" => AttributeKind.Text,
        _ => null,
    };

    private static JsonObject ReadObject(JsonObject owner, string key) =>
        owner[key] as JsonObject ?? throw Invalid($"'{key}' must be an object");

    private static string ReadString(JsonObject owner, string key) =>
        owner[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : throw Invalid($"'{key}' must be a string");

    private static int ReadInt(JsonObject owner, string key) =>
        owner[key] is JsonValue v && v.TryGetValue<int>(out var i) ? i : throw Invalid($"'{key}' must be an integer");

    private static bool ReadBool(JsonObject owner, string key) =>
        owner[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : throw Invalid($"'{key}' must be a boolean");

    private static FrozenSet<string> ReadStringSet(JsonObject owner, string key)
    {
        var array = owner[key] as JsonArray ?? throw Invalid($"'{key}' must be an array");
        return array.Select(n => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : throw Invalid($"'{key}' must hold strings"))
            .ToFrozenSet(StringComparer.Ordinal);
    }

    private static InvalidDataException Invalid(string message) => new($"Invalid schema manifest: {message}.");
}

/// <summary>A node type from the manifest.</summary>
/// <param name="Content">ProseMirror content expression, or null for leaves.</param>
/// <param name="Marks">Allowed marks: <c>_</c> = all, empty = none, else space-separated mark names.</param>
/// <param name="Children">Every node type allowed as a direct child.</param>
/// <param name="AllowsEmpty">Whether empty content is valid.</param>
public sealed record NodeSpec(
    string Name,
    FrozenDictionary<string, AttrSpec> Attrs,
    string? Content,
    bool Inline,
    bool Leaf,
    bool Textblock,
    string Marks,
    FrozenSet<string> Children,
    bool AllowsEmpty)
{
    private readonly FrozenSet<string> _marks = Marks is "_" or ""
        ? FrozenSet<string>.Empty
        : Marks.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToFrozenSet(StringComparer.Ordinal);

    /// <summary>Whether inline content of this node may carry <paramref name="mark"/>.</summary>
    public bool AllowsMark(string mark) => Marks == "_" || _marks.Contains(mark);

    /// <summary>The groups the type belongs to (manifest <c>group</c>, e.g. <c>block list</c>), named by content expressions.</summary>
    public FrozenSet<string> Groups { get; init; } = FrozenSet<string>.Empty;
}

/// <summary>A mark type from the manifest.</summary>
/// <param name="Excludes">Mark types this one cannot share a node with: <c>_</c> = all, else space-separated names.</param>
public sealed record MarkSpec(string Name, FrozenDictionary<string, AttrSpec> Attrs, string Excludes)
{
    private readonly FrozenSet<string> _excludes =
        Excludes.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToFrozenSet(StringComparer.Ordinal);

    /// <summary>Whether a mark of this type excludes one of type <paramref name="mark"/> (ProseMirror's <c>excludes</c>).</summary>
    public bool ExcludesMark(string mark) => Excludes == "_" || _excludes.Contains(mark);
}

/// <summary>An attribute of a node or mark type.</summary>
/// <param name="Default">The client's default (informational; the server drops invalid values instead of storing a default).</param>
public sealed record AttrSpec(string Name, AttrType Type, AttributeKind Kind, JsonNode? Default)
{
    /// <summary>
    /// The only values the client schema keeps (manifest <c>enum</c>: strings, numbers, booleans and null, where a
    /// C# null is JSON null), or null when any value of <see cref="Type"/> is allowed.
    /// </summary>
    public IReadOnlyList<JsonNode?>? Enum { get; init; }

    /// <summary>Numbers must be whole (manifest <c>integer</c>).</summary>
    public bool Integer { get; init; }

    /// <summary>Smallest number allowed (manifest <c>min</c>, inclusive), or null.</summary>
    public double? Min { get; init; }

    /// <summary>Largest number allowed (manifest <c>max</c>, inclusive), or null.</summary>
    public double? Max { get; init; }

    /// <summary>Whether the manifest constrains the values (<see cref="Enum"/>, <see cref="Integer"/>, <see cref="Min"/>, <see cref="Max"/>).</summary>
    public bool HasConstraints => Enum is not null || Integer || Min is not null || Max is not null;

    /// <summary>
    /// Why <paramref name="value"/> (JSON null as a C# null) breaks the manifest's constraints, or null when it keeps
    /// them. Numbers compare by value (<c>2.0</c> is <c>2</c>), strings ordinally. <see cref="Integer"/>,
    /// <see cref="Min"/> and <see cref="Max"/> apply to numbers only; <see cref="Enum"/> to every value, null included.
    /// It does not check the JSON type (<see cref="AttrType.Accepts"/>).
    /// </summary>
    public string? Violation(JsonNode? value)
    {
        if (Enum is { } allowed && !allowed.Any(a => ScalarEquals(a, value)))
        {
            return $"must be one of {string.Join(", ", allowed.Select(a => a?.ToJsonString() ?? "null"))}";
        }

        if (!TryGetNumber(value, out var number)) return null;
        if (Integer && Math.Floor(number) != number) return "must be a whole number";
        if (Min is { } min && number < min) return $"must be at least {min.ToString(CultureInfo.InvariantCulture)}";
        if (Max is { } max && number > max) return $"must be at most {max.ToString(CultureInfo.InvariantCulture)}";
        return null;
    }

    /// <summary>
    /// The finite value of a JSON number, whether the node was parsed from JSON or made in code
    /// (<c>JsonValue.Create(1)</c>, which <c>GetValue&lt;double&gt;</c> refuses); false for anything else.
    /// </summary>
    internal static bool TryGetNumber(JsonNode? node, out double value)
    {
        value = 0;
        if (node is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return false;
        if (!v.TryGetValue(out value)
            && !double.TryParse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value))
        {
            return false;
        }

        return double.IsFinite(value);
    }

    private static bool ScalarEquals(JsonNode? a, JsonNode? b)
    {
        if (a is null || b is null) return a is null && b is null;
        var kind = a.GetValueKind();
        if (kind != b.GetValueKind()) return false;
        return kind switch
        {
            JsonValueKind.Number => TryGetNumber(a, out var x) && TryGetNumber(b, out var y) && x == y,
            JsonValueKind.String => string.Equals(a.GetValue<string>(), b.GetValue<string>(), StringComparison.Ordinal),
            JsonValueKind.True or JsonValueKind.False => true,
            _ => false,                                         // objects and arrays are never enum values
        };
    }
}

/// <summary>What an attribute holds, which decides the server's checks (manifest <c>kind</c>).</summary>
public enum AttributeKind
{
    /// <summary>No kind: only the JSON type is checked.</summary>
    None,

    /// <summary>A link or image URL (<see cref="UrlPolicy"/>).</summary>
    Url,

    /// <summary>HTML, sanitized with <see cref="RawHtmlSanitizer"/>.</summary>
    Html,

    /// <summary>An inline style declaration list (<see cref="CssPolicy"/>).</summary>
    Css,

    /// <summary>Class tokens: <c>string[]</c>, or a single token for string attributes.</summary>
    Classes,

    /// <summary><c>Record&lt;string,string&gt;</c> of extra HTML attributes; keys must match SAFE_ATTR.</summary>
    Attributes,

    /// <summary>A page's positioned objects: <c>{ id, kind, classes, style, src?, text? }[]</c>.</summary>
    PageObjects,

    /// <summary>Plain text.</summary>
    Text,
}

/// <summary>
/// A manifest attribute type: JSON kinds joined by <c>|</c> (<c>string|null</c>, <c>array</c>, …), or <c>any</c>.
/// </summary>
public sealed class AttrType
{
    private readonly JsonValueKind[] _kinds;

    private AttrType(string text, JsonValueKind[] kinds, bool any)
    {
        Text = text;
        _kinds = kinds;
        IsAny = any;
    }

    public string Text { get; }

    /// <summary>True for <c>any</c> (and for type names this server does not know).</summary>
    public bool IsAny { get; }

    public bool AllowsNull => IsAny || _kinds.Contains(JsonValueKind.Null);

    public static AttrType Parse(string text)
    {
        var kinds = new List<JsonValueKind>();
        foreach (var part in text.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (part)
            {
                case "string": kinds.Add(JsonValueKind.String); break;
                case "number": kinds.Add(JsonValueKind.Number); break;
                case "boolean": kinds.Add(JsonValueKind.True); kinds.Add(JsonValueKind.False); break;
                case "null": kinds.Add(JsonValueKind.Null); break;
                case "array": kinds.Add(JsonValueKind.Array); break;
                case "object": kinds.Add(JsonValueKind.Object); break;
                default: return new AttrType(text, [], any: true);    // "any", or a type from a newer client
            }
        }

        return new AttrType(text, [.. kinds], any: kinds.Count == 0);
    }

    public bool Accepts(JsonValueKind kind) => IsAny || _kinds.Contains(kind);

    public override string ToString() => Text;
}
