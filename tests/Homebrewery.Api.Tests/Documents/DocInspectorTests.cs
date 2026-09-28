using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Core.Documents;
using static Homebrewery.Api.Tests.Documents.TestDocs;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>P2.4: DocInspector (plan §8.5) against the real shared/schema-manifest.json.</summary>
public sealed class DocInspectorTests
{
    private const string FirstBlock = "doc.content[0].content[0]";

    // ---- valid documents and extraction --------------------------------------------------------

    [Fact]
    public void The_plan_example_is_valid_and_survives_unchanged()
    {
        var result = Inspector.Inspect(PlanExample);

        Assert.True(result.IsValid, string.Join("; ", result.Errors.SelectMany(e => e.Value.Select(v => $"{e.Key}: {v}"))));
        Assert.Empty(result.Warnings);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(PlanExample), JsonNode.Parse(result.SanitizedJson)));
    }

    [Fact]
    public void Page_count_text_and_title_are_extracted()
    {
        var result = Inspector.Inspect(PlanExample);

        Assert.Equal(2, result.PageCount);
        Assert.Equal("The Wandering Inn", result.FirstHeading);
        Assert.Equal(
            "The Wandering Inn\nTravelers speak of an inn that is never in the same place twice.\nRumors\n" +
            "The innkeeper never ages.\nThe common room smells of cedar,\npipe smoke and rain that never falls outside.",
            result.PlainText);
        Assert.Equal(16, result.NodeCount);
    }

    [Fact]
    public void Page_count_is_the_number_of_pages()
    {
        var result = Inspect(Doc(Page(P("one")), Page(P("two")), Page(P("three"))));

        Assert.True(result.IsValid);
        Assert.Equal(3, result.PageCount);
    }

    [Fact]
    public void The_first_heading_skips_empty_headings_collapses_whitespace_and_is_capped()
    {
        var longTitle = string.Concat(Enumerable.Repeat("Long  title ", 20));
        var result = Inspect(DocWith(
            P("intro"),
            Node("heading", Attrs(("level", 2))),                                     // empty heading
            Node("themeBlock", Attrs(("classes", new JsonArray("note"))), H(3, "  First\n  real   heading ")),
            H(1, longTitle)));

        Assert.True(result.IsValid);
        Assert.Equal("First real heading", result.FirstHeading);

        var capped = Inspect(DocWith(H(1, longTitle))).FirstHeading;
        Assert.NotNull(capped);
        Assert.True(capped.Length <= DocInspector.MaxHeading);
        Assert.StartsWith("Long title Long title", capped);
    }

    [Fact]
    public void Without_headings_the_first_heading_is_null()
    {
        Assert.Null(Inspect(DocWith(P("no headings here"))).FirstHeading);
    }

    [Fact]
    public void Plain_text_has_hard_breaks_and_is_capped()
    {
        var withBreak = Inspect(DocWith(P(null, Text("line one"), Node("hardBreak"), Text("line two"))));
        Assert.Equal("line one\nline two", withBreak.PlainText);

        var big = new string('x', 150 * 1024);
        var capped = Inspect(DocWith(P(big), P(big)));
        Assert.True(capped.IsValid);
        Assert.Equal(DocInspector.MaxPlainText, capped.PlainText.Length);
    }

    [Fact]
    public void Inspecting_the_output_again_changes_nothing()
    {
        var once = Inspect(DocWith(
            P(Attrs(("align", "center"), ("onclick", "x"), ("classes", new JsonArray("a", "page"))), Text("hi", Mark("bold"))),
            Node("rawHtml", Attrs(("html", "<div class=\"x\" onclick=\"y\">raw</div>")))));
        var twice = Inspector.Inspect(once.SanitizedJson);

        Assert.True(once.IsValid);
        Assert.NotEmpty(once.Warnings);
        Assert.Equal(once.SanitizedJson, twice.SanitizedJson);
        Assert.Empty(twice.Warnings);
    }

    // ---- structure --------------------------------------------------------------------------------

    [Fact]
    public void Unknown_node_types_are_rejected()
    {
        var result = Inspect(DocWith(P("fine"), Node("script", null, Text("alert(1)"))));

        Assert.False(result.IsValid);
        Assert.Equal("", result.SanitizedJson);
        var error = Assert.Single(result.Errors);
        Assert.Equal("doc.content[0].content[1].type", error.Key);
        Assert.Contains("unknown node type 'script'", error.Value[0]);
    }

    [Fact]
    public void Unknown_mark_types_are_rejected()
    {
        var result = Inspect(DocWith(P(null, Text("x", Mark("blink")))));

        Assert.False(result.IsValid);
        Assert.Contains($"{FirstBlock}.content[0].marks[0].type", result.Errors.Keys);
    }

    [Theory]
    [InlineData("""{"type":"page","content":[{"type":"paragraph"}]}""", "doc.type")]                                   // root must be doc
    [InlineData("""{"type":"doc","content":[{"type":"paragraph"}]}""", "doc.content[0].type")]                         // paragraph in doc
    [InlineData("""{"type":"doc","content":[{"type":"page","content":[{"type":"text","text":"x"}]}]}""", "doc.content[0].content[0].type")]
    [InlineData("""{"type":"doc","content":[]}""", "doc")]                                                                // doc needs a page
    [InlineData("""{"type":"doc","content":[{"type":"page"}]}""", "doc.content[0]")]                                     // page needs a block
    [InlineData("""{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph","content":[{"type":"text","text":""}]}]}]}""", "doc.content[0].content[0].content[0].text")]
    [InlineData("""{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph","content":[{"type":"text"}]}]}]}""", "doc.content[0].content[0].content[0].text")]
    [InlineData("""{"type":"doc","content":{"type":"page"}}""", "doc.content")]
    [InlineData("""{"type":"doc","content":[{"type":"page","content":["text"]}]}""", "doc.content[0].content[0]")]
    [InlineData("""{"content":[]}""", "doc.type")]
    [InlineData("""[]""", "doc")]
    [InlineData("""{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":{"type":"bold"}}]}]}]}""", "doc.content[0].content[0].content[0].marks")]
    public void Invalid_structure_is_rejected(string json, string errorPath)
    {
        var result = Inspector.Inspect(json);

        Assert.False(result.IsValid);
        Assert.Contains(errorPath, result.Errors.Keys);
    }

    [Fact]
    public void Leaf_content_unknown_keys_and_disallowed_marks_are_dropped()
    {
        var doc = DocWith(
            Node("horizontalRule", null, P("inside a leaf")),
            Node("codeBlock", null, Text("code", Mark("bold"))));
        ((JsonObject)doc["content"]![0]!["content"]![0]!)["extra"] = "value";

        var result = Inspect(doc);

        Assert.True(result.IsValid);
        var page = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!;
        Assert.Null(page["content"]![0]!["content"]);
        Assert.Null(page["content"]![0]!["extra"]);
        Assert.Null(page["content"]![1]!["content"]![0]!["marks"]);
        Assert.Contains(result.Warnings, w => w.StartsWith($"{FirstBlock}.content:", StringComparison.Ordinal));
        Assert.Contains(result.Warnings, w => w.StartsWith($"{FirstBlock}.extra:", StringComparison.Ordinal));
        Assert.Contains(result.Warnings, w => w.StartsWith("doc.content[0].content[1].content[0].marks[0]:", StringComparison.Ordinal));
    }

    // ---- attributes --------------------------------------------------------------------------------

    [Fact]
    public void Attributes_not_in_the_manifest_are_dropped()
    {
        var result = Inspect(DocWith(P(Attrs(("align", "center"), ("onclick", "alert(1)"), ("href", "javascript:alert(1)")), Text("x"))));

        Assert.True(result.IsValid);
        var attrs = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!.AsObject();
        Assert.Equal(["align"], attrs.Select(a => a.Key));
        Assert.Contains($"{FirstBlock}.attrs.onclick: not in the schema", result.Warnings);
        Assert.Contains($"{FirstBlock}.attrs.href: not in the schema", result.Warnings);
    }

    [Fact]
    public void Values_of_the_wrong_type_are_dropped()
    {
        var result = Inspect(DocWith(
            Node("heading", Attrs(("level", "2"), ("id", "ok")), Text("x")),
            Node("toc", Attrs(("depth", true)))));

        Assert.True(result.IsValid);
        var content = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]!;
        Assert.Null(content[0]!["attrs"]!["level"]);
        Assert.Equal("ok", (string?)content[0]!["attrs"]!["id"]);
        Assert.Null(content[1]!["attrs"]);
        Assert.Contains($"{FirstBlock}.attrs.level: expected number", result.Warnings);
    }

    [Theory]
    [InlineData("onclick")]
    [InlineData("onmouseover")]
    [InlineData("ONCLICK")]
    [InlineData("style")]
    [InlineData("class")]
    [InlineData("id")]
    [InlineData("href")]
    [InlineData("src")]
    [InlineData("formaction")]
    [InlineData("data-x\n")]
    [InlineData("data-é")]
    [InlineData("xlink:href")]
    [InlineData("")]
    public void Unsafe_keys_in_attributes_are_rejected(string key)
    {
        var result = Inspect(DocWith(P(Attrs(("attributes", new JsonObject { [key] = "alert(1)" })), Text("x"))));

        Assert.False(result.IsValid);
        Assert.Contains($"{FirstBlock}.attrs.attributes.{key}", result.Errors.Keys);
    }

    [Fact]
    public void Safe_attributes_are_kept_and_reserved_or_non_string_ones_dropped()
    {
        var attributes = new JsonObject
        {
            ["data-foo"] = "1", ["aria-label"] = "Label", ["title"] = "T", ["lang"] = "fr", ["dir"] = "rtl", ["role"] = "note",
            ["data-pid"] = "reserved", ["data-n"] = 5,
        };
        var result = Inspect(DocWith(P(Attrs(("attributes", attributes)), Text("x"))));

        Assert.True(result.IsValid);
        var kept = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["attributes"]!.AsObject();
        Assert.Equal(["data-foo", "aria-label", "title", "lang", "dir", "role"], kept.Select(a => a.Key));
        Assert.Contains($"{FirstBlock}.attrs.attributes.data-pid: reserved attribute", result.Warnings);
        Assert.Contains($"{FirstBlock}.attrs.attributes.data-n: attribute values must be strings", result.Warnings);
    }

    [Fact]
    public void Image_title_stays_out_of_attributes()
    {
        var image = Node("image", Attrs(("src", "/a.png"), ("attributes", new JsonObject { ["title"] = "dup", ["data-a"] = "b" })));
        var result = Inspect(DocWith(P(null, image)));

        Assert.True(result.IsValid);
        var attributes = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]![0]!["attrs"]!["attributes"]!.AsObject();
        Assert.Equal(["data-a"], attributes.Select(a => a.Key));
    }

    [Fact]
    public void Classes_keep_only_valid_unreserved_tokens()
    {
        var result = Inspect(DocWith(Node("themeBlock",
            Attrs(("classes", new JsonArray("monster", "frame", "page", "block", "a b", "", 5, "wide"))), P("x"))));

        Assert.True(result.IsValid);
        var classes = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["classes"]!.AsArray();
        Assert.Equal(["monster", "frame", "wide"], classes.Select(c => (string?)c));
    }

    [Fact]
    public void Unknown_icon_fonts_are_dropped()
    {
        var result = Inspect(DocWith(P(null,
            Node("icon", Attrs(("font", "gi"), ("glyph", "broadsword"))),
            Node("icon", Attrs(("font", "evil"), ("glyph", "x y"))))));

        Assert.True(result.IsValid);
        var icons = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]!.AsArray();
        Assert.Equal("gi", (string?)icons[0]!["attrs"]!["font"]);
        Assert.Null(icons[1]!["attrs"]!["font"]);
    }

    [Theory]
    [InlineData("fa-dragon fa-2x", "fa-dragon fa-2x")]         // Font Awesome modifiers: the glyph is every other class
    [InlineData("fa-dragon\tfa-spin", "fa-dragon fa-spin")]
    [InlineData("  fa-dragon   fa-spin ", "fa-dragon fa-spin")]
    [InlineData("fa-x page", "fa-x")]                          // reserved classes are dropped
    [InlineData("d12-2", "d12-2")]
    public void Icon_glyphs_keep_every_class(string glyph, string stored)
    {
        var result = Inspect(DocWith(P(null, Node("icon", Attrs(("font", "fas"), ("glyph", glyph))))));

        Assert.True(result.IsValid);
        var attrs = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]![0]!["attrs"]!;
        Assert.Equal("fas", (string?)attrs["font"]);
        Assert.Equal(stored, (string?)attrs["glyph"]);
    }

    // ---- URLs --------------------------------------------------------------------------------------

    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("JavaScript:alert(1)")]
    [InlineData("  javascript:alert(1)")]
    [InlineData("java\tscript:alert(1)")]
    [InlineData("java\nscript:alert(1)")]
    [InlineData("\u0001javascript:alert(1)")]
    [InlineData("vbscript:msgbox(1)")]
    [InlineData("data:text/html,<script>alert(1)</script>")]
    [InlineData("data:image/png;base64,AAAA")]
    [InlineData("file:///etc/passwd")]
    [InlineData("ftp://example.com/x")]
    public void Unsafe_link_urls_are_rejected(string href)
    {
        var result = Inspect(DocWith(P(null, Text("click", Mark("link", Attrs(("href", href)))))));

        Assert.False(result.IsValid);
        Assert.Contains($"{FirstBlock}.content[0].marks[0].attrs.href", result.Errors.Keys);
    }

    [Theory]
    [InlineData("https://example.com/a?b=c#d")]
    [InlineData("http://example.com")]
    [InlineData("mailto:someone@example.com")]
    [InlineData("/share/abc123def456")]
    [InlineData("relative/page")]
    [InlineData("#p3")]
    [InlineData("//cdn.example.com/x")]
    [InlineData("?q=1")]
    public void Safe_link_urls_are_kept(string href)
    {
        var result = Inspect(DocWith(P(null, Text("click", Mark("link", Attrs(("href", href), ("target", "_blank")))))));

        Assert.True(result.IsValid);
        Assert.Equal(href, (string?)JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]![0]!["marks"]![0]!["attrs"]!["href"]);
    }

    [Theory]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("data:text/html;base64,PHNjcmlwdD4=", false)]
    [InlineData("mailto:a@example.com", false)]
    [InlineData(" data:image/png;base64,iVBORw0KGgo=", true)]
    [InlineData("DATA:IMAGE/SVG+XML;utf8,<svg/>", true)]
    [InlineData("https://i.imgur.com/x.png", true)]
    [InlineData("/assets/frameBorder.png", true)]
    public void Image_sources_allow_http_relative_and_data_images_only(string src, bool valid)
    {
        var result = Inspect(DocWith(P(null, Node("image", Attrs(("src", src), ("alt", "a"))))));

        Assert.Equal(valid, result.IsValid);
        if (!valid) Assert.Contains($"{FirstBlock}.content[0].attrs.src", result.Errors.Keys);
    }

    [Fact]
    public void Page_object_sources_and_styles_are_checked()
    {
        JsonObject PageObject(string kind, string? src, string style) => new()
        {
            ["id"] = "o1", ["kind"] = kind, ["classes"] = new JsonArray("watercolor4"), ["style"] = style,
            ["src"] = src,
        };
        JsonObject DocWithObject(JsonObject o) => Doc(PageWith(Attrs(("objects", new JsonArray(o))), P("x")));

        var unsafeSrc = Inspect(DocWithObject(PageObject("image", "javascript:alert(1)", "top:0")));
        var badStyle = Inspect(DocWithObject(PageObject("image", "/a.png", "background:url(javascript:alert(1))")));
        var fine = Inspect(DocWithObject(PageObject("image", "https://example.com/a.png", "position:absolute;top:0")));

        Assert.Contains("doc.content[0].attrs.objects[0].src", unsafeSrc.Errors.Keys);
        Assert.Contains("doc.content[0].attrs.objects[0].style", badStyle.Errors.Keys);
        Assert.True(fine.IsValid);
    }

    [Fact]
    public void Malformed_page_objects_are_dropped()
    {
        var objects = new JsonArray(
            new JsonObject { ["kind"] = "image", ["src"] = "/a.png" },                          // no id
            new JsonObject { ["id"] = "o2", ["kind"] = "video", ["src"] = "/a.mp4" },         // unknown kind
            new JsonObject { ["id"] = "o3", ["kind"] = 1 },                                   // kind not a string
            new JsonObject { ["id"] = "o4", ["kind"] = "image" },                             // image without src
            new JsonObject { ["id"] = "o5", ["kind"] = "text", ["text"] = "Artist", ["onload"] = "x" },
            "not an object");
        var result = Inspect(Doc(PageWith(Attrs(("objects", objects)), P("x"))));

        Assert.True(result.IsValid);
        var kept = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["attrs"]!["objects"]!.AsArray();
        var only = Assert.Single(kept);
        Assert.True(JsonNode.DeepEquals(
            JsonNode.Parse("""{"id":"o5","kind":"text","classes":[],"style":"","text":"Artist"}"""), only));
        Assert.Contains("Artist", result.PlainText);
    }

    // ---- styles ----------------------------------------------------------------------------------

    [Theory]
    [InlineData("width:expression(alert(1))")]
    [InlineData("background:url(javascript:alert(1))")]
    [InlineData("background:url('JAVASCRIPT:alert(1)')")]
    [InlineData("behavior: url(x.htc)")]
    [InlineData("-moz-binding:url(http://x/y.xml#z)")]
    [InlineData("background:url(java\\73 cript:alert(1))")]
    [InlineData("width:expr/**/ession(alert(1))")]
    [InlineData("background:url(vbscript:x)")]
    public void Bad_css_is_rejected(string style)
    {
        var onNode = Inspect(DocWith(P(Attrs(("style", style)), Text("x"))));
        var onSpan = Inspect(DocWith(P(null, Text("x", Mark("span", Attrs(("style", style)))))));

        Assert.Contains($"{FirstBlock}.attrs.style", onNode.Errors.Keys);
        Assert.Contains($"{FirstBlock}.content[0].marks[0].attrs.style", onSpan.Errors.Keys);
    }

    [Fact]
    public void Styles_are_limited_to_4096_characters()
    {
        var ok = "color: red; " + new string(' ', CssPolicy.MaxLength - 12);
        var tooLong = ok + " ";

        Assert.True(Inspect(DocWith(P(Attrs(("style", ok)), Text("x")))).IsValid);
        Assert.Contains($"{FirstBlock}.attrs.style", Inspect(DocWith(P(Attrs(("style", tooLong)), Text("x")))).Errors.Keys);
    }

    [Fact]
    public void Ordinary_styles_are_kept()
    {
        const string style = "--HB_src:url(https://example.com/x.png); column-span: all; background: url('/assets/a.png')";
        var result = Inspect(DocWith(P(Attrs(("style", style)), Text("x"))));

        Assert.True(result.IsValid);
        Assert.Equal(style, (string?)JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["style"]);
    }

    // ---- rawHtml ---------------------------------------------------------------------------------

    [Fact]
    public void Raw_html_is_sanitized()
    {
        const string html = """
            <div class="block wide" style="color: red; column-span: all" onclick="alert(1)" data-x="1" aria-label="l" contenteditable="true">
              Text <script>alert(1)</script><iframe src="https://evil.example"></iframe>
              <svg viewBox="0 0 10 10" onload="alert(1)"><linearGradient id="g"><stop offset="0"/></linearGradient><path d="M0 0L10 10" fill="url(#g)"/><use href="#g"/><foreignObject><p>x</p></foreignObject></svg>
              <a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>
              <img src="data:image/png;base64,iVBORw0KGgo=" onerror="alert(1)"><img src="javascript:alert(1)">
              <style>body{}</style><form action="https://evil.example"><input name="password"></form>
            </div>
            """;
        var result = Inspect(DocWith(Node("rawHtml", Attrs(("html", html)))));

        Assert.True(result.IsValid);
        var clean = (string)JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["html"]!;
        foreach (var gone in new[] { "<script", "alert(1)", "<iframe", "onclick", "onload", "onerror", "javascript:", "<use", "foreignObject", "<style", "<form", "<input", "contenteditable" })
        {
            Assert.DoesNotContain(gone, clean, StringComparison.OrdinalIgnoreCase);
        }

        foreach (var kept in new[] { "class=\"block wide\"", "column-span: all", "data-x=\"1\"", "aria-label=\"l\"", "<svg", "viewBox=\"0 0 10 10\"", "<path", "linearGradient", "href=\"https://example.com\"", "src=\"data:image/png;base64,iVBORw0KGgo=\"" })
        {
            Assert.Contains(kept, clean, StringComparison.Ordinal);
        }

        Assert.Contains("Text", result.PlainText);
        Assert.Contains("good", result.PlainText);
    }

    // ---- limits ----------------------------------------------------------------------------------

    [Fact]
    public void Documents_over_10_MB_are_rejected()
    {
        var huge = new string('x', DocInspector.MaxBytes);
        var json = DocWith(P(huge)).ToJsonString();

        var fromText = Inspector.Inspect(json);
        using var parsed = JsonDocument.Parse(json);
        var fromElement = Inspector.Inspect(parsed.RootElement);

        Assert.Equal(["doc"], fromText.Errors.Keys);
        Assert.Equal(["doc"], fromElement.Errors.Keys);
        Assert.Contains("10 MB", fromElement.Errors["doc"][0]);
    }

    [Fact]
    public void Nesting_is_limited_to_64_levels()
    {
        static JsonObject Nested(int depth)
        {
            // doc (1) > page (2) > blockquote (3 … depth-2) > paragraph (depth-1) > text (depth)
            JsonNode block = P("deep");
            for (var level = depth - 2; level >= 3; level--) block = Node("blockquote", null, block);
            return Doc(Page(block));
        }

        var atLimit = Inspect(Nested(DocInspector.MaxDepth));
        var overLimit = Inspect(Nested(DocInspector.MaxDepth + 1));

        Assert.True(atLimit.IsValid);
        Assert.False(overLimit.IsValid);
        Assert.Contains(overLimit.Errors, e => e.Value.Any(m => m.Contains("nested deeper than 64", StringComparison.Ordinal)));
    }

    [Fact]
    public void Json_nested_beyond_the_parser_limit_is_rejected()
    {
        var json = new StringBuilder();
        for (var i = 0; i < DocInspector.MaxJsonDepth + 1; i++) json.Append("{\"a\":");
        json.Append('1').Append('}', DocInspector.MaxJsonDepth + 1);

        var result = Inspector.Inspect(json.ToString());

        Assert.Equal(["doc"], result.Errors.Keys);
    }

    [Fact]
    public void Node_count_is_limited()
    {
        // doc + page + n × (paragraph + text). The JSON is written as text: 125,000 JsonNode paragraphs took seconds.
        var paragraphs = string.Join(",", Enumerable.Repeat(P("x").ToJsonString(), (DocInspector.MaxNodes / 2) - 1));
        static string OnePage(string blocks) => $$"""{"type":"doc","content":[{"type":"page","content":[{{blocks}}]}]}""";
        var atLimit = Inspector.Inspect(OnePage(paragraphs));
        var overLimit = Inspector.Inspect(OnePage(paragraphs + "," + P("one more").ToJsonString()));

        Assert.True(atLimit.IsValid);
        Assert.Equal(DocInspector.MaxNodes, atLimit.NodeCount);
        Assert.False(overLimit.IsValid);
        Assert.Contains("250000 nodes", overLimit.Errors["doc"][0]);
    }

    [Fact]
    public void Errors_are_capped()
    {
        var bad = Enumerable.Range(0, 200).Select(_ => (JsonNode)Node("marquee", null, Text("x"))).ToArray();

        var result = Inspect(DocWith(bad));

        Assert.Equal(DocInspector.MaxErrors, result.Errors.Sum(e => e.Value.Length));
    }

    // ---- storable strings -----------------------------------------------------------------------

    [Fact]
    public void Nul_characters_and_lone_surrogates_are_removed()
    {
        var result = Inspector.Inspect("""
            {"type":"doc","content":[{"type":"page","content":[{"type":"paragraph","attrs":{"id":"a\u0000b"},
              "content":[{"type":"text","text":"x\u0000y\ud800z"}]}]}]}
            """);

        Assert.True(result.IsValid);
        var paragraph = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!;
        Assert.Equal("ab", (string?)paragraph["attrs"]!["id"]);
        Assert.Equal("xy�z", (string?)paragraph["content"]![0]!["text"]);
    }

    [Fact]
    public void An_unpaired_surrogate_in_a_key_is_rejected_not_thrown()
    {
        var result = Inspector.Inspect("""
            {"type":"doc","content":[{"type":"page","content":[{"type":"paragraph","attrs":{"\ud800":"x"},
              "content":[{"type":"text","text":"x"}]}]}]}
            """);

        Assert.Equal(["doc"], result.Errors.Keys);
    }

    [Fact]
    public void A_text_node_of_only_nul_characters_is_rejected()
    {
        var result = Inspector.Inspect("""
            {"type":"doc","content":[{"type":"page","content":[{"type":"paragraph","content":[{"type":"text","text":"\u0000"}]}]}]}
            """);

        Assert.False(result.IsValid);
    }

    // ---- numbers -----------------------------------------------------------------------------------

    [Theory]
    [InlineData("1e131071")]                    // PostgreSQL's jsonb would print 131,072 digits for these 8 bytes
    [InlineData("1e131072")]                    // beyond numeric's range: the INSERT would fail
    [InlineData("1e308")]                       // finite, but 309 digits in jsonb
    [InlineData("-1e20")]
    public void Numbers_that_cannot_be_stored_compactly_are_dropped(string number)
    {
        var result = Inspector.Inspect($$"""
            {"type":"doc","content":[{"type":"page","attrs":{"columns":{{number}}},"content":[
              {"type":"heading","attrs":{"level":{{number}}},"content":[{"type":"text","text":"x"}]}]}]}
            """);

        Assert.True(result.IsValid);
        var page = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!;
        Assert.Null(page["attrs"]?["columns"]);
        Assert.Null(page["content"]![0]!["attrs"]?["level"]);
        Assert.Contains($"{FirstBlock}.attrs.level: not a storable number", result.Warnings);
        Assert.True(result.SanitizedJson.Length < 200, result.SanitizedJson);
    }

    [Fact]
    public void Numbers_are_written_canonically()
    {
        var result = Inspector.Inspect("""
            {"type":"doc","content":[{"type":"page","content":[
              {"type":"heading","attrs":{"level":2.0},"content":[{"type":"text","text":"x"}]},
              {"type":"orderedList","attrs":{"start":1e-20000},"content":[{"type":"listItem","content":[{"type":"paragraph"}]}]},
              {"type":"table","content":[{"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"colspan":1,"colwidth":[1e131071,120.50]},"content":[{"type":"paragraph"}]}]}]},
              {"type":"toc","attrs":{"depth":1e-20000}}]}]}
            """);

        Assert.True(result.IsValid, string.Join("; ", result.Errors.SelectMany(e => e.Value)));
        var blocks = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]!;
        Assert.Equal("2", blocks[0]!["attrs"]!["level"]!.ToJsonString());
        Assert.Equal("0", blocks[1]!["attrs"]!["start"]!.ToJsonString());
        Assert.Equal("[null,120.5]", blocks[2]!["content"]![0]!["content"]![0]!["attrs"]!["colwidth"]!.ToJsonString());
        // Constraints see the canonical number: toc.depth 1e-20000 is 0, which the manifest's enum (1-6) drops (RV-15).
        Assert.Null(blocks[3]!["attrs"]);
        Assert.Contains("doc.content[0].content[3].attrs.depth: must be one of 1, 2, 3, 4, 5, 6", result.Warnings);
    }

    // ---- links -------------------------------------------------------------------------------------

    [Theory]
    [InlineData("_blank", "opener", "_blank", null)]
    [InlineData("_blank", "noopener opener", "_blank", "noopener")]
    [InlineData("_BLANK", "nofollow OPENER  noreferrer", "_blank", "nofollow noreferrer")]
    [InlineData("_self", "nofollow", "_self", "nofollow")]
    [InlineData("popup", "noopener", null, "noopener")]           // a named window would get an opener
    [InlineData("_top", null, null, null)]
    public void Link_targets_are_limited_and_rel_opener_is_removed(string target, string? rel, string? storedTarget, string? storedRel)
    {
        var attrs = Attrs(("href", "https://example.com/"), ("target", target), ("rel", rel));
        var result = Inspect(DocWith(P(null, Text("x", Mark("link", attrs)))));

        Assert.True(result.IsValid);
        var stored = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]![0]!["marks"]![0]!["attrs"]!;
        Assert.Equal("https://example.com/", (string?)stored["href"]);
        Assert.Equal(storedTarget, (string?)stored["target"]);
        Assert.Equal(storedRel, (string?)stored["rel"]);
        if (storedTarget is null) Assert.Contains(result.Warnings, w => w.StartsWith($"{FirstBlock}.content[0].marks[0].attrs.target:", StringComparison.Ordinal));
    }

    // ---- content expressions and mark sets ---------------------------------------------------------

    [Fact]
    public void A_list_item_must_start_with_a_paragraph()
    {
        var nested = Node("bulletList", null, Node("listItem", null, P("inner")));
        var result = Inspect(DocWith(Node("bulletList", null, Node("listItem", null, nested))));

        Assert.False(result.IsValid);
        Assert.Contains("doc.content[0].content[0].content[0]", result.Errors.Keys);
    }

    [Fact]
    public void Content_that_matches_its_expression_is_kept()
    {
        var result = Inspect(DocWith(
            Node("bulletList", null, Node("listItem", null, P("first"), Node("bulletList", null, Node("listItem", null, P("inner"))))),
            Node("definitionList", null, Node("definitionTerm", null, Text("term")), Node("definitionDesc", null, Text("desc"))),
            Node("table", null, Node("tableRow", null, Node("tableHeader", null, P("h")), Node("tableCell", null, P("c"))))));

        Assert.True(result.IsValid, string.Join("; ", result.Errors.SelectMany(e => e.Value.Select(v => $"{e.Key}: {v}"))));
        Assert.True(Inspector.Inspect(PlanExample).IsValid);
    }

    [Theory]
    [InlineData("bold", "bold")]
    [InlineData("italic", "italic")]
    public void Duplicate_marks_are_dropped(string first, string second)
    {
        var result = Inspect(DocWith(P(null, Text("x", Mark(first), Mark(second)))));

        Assert.True(result.IsValid);
        var marks = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]![0]!["marks"]!.AsArray();
        Assert.Equal([first], marks.Select(m => (string?)m!["type"]));
        Assert.Contains(result.Warnings, w => w.StartsWith($"{FirstBlock}.content[0].marks[1]:", StringComparison.Ordinal));
    }

    [Fact]
    public void A_mark_excluded_by_an_earlier_one_is_dropped()
    {
        var result = Inspect(DocWith(P(null, Text("x",
            Mark("link", Attrs(("href", "#a"))), Mark("bold"), Mark("link", Attrs(("href", "#b"))),
            Mark("span", Attrs(("classes", new JsonArray("a")))), Mark("span", Attrs(("classes", new JsonArray("b")))),
            Mark("span", Attrs(("classes", new JsonArray("a"))))))));

        Assert.True(result.IsValid);
        var marks = JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["content"]![0]!["marks"]!.AsArray();
        Assert.Equal(["link", "bold", "span", "span"], marks.Select(m => (string?)m!["type"]));
        Assert.Equal("#a", (string?)marks[0]!["attrs"]!["href"]);
        Assert.Equal(["a", "b"], marks.Skip(2).Select(m => (string?)m!["attrs"]!["classes"]![0]));
    }

    // ---- raw HTML limits -----------------------------------------------------------------------------

    [Fact]
    public void Deeply_nested_raw_html_is_rejected_without_crashing()
    {
        var html = string.Concat(Enumerable.Repeat("<span>", 20_000));

        var result = Inspect(DocWith(Node("rawHtml", Attrs(("html", html)))));

        Assert.False(result.IsValid);
        Assert.Contains($"{FirstBlock}.attrs.html", result.Errors.Keys);
    }

    [Fact]
    public void Raw_html_nested_deeper_than_512_elements_is_rejected()
    {
        var html = string.Concat(Enumerable.Repeat("<span>", 600));

        var result = Inspect(DocWith(Node("rawHtml", Attrs(("html", html)))));

        Assert.False(result.IsValid);
        Assert.Contains("512", result.Errors[$"{FirstBlock}.attrs.html"][0], StringComparison.Ordinal);
    }

    [Fact]
    public void Raw_html_nested_100_levels_is_kept()
    {
        var html = string.Concat(Enumerable.Repeat("<span>", 100)) + "deep" + string.Concat(Enumerable.Repeat("</span>", 100));

        var result = Inspect(DocWith(Node("rawHtml", Attrs(("html", html)))));

        Assert.True(result.IsValid);
        Assert.Equal(html, (string?)JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["html"]);
        Assert.Contains("deep", result.PlainText, StringComparison.Ordinal);
    }

    [Fact]
    public void Shape_outside_in_raw_html_is_kept_when_harmless()
    {
        const string html = """
            <div style="float: right; shape-outside: circle(50%); shape-margin: 1em">a</div><div style="shape-outside: url(https://example.com/s.png)">b</div><div style="shape-outside: url(javascript:alert(1)); color: red">c</div><div style="shape-outside: url(data:image/png;base64,iVBORw0KGgo=)">d</div>
            """;

        var result = Inspect(DocWith(Node("rawHtml", Attrs(("html", html)))));

        Assert.True(result.IsValid);
        var clean = (string)JsonNode.Parse(result.SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["html"]!;
        Assert.Contains("shape-outside: circle(50%)", clean, StringComparison.Ordinal);
        Assert.Contains("shape-margin: 1em", clean, StringComparison.Ordinal);
        Assert.Contains("shape-outside: url(https://example.com/s.png)", clean, StringComparison.Ordinal);
        Assert.DoesNotContain("javascript", clean, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data:", clean, StringComparison.Ordinal);
        Assert.Equal(clean, (string)JsonNode.Parse(Inspector.Inspect(result.SanitizedJson).SanitizedJson)!["content"]![0]!["content"]![0]!["attrs"]!["html"]!);
    }
}
