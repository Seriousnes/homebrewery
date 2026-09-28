using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Homebrewery.Core.Documents;

/// <summary>
/// Validates and sanitizes a brew document (<c>brews.doc</c>) against the <see cref="SchemaManifest"/> before it
/// is stored (plan §8.5). The result is a rebuilt copy, so anything dropped never reaches the database.
/// </summary>
/// <remarks>
/// <para><b>Rejected</b> (the save fails with the listed <see cref="InspectResult.Errors"/>):</para>
/// <list type="number">
/// <item>limits: more than <see cref="MaxBytes"/> of JSON, nodes nested deeper than <see cref="MaxDepth"/>
/// (the root <c>doc</c> is level 1), more than <see cref="MaxNodes"/> nodes;</item>
/// <item>structure: a root other than the manifest's top node, a node or mark type the manifest does not
/// have, a child type its parent does not allow, children that do not match the parent's content expression
/// (a <c>listItem</c> must start with a paragraph), empty content where the parent needs content, a text node
/// without text, <c>content</c>/<c>marks</c> that are not arrays;</item>
/// <item><c>attrs.attributes</c> keys that do not match SAFE_ATTR (<c>on*</c>, <c>style</c>, <c>class</c>,
/// <c>href</c>, …);</item>
/// <item>URLs (<c>link.href</c>, <c>image.src</c>, page object <c>src</c>) that <see cref="UrlPolicy"/> does
/// not allow, e.g. <c>javascript:</c>;</item>
/// <item>style strings (node, mark and page object styles) longer than <see cref="MaxStyle"/> or matching
/// <see cref="CssPolicy.BadCss"/>;</item>
/// <item><c>rawHtml.html</c> over the <see cref="RawHtmlSanitizer"/> limits (size, tags, nesting, time; the time
/// limit is shared by all <c>rawHtml</c> nodes of the document).</item>
/// </list>
/// <para><b>Dropped</b> (listed in <see cref="InspectResult.Warnings"/>; the client falls back to the
/// attribute's default): attributes the manifest does not list for the type, values of the wrong JSON type, values
/// outside the manifest's <c>enum</c>, <c>integer</c>, <c>min</c> or <c>max</c> constraints (<see cref="AttrSpec.Violation"/>),
/// reserved names in <c>attrs.attributes</c>, non-string attribute values, invalid or reserved class tokens,
/// unknown icon fonts, malformed page objects, marks the parent does not allow, a mark equal to or excluded by an
/// earlier mark of the same node, numbers <see cref="StoredText.ToNumber"/> cannot store, link targets other than
/// <c>_blank</c>/<c>_self</c> and the <c>opener</c> link type, content on leaf nodes and unknown node keys.</para>
/// <para><b>Sanitized</b>: <c>rawHtml.html</c> (<see cref="RawHtmlSanitizer"/>); U+0000 and unpaired
/// surrogates in every string (<see cref="StoredText"/>); numbers in canonical form.</para>
/// <para><b>Collected</b>: <see cref="InspectResult.PageCount"/> (<c>doc.content.length</c>),
/// <see cref="InspectResult.PlainText"/> (at most <see cref="MaxPlainText"/> characters, one line per
/// text block, used for search) and <see cref="InspectResult.FirstHeading"/> (the fallback title).</para>
/// Thread-safe; register as a singleton.
/// </remarks>
public sealed class DocInspector
{
    public const int MaxBytes = 10 * 1024 * 1024;
    public const int MaxDepth = 64;
    public const int MaxNodes = 250_000;
    public const int MaxStyle = CssPolicy.MaxLength;

    /// <summary>Cap on <see cref="InspectResult.PlainText"/> (characters; 200 KB of ASCII).</summary>
    public const int MaxPlainText = 200 * 1024;

    /// <summary>Cap on <see cref="InspectResult.FirstHeading"/> (the brew title limit).</summary>
    public const int MaxHeading = 100;

    /// <summary>
    /// JSON nesting that parsers must allow so a document at <see cref="MaxDepth"/> can still be read: every node
    /// level is two JSON levels (the node and its <c>content</c> array), plus marks, attrs and a request wrapper.
    /// The API's JSON options use this as <c>MaxDepth</c>.
    /// </summary>
    public const int MaxJsonDepth = (2 * MaxDepth) + 32;

    /// <summary>At most this many errors are reported.</summary>
    public const int MaxErrors = 50;

    private const string TextNode = "text";
    private const string HardBreakNode = "hardBreak";
    private const string HeadingNode = "heading";
    private const string LinkMark = "link";
    private const string IconNode = "icon";
    private const int MaxClassLength = 256;

    /// <summary>ASCII whitespace, which separates class names and link types in HTML.</summary>
    private static readonly char[] HtmlWhitespace = [' ', '\t', '\n', '\f', '\r'];

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,   // stored as jsonb and served as application/json only
        MaxDepth = MaxJsonDepth,
    };

    private readonly SchemaManifest _manifest;
    private readonly RawHtmlSanitizer _rawHtml;
    private readonly Regex _safeAttribute;

    public DocInspector(SchemaManifest manifest, RawHtmlSanitizer rawHtml)
    {
        _manifest = manifest;
        _rawHtml = rawHtml;
        // The client's SAFE_ATTR (JavaScript syntax); ECMAScript mode keeps \w ASCII-only as in JavaScript.
        _safeAttribute = new Regex(manifest.SafeAttributePattern,
            RegexOptions.ECMAScript | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    }

    public SchemaManifest Manifest => _manifest;

    /// <summary>Inspects a document given as JSON text.</summary>
    public InspectResult Inspect(string json)
    {
        if (Encoding.UTF8.GetByteCount(json) > MaxBytes) return InspectResult.Fail("doc", TooLarge);
        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = MaxJsonDepth });
        }
        catch (JsonException)
        {
            return InspectResult.Fail("doc", $"must be valid JSON nested at most {MaxJsonDepth} levels deep");
        }

        using (parsed) return Inspect(parsed.RootElement);
    }

    /// <summary>Inspects a document (for example a request body property).</summary>
    public InspectResult Inspect(JsonElement doc)
    {
        if (doc.ValueKind == JsonValueKind.Undefined) return InspectResult.Fail("doc", "is required");
        if (JsonMarshal.GetRawUtf8Value(doc).Length > MaxBytes) return InspectResult.Fail("doc", TooLarge);

        var walk = new Walk(this);
        JsonObject? root;
        try
        {
            root = walk.Node(doc, "doc", depth: 1, parent: null);
        }
        catch (InvalidOperationException)
        {
            // JsonElement throws on an unpaired surrogate escape in a property name or node type; values are
            // decoded leniently (StoredText.GetString).
            return InspectResult.Fail("doc", "contains an invalid string escape");
        }

        if (walk.Errors.Count > 0 || root is null)
        {
            if (walk.Errors.Count == 0) walk.Error("doc", "is not a valid document");
            return new InspectResult(walk.ErrorsAsArrays(), walk.Warnings, "", 0, "", null, walk.NodeCount);
        }

        var buffer = new ArrayBufferWriter<byte>(64 * 1024);
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions)) root.WriteTo(writer);

        var pageCount = (root["content"] as JsonArray)?.Count ?? 0;
        return new InspectResult(
            new Dictionary<string, string[]>(), walk.Warnings, Encoding.UTF8.GetString(buffer.WrittenSpan), pageCount,
            walk.PlainText, walk.FirstHeading, walk.NodeCount);
    }

    private static string TooLarge => $"must be at most {MaxBytes / (1024 * 1024)} MB of JSON";

    /// <summary>One inspection: the output tree is built while walking, errors and text are collected.</summary>
    private sealed class Walk(DocInspector owner)
    {
        private readonly SchemaManifest _manifest = owner._manifest;
        private readonly StringBuilder _text = new();
        private StringBuilder? _heading;
        private int _errorCount;
        private bool _aborted;
        private TimeSpan _rawHtmlTime;

        public Dictionary<string, List<string>> Errors { get; } = new(StringComparer.Ordinal);
        public List<string> Warnings { get; } = [];
        public int NodeCount { get; private set; }
        public string? FirstHeading { get; private set; }
        public string PlainText => _text.ToString().TrimEnd();

        public Dictionary<string, string[]> ErrorsAsArrays() => Errors.ToDictionary(e => e.Key, e => e.Value.ToArray(), StringComparer.Ordinal);

        public void Error(string path, string message)
        {
            if (_errorCount >= MaxErrors)
            {
                _aborted = true;
                return;
            }

            _errorCount++;
            if (!Errors.TryGetValue(path, out var list)) Errors[path] = list = [];
            list.Add(message);
        }

        private void Drop(string path, string reason)
        {
            if (Warnings.Count < MaxErrors) Warnings.Add($"{path}: {reason}");
        }

        public JsonObject? Node(JsonElement node, string path, int depth, NodeSpec? parent)
        {
            if (_aborted) return null;
            if (node.ValueKind != JsonValueKind.Object)
            {
                Error(path, "must be a node object");
                return null;
            }

            if (depth > MaxDepth)
            {
                Error(path, $"is nested deeper than {MaxDepth} levels");
                _aborted = true;
                return null;
            }

            if (++NodeCount > MaxNodes)
            {
                Error("doc", $"must have at most {MaxNodes} nodes");
                _aborted = true;
                return null;
            }

            if (!node.TryGetProperty("type", out var typeElement) || typeElement.ValueKind != JsonValueKind.String)
            {
                Error($"{path}.type", "must be a string");
                return null;
            }

            var type = typeElement.GetString()!;
            if (!_manifest.Nodes.TryGetValue(type, out var spec))
            {
                Error($"{path}.type", $"unknown node type '{StoredText.Clean(Shorten(type))}'");
                return null;
            }

            if (parent is null && type != _manifest.TopNode)
            {
                Error($"{path}.type", $"the root node must be '{_manifest.TopNode}'");
                return null;
            }

            if (parent is not null && !parent.Children.Contains(type))
            {
                Error($"{path}.type", $"'{type}' is not allowed inside '{parent.Name}'");
                return null;
            }

            var result = new JsonObject { ["type"] = type };
            foreach (var property in node.EnumerateObject())
            {
                if (property.Name is not ("type" or "text" or "attrs" or "marks" or "content"))
                {
                    Drop($"{path}.{Shorten(property.Name)}", "unknown node key");
                }
            }

            if (type == TextNode) return TextNodeContent(node, path, parent, result);

            if (node.TryGetProperty("attrs", out var attrs))
            {
                var cleaned = Attrs(spec.Attrs, attrs, $"{path}.attrs", type);
                if (cleaned is { Count: > 0 }) result["attrs"] = cleaned;
            }

            if (node.TryGetProperty("marks", out var marks))
            {
                if (spec.Inline && parent is not null)
                {
                    var cleaned = Marks(marks, $"{path}.marks", parent);
                    if (cleaned is { Count: > 0 }) result["marks"] = cleaned;
                }
                else
                {
                    Drop($"{path}.marks", "only inline nodes carry marks");
                }
            }

            if (type == HardBreakNode) AppendText("\n");
            var captureHeading = type == HeadingNode && FirstHeading is null && _heading is null;
            if (captureHeading) _heading = new StringBuilder();

            Content(node, path, depth, spec, result);

            if (spec.Textblock) AppendText("\n");
            if (captureHeading)
            {
                var heading = CollapseWhitespace(_heading!.ToString());
                _heading = null;
                if (heading.Length > 0) FirstHeading = StoredText.Truncate(heading, MaxHeading);
            }

            return result;
        }

        private JsonObject? TextNodeContent(JsonElement node, string path, NodeSpec? parent, JsonObject result)
        {
            // A string of only U+0000 cleans to "", which ProseMirror rejects like any empty text node.
            if (!node.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String
                || StoredText.GetString(text) is not { Length: > 0 } clean)
            {
                Error($"{path}.text", "must be a non-empty string");
                return null;
            }

            result["text"] = clean;
            if (node.TryGetProperty("marks", out var marks) && parent is not null)
            {
                var cleaned = Marks(marks, $"{path}.marks", parent);
                if (cleaned is { Count: > 0 }) result["marks"] = cleaned;
            }

            if (node.TryGetProperty("attrs", out _)) Drop($"{path}.attrs", "text nodes have no attributes");
            AppendText(clean);
            return result;
        }

        private void Content(JsonElement node, string path, int depth, NodeSpec spec, JsonObject result)
        {
            var hasContent = node.TryGetProperty("content", out var content) && content.ValueKind != JsonValueKind.Null;
            if (hasContent && content.ValueKind != JsonValueKind.Array)
            {
                Error($"{path}.content", "must be an array");
                return;
            }

            if (spec.Leaf)
            {
                if (hasContent && content.GetArrayLength() > 0) Drop($"{path}.content", "leaf nodes have no content");
                return;
            }

            var children = new JsonArray();
            var types = new List<string>();
            if (hasContent)
            {
                var i = 0;
                foreach (var child in content.EnumerateArray())
                {
                    var cleaned = Node(child, $"{path}.content[{i++}]", depth + 1, spec);
                    if (_aborted) return;
                    if (cleaned is null) continue;
                    children.Add(cleaned);
                    types.Add((string)cleaned["type"]!);
                }
            }

            if (children.Count > 0)
            {
                result["content"] = children;
                // Order matters too: a listItem is 'paragraph block*', so it must start with a paragraph.
                if (Errors.Count == 0 && !_manifest.ContentMatches(spec.Name, types))
                {
                    Error(path, $"'{spec.Name}' content must match '{spec.Content}'");
                }
            }
            else if (!spec.AllowsEmpty && Errors.Count == 0)
            {
                Error(path, $"'{spec.Name}' must not be empty");
            }
        }

        private JsonArray? Marks(JsonElement marks, string path, NodeSpec parent)
        {
            if (marks.ValueKind == JsonValueKind.Null) return null;
            if (marks.ValueKind != JsonValueKind.Array)
            {
                Error(path, "must be an array");
                return null;
            }

            var result = new JsonArray();
            var kept = new List<(MarkSpec Spec, JsonObject Mark)>();
            var i = 0;
            foreach (var mark in marks.EnumerateArray())
            {
                var markPath = $"{path}[{i++}]";
                if (mark.ValueKind != JsonValueKind.Object
                    || !mark.TryGetProperty("type", out var typeElement)
                    || typeElement.ValueKind != JsonValueKind.String)
                {
                    Error(markPath, "must be a mark object with a string type");
                    continue;
                }

                var type = typeElement.GetString()!;
                if (!_manifest.Marks.TryGetValue(type, out var spec))
                {
                    Error($"{markPath}.type", $"unknown mark type '{StoredText.Clean(Shorten(type))}'");
                    continue;
                }

                if (!parent.AllowsMark(type))
                {
                    Drop(markPath, $"'{parent.Name}' does not allow '{type}' marks");
                    continue;
                }

                var cleaned = new JsonObject { ["type"] = type };
                if (mark.TryGetProperty("attrs", out var attrs))
                {
                    var cleanedAttrs = Attrs(spec.Attrs, attrs, $"{markPath}.attrs", type);
                    if (cleanedAttrs is { Count: > 0 }) cleaned["attrs"] = cleanedAttrs;
                }

                // ProseMirror's check() refuses a mark set with the same mark twice or two marks that exclude each
                // other (link excludes link, bold excludes bold, …); keep the first.
                if (kept.Find(k => JsonNode.DeepEquals(k.Mark, cleaned)
                                   || k.Spec.ExcludesMark(type) || spec.ExcludesMark(k.Spec.Name)) is { Spec: { } earlier })
                {
                    Drop(markPath, $"'{type}' cannot be combined with the '{earlier.Name}' mark before it");
                    continue;
                }

                kept.Add((spec, cleaned));
                result.Add(cleaned);
            }

            return result;
        }

        private JsonObject? Attrs(IReadOnlyDictionary<string, AttrSpec> specs, JsonElement attrs, string path, string ownerType)
        {
            if (attrs.ValueKind == JsonValueKind.Null) return null;
            if (attrs.ValueKind != JsonValueKind.Object)
            {
                Drop(path, "attrs must be an object");
                return null;
            }

            var result = new JsonObject();
            foreach (var property in attrs.EnumerateObject())
            {
                var attrPath = $"{path}.{Shorten(property.Name)}";
                if (!specs.TryGetValue(property.Name, out var spec))
                {
                    Drop(attrPath, "not in the schema");
                    continue;
                }

                if (!spec.Type.Accepts(property.Value.ValueKind))
                {
                    Drop(attrPath, $"expected {spec.Type}");
                    continue;
                }

                if (!Attr(spec, property.Value, attrPath, ownerType, specs, out var value)) continue;

                // The manifest's enum / integer / min / max (heading.level 7, page.columns 3, colspan 0, …), checked on
                // the stored form (numbers are canonical here, so 2.0 is 2).
                if (spec.HasConstraints && spec.Violation(value) is { } violation)
                {
                    Drop(attrPath, violation);
                    continue;
                }

                result[property.Name] = value;
            }

            return result;
        }

        /// <summary>Checks one attribute value; false when it is dropped (or rejected, which also records an error).</summary>
        private bool Attr(AttrSpec spec, JsonElement value, string path, string ownerType,
            IReadOnlyDictionary<string, AttrSpec> ownerAttrs, out JsonNode? result)
        {
            result = null;
            if (value.ValueKind == JsonValueKind.Null) return true;

            switch (spec.Kind)
            {
                case AttributeKind.Url:
                    if (value.ValueKind != JsonValueKind.String) break;
                    var url = StoredText.GetString(value);
                    var safe = ownerType == LinkMark ? UrlPolicy.IsSafeHref(url) : UrlPolicy.IsSafeSrc(url);
                    if (!safe)
                    {
                        Error(path, ownerType == LinkMark
                            ? "links must be http:, https:, mailto:, relative or #anchor URLs"
                            : "sources must be http:, https:, relative or data:image/ URLs");
                        return false;
                    }

                    result = JsonValue.Create(StoredText.Clean(url));
                    return true;

                case AttributeKind.Html:
                    if (value.ValueKind != JsonValueKind.String) break;
                    // The document's rawHtml nodes share one time limit (RawHtmlSanitizer.TimeLimit).
                    var clock = owner._rawHtml.Clock;
                    var started = clock.GetTimestamp();
                    var sanitized = owner._rawHtml.Sanitize(StoredText.GetString(value), owner._rawHtml.TimeLimit - _rawHtmlTime);
                    _rawHtmlTime += clock.GetElapsedTime(started);
                    if (sanitized.Error is { } htmlError)
                    {
                        Error(path, htmlError);
                        return false;
                    }

                    AppendText(sanitized.Text);
                    AppendText("\n");
                    result = JsonValue.Create(StoredText.Clean(sanitized.Html));
                    return true;

                case AttributeKind.Css:
                    if (value.ValueKind != JsonValueKind.String) break;
                    var style = StoredText.GetString(value);
                    if (CssPolicy.Check(style) is { } cssError)
                    {
                        Error(path, cssError);
                        return false;
                    }

                    result = JsonValue.Create(style);
                    return true;

                case AttributeKind.Classes:
                    if (value.ValueKind == JsonValueKind.Array)
                    {
                        result = Classes(value, path);
                        return true;
                    }

                    if (value.ValueKind != JsonValueKind.String) break;
                    var token = StoredText.GetString(value);
                    if (ownerType == IconNode && spec.Name == "glyph")
                    {
                        // The glyph is every class of the <i> but the font ('fa-dragon fa-2x'), joined with spaces.
                        result = JsonValue.Create(ClassList(token, path));
                        return true;
                    }

                    var validToken = token.Length == 0 || IsClassToken(token);
                    if (validToken && ownerType == IconNode && spec.Name == "font" && !_manifest.IconFonts.Contains(token))
                    {
                        Drop(path, "unknown icon font");
                        return false;
                    }

                    if (!validToken)
                    {
                        Drop(path, "not a class token");
                        return false;
                    }

                    result = JsonValue.Create(token);
                    return true;

                case AttributeKind.Attributes:
                    if (value.ValueKind != JsonValueKind.Object) break;
                    result = Attributes(value, path, ownerAttrs);
                    return result is not null;

                case AttributeKind.PageObjects:
                    if (value.ValueKind != JsonValueKind.Array) break;
                    result = PageObjects(value, path);
                    return true;

                case AttributeKind.Text:
                case AttributeKind.None:
                    if (ownerType == LinkMark && spec.Name is "target" or "rel") return LinkAttr(spec.Name, value, path, out result);
                    result = StoredText.ToNode(value);
                    if (result is null)
                    {
                        // Only numbers become null here (null values returned above): infinite, or too long for jsonb.
                        Drop(path, "not a storable number");
                        return false;
                    }

                    return true;
            }

            Drop(path, $"not a valid {spec.Kind} value");
            return false;
        }

        /// <summary>
        /// <c>link.target</c> and <c>link.rel</c>: a target other than <c>_blank</c> or <c>_self</c> is dropped (a
        /// named window would get a <c>window.opener</c>), and so is the <c>opener</c> link type, which undoes the
        /// browser's default <c>noopener</c> for <c>target="_blank"</c> (reverse tabnabbing).
        /// </summary>
        private bool LinkAttr(string name, JsonElement value, string path, out JsonNode? result)
        {
            result = null;
            if (value.ValueKind != JsonValueKind.String)
            {
                Drop(path, "must be a string");
                return false;
            }

            var text = StoredText.GetString(value);
            if (name == "target")
            {
                var target = text.Trim().ToLowerInvariant();
                if (target is not ("_blank" or "_self"))
                {
                    Drop(path, "link targets must be _blank or _self");
                    return false;
                }

                result = target;
                return true;
            }

            var types = text.Split(HtmlWhitespace, StringSplitOptions.RemoveEmptyEntries);
            var kept = types.Where(t => !t.Equals("opener", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (kept.Length < types.Length) Drop(path, "the opener link type is not allowed");
            if (kept.Length == 0) return false;
            result = string.Join(' ', kept);
            return true;
        }

        /// <summary>A space-separated class list: valid, unreserved tokens joined with single spaces.</summary>
        private string ClassList(string value, string path)
        {
            var kept = new List<string>();
            foreach (var token in value.Split(HtmlWhitespace, StringSplitOptions.RemoveEmptyEntries))
            {
                if (!IsClassToken(token)) Drop(path, "not a class token");
                else if (_manifest.ReservedClasses.Contains(token)) Drop(path, "reserved class");
                else kept.Add(token);
            }

            return string.Join(' ', kept);
        }

        private JsonArray Classes(JsonElement classes, string path)
        {
            var result = new JsonArray();
            var i = 0;
            foreach (var item in classes.EnumerateArray())
            {
                var itemPath = $"{path}[{i++}]";
                if (item.ValueKind != JsonValueKind.String || !IsClassToken(StoredText.GetString(item)))
                {
                    Drop(itemPath, "not a class token");
                    continue;
                }

                var name = StoredText.GetString(item);
                if (_manifest.ReservedClasses.Contains(name))
                {
                    Drop(itemPath, "reserved class");
                    continue;
                }

                result.Add(name);
            }

            return result;
        }

        private JsonObject? Attributes(JsonElement attributes, string path, IReadOnlyDictionary<string, AttrSpec> ownerAttrs)
        {
            var result = new JsonObject();
            var rejected = false;
            foreach (var property in attributes.EnumerateObject())
            {
                var name = property.Name;
                var attrPath = $"{path}.{Shorten(name)}";
                if (!owner.IsSafeAttributeName(name))
                {
                    Error(attrPath, "attribute names must be data-*, aria-*, title, lang, dir or role");
                    rejected = true;
                    continue;
                }

                if (_manifest.ReservedAttributes.Contains(name))
                {
                    Drop(attrPath, "reserved attribute");
                    continue;
                }

                if (ownerAttrs.ContainsKey(name))
                {
                    Drop(attrPath, "the node has its own attribute of this name");
                    continue;
                }

                if (property.Value.ValueKind != JsonValueKind.String)
                {
                    Drop(attrPath, "attribute values must be strings");
                    continue;
                }

                result[name] = StoredText.GetString(property.Value);
            }

            return rejected ? null : result;
        }

        private JsonArray PageObjects(JsonElement objects, string path)
        {
            var result = new JsonArray();
            var i = 0;
            foreach (var item in objects.EnumerateArray())
            {
                var itemPath = $"{path}[{i++}]";
                if (item.ValueKind != JsonValueKind.Object
                    || !item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String
                    || !item.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String
                    || kind.GetString() is not ("image" or "text"))
                {
                    Drop(itemPath, "page objects need a string id and kind 'image' or 'text'");
                    continue;
                }

                var cleaned = new JsonObject
                {
                    ["id"] = StoredText.GetString(id),
                    ["kind"] = kind.GetString(),
                    ["classes"] = item.TryGetProperty("classes", out var classes) && classes.ValueKind == JsonValueKind.Array
                        ? Classes(classes, $"{itemPath}.classes")
                        : new JsonArray(),
                };

                var style = "";
                if (item.TryGetProperty("style", out var styleElement) && styleElement.ValueKind == JsonValueKind.String)
                {
                    style = StoredText.GetString(styleElement);
                    if (CssPolicy.Check(style) is { } cssError)
                    {
                        Error($"{itemPath}.style", cssError);
                        continue;
                    }
                }

                cleaned["style"] = style;

                if (item.TryGetProperty("src", out var src) && src.ValueKind == JsonValueKind.String)
                {
                    if (!UrlPolicy.IsSafeSrc(StoredText.GetString(src)))
                    {
                        Error($"{itemPath}.src", "sources must be http:, https:, relative or data:image/ URLs");
                        continue;
                    }

                    cleaned["src"] = StoredText.GetString(src);
                }

                if (item.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                {
                    var clean = StoredText.GetString(text);
                    cleaned["text"] = clean;
                    AppendText(clean);
                    AppendText("\n");
                }

                if (kind.GetString() == "image" && cleaned["src"] is null)
                {
                    Drop(itemPath, "image objects need a src");
                    continue;
                }

                result.Add(cleaned);
            }

            return result;
        }

        private void AppendText(string text)
        {
            if (_heading is not null && _heading.Length < MaxHeading * 4) _heading.Append(text);

            var room = MaxPlainText - _text.Length;
            if (room <= 0) return;
            if (text.Length <= room)
            {
                _text.Append(text);
                return;
            }

            // Don't split a surrogate pair at the cap.
            if (char.IsHighSurrogate(text[room - 1])) room--;
            _text.Append(text, 0, room);
        }

        private static bool IsClassToken(string value) =>
            value.Length is > 0 and <= MaxClassLength && !value.Any(char.IsWhiteSpace) && !value.Contains('\0');

        private static string Shorten(string value) => value.Length <= 64 ? value : value[..64] + "…";

        private static string CollapseWhitespace(string value) =>
            string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    /// <summary>Whether <paramref name="name"/> may be a key of <c>attrs.attributes</c> (the client's SAFE_ATTR).</summary>
    public bool IsSafeAttributeName(string name)
    {
        // The whole name must match: .NET's '$' also matches before a trailing newline, JavaScript's does not.
        var match = _safeAttribute.Match(name);
        return match.Success && match.Index == 0 && match.Length == name.Length;
    }
}

/// <summary>The outcome of <see cref="DocInspector.Inspect(JsonElement)"/>.</summary>
/// <param name="Errors">Why the document was rejected, keyed by JSON path (<c>doc.content[0].attrs.style</c>).
/// Empty when <see cref="IsValid"/>.</param>
/// <param name="Warnings">Values that were dropped (<c>path: reason</c>), capped at <see cref="DocInspector.MaxErrors"/>.</param>
/// <param name="SanitizedJson">The rebuilt document to store; empty when invalid.</param>
/// <param name="PageCount">Number of pages (<c>doc.content.length</c>).</param>
/// <param name="PlainText">The document's text for search, capped at <see cref="DocInspector.MaxPlainText"/> characters.</param>
/// <param name="FirstHeading">Text of the first non-empty heading (at most <see cref="DocInspector.MaxHeading"/> characters), or null.</param>
/// <param name="NodeCount">Nodes visited.</param>
public sealed record InspectResult(
    IReadOnlyDictionary<string, string[]> Errors,
    IReadOnlyList<string> Warnings,
    string SanitizedJson,
    int PageCount,
    string PlainText,
    string? FirstHeading,
    int NodeCount)
{
    public bool IsValid => Errors.Count == 0;

    internal static InspectResult Fail(string path, string message) =>
        new(new Dictionary<string, string[]> { [path] = [message] }, [], "", 0, "", null, 0);
}
