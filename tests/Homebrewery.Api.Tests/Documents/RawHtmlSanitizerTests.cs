using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Homebrewery.Core.Documents;
using static Homebrewery.Api.Tests.Documents.TestDocs;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>
/// RawHtmlSanitizer limits: HTML that would overflow the stack in AngleSharp's recursive DOM code (which ends the
/// process) or keep its tree construction busy for minutes is refused, quickly.
/// </summary>
public sealed class RawHtmlSanitizerTests
{
    private static readonly RawHtmlSanitizer Sanitizer = new();

    private static string Nested(int depth, string tag = "span") =>
        string.Concat(Enumerable.Repeat($"<{tag}>", depth)) + "x" + string.Concat(Enumerable.Repeat($"</{tag}>", depth));

    /// <summary>1000 misnested formatting elements, then 500 paragraphs that each make the parser clone all of them.</summary>
    private static string MisnestedFormatting(int formatting = 1000, int paragraphs = 500)
    {
        var html = new StringBuilder("<div>");
        for (var i = 0; i < formatting; i++) html.Append($"<b data-i=\"{i}\">");
        html.Append("</div>");
        for (var i = 0; i < paragraphs; i++) html.Append("<p>x</p>");
        return html.ToString();
    }

    [Fact]
    public void Deep_nesting_is_refused_instead_of_overflowing_the_stack()
    {
        var result = Sanitizer.Sanitize(string.Concat(Enumerable.Repeat("<span>", 100_000)));

        Assert.NotNull(result.Error);
        Assert.Equal("", result.Html);
    }

    [Fact]
    public void Nesting_is_limited_to_512_elements()
    {
        var atLimit = Sanitizer.Sanitize(Nested(RawHtmlSanitizer.MaxDepth));
        var overLimit = Sanitizer.Sanitize(Nested(RawHtmlSanitizer.MaxDepth + 1));
        var tables = Sanitizer.Sanitize(string.Concat(Enumerable.Repeat("<table><td>", 200)));   // 4 levels per 2 tags

        Assert.Null(atLimit.Error);
        Assert.Equal(Nested(RawHtmlSanitizer.MaxDepth), atLimit.Html);
        Assert.Equal("x", atLimit.Text);
        Assert.Equal($"must not nest elements more than {RawHtmlSanitizer.MaxDepth} levels deep", overLimit.Error);
        Assert.NotNull(tables.Error);
    }

    [Fact]
    public void Tags_are_limited()
    {
        var flat = string.Concat(Enumerable.Repeat("<i>x</i>", RawHtmlSanitizer.MaxTags / 2 + 1));

        Assert.Equal($"must have at most {RawHtmlSanitizer.MaxTags} tags", Sanitizer.Sanitize(flat).Error);
    }

    [Fact]
    public void Many_attributes_on_one_tag_are_refused_quickly()
    {
        // AngleSharp's tokenizer checks every new attribute against the earlier ones: 40,000 took about a minute.
        var html = "<b" + string.Concat(Enumerable.Range(0, 40_000).Select(i => $" a{i}")) + ">x</b>";

        var watch = Stopwatch.StartNew();
        var result = Sanitizer.Sanitize(html);

        Assert.Equal($"must have at most {RawHtmlSanitizer.MaxAttributes} attributes on one element", result.Error);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), $"took {watch.Elapsed}");
    }

    [Fact]
    public void Html_is_limited_to_1_MB()
    {
        Assert.Null(Sanitizer.Sanitize(new string('x', RawHtmlSanitizer.MaxLength)).Error);
        Assert.Equal("must be at most 1 MB of HTML", Sanitizer.Sanitize(new string('x', RawHtmlSanitizer.MaxLength + 1)).Error);
    }

    [Fact]
    public void Parsing_stops_when_the_time_limit_runs_out()
    {
        // 13 KB that took AngleSharp over 10 s (and 260 MB) to parse: every <p> reopens the 1000 unclosed <b>s.
        var html = MisnestedFormatting();

        var watch = Stopwatch.StartNew();
        var result = Sanitizer.Sanitize(html, TimeSpan.FromMilliseconds(200));

        Assert.Equal("is too complex to check in time", result.Error);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"took {watch.Elapsed}");
    }

    [Fact]
    public void The_raw_html_of_one_document_shares_one_time_limit()
    {
        var inspector = new DocInspector(Manifest, new RawHtmlSanitizer(TimeSpan.FromMilliseconds(300)));
        var slow = MisnestedFormatting(300, 150);
        var blocks = Enumerable.Range(0, 10).Select(_ => (JsonNode)Node("rawHtml", Attrs(("html", slow)))).ToArray();

        var watch = Stopwatch.StartNew();
        using var parsed = System.Text.Json.JsonDocument.Parse(DocWith(blocks).ToJsonString());
        var result = inspector.Inspect(parsed.RootElement);

        Assert.False(result.IsValid);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(4), $"took {watch.Elapsed}");
    }

    [Fact]
    public void Shape_declarations_are_kept_once_and_only_with_safe_urls()
    {
        var result = Sanitizer.Sanitize(
            """<div style="float: right; shape-outside: circle(50%); shape-margin: 1em">a</div>""" +
            """<div style='shape-outside: url("data:image/png;base64,iVBOR"); shape-margin: 4px'>b</div>""" +
            """<div style="SHAPE-OUTSIDE: polygon(0 0, 100% 0; 0 100%)">c</div>""" +
            """<script style="shape-outside: circle(1%)"></script>""");

        Assert.Null(result.Error);
        Assert.Equal(1, CountOf(result.Html, "shape-margin: 1em"));
        Assert.Contains("float: right", result.Html, StringComparison.Ordinal);
        Assert.Contains("shape-outside: circle(50%)", result.Html, StringComparison.Ordinal);
        Assert.Contains("shape-margin: 4px", result.Html, StringComparison.Ordinal);
        Assert.DoesNotContain("data:", result.Html, StringComparison.Ordinal);
        Assert.Contains("shape-outside: polygon(0 0, 100% 0; 0 100%)", result.Html, StringComparison.Ordinal);
        Assert.DoesNotContain("circle(1%)", result.Html, StringComparison.Ordinal);
        Assert.Equal(result.Html, Sanitizer.Sanitize(result.Html).Html);
    }

    private static int CountOf(string text, string value)
    {
        var count = 0;
        for (var i = text.IndexOf(value, StringComparison.Ordinal); i >= 0; i = text.IndexOf(value, i + 1, StringComparison.Ordinal)) count++;
        return count;
    }
}
