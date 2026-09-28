using System.Text;
using System.Text.Json.Nodes;
using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Core.Documents;
using static Homebrewery.Api.Tests.Documents.TestDocs;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>
/// RawHtmlSanitizer limits: HTML that would overflow the stack in AngleSharp's recursive DOM code (which ends the
/// process) or keep its tree construction busy for minutes is refused, quickly.
/// </summary>
public sealed class RawHtmlSanitizerTests
{
    private const string TooComplex = "is too complex to check in time";

    // The clock stands still: only the tests about the time limit run it out.
    private static readonly RawHtmlSanitizer Sanitizer = new(clock: SteppingClock.Stopped());

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
        // AngleSharp's tokenizer checks every new attribute against the earlier ones: 40,000 took about a minute. The
        // error comes from the attribute limit, so the parse stopped at attribute 257 (the clock stands still).
        var html = "<b" + string.Concat(Enumerable.Range(0, 40_000).Select(i => $" a{i}")) + ">x</b>";

        var result = Sanitizer.Sanitize(html);

        Assert.Equal($"must have at most {RawHtmlSanitizer.MaxAttributes} attributes on one element", result.Error);
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
        // The clock moves 1 ms per read: one read when the parse starts, then one per token.
        var html = MisnestedFormatting();
        var clock = new SteppingClock(TimeSpan.FromMilliseconds(1));

        var result = new RawHtmlSanitizer(TimeSpan.FromMilliseconds(1_100), clock).Sanitize(html);

        Assert.Equal(TooComplex, result.Error);
        Assert.Equal(1 + 1_101, clock.Reads);                    // it stopped at the first token past the limit
    }

    [Fact]
    public void A_parse_that_takes_exactly_the_time_limit_passes()
    {
        var html = string.Concat(Enumerable.Repeat("<i>x</i>", 50));
        var tokens = TokenReads(html);

        var exact = new RawHtmlSanitizer(TimeSpan.FromMilliseconds(tokens), new SteppingClock(TimeSpan.FromMilliseconds(1))).Sanitize(html);
        var oneMsShort = new RawHtmlSanitizer(TimeSpan.FromMilliseconds(tokens - 1), new SteppingClock(TimeSpan.FromMilliseconds(1))).Sanitize(html);

        Assert.Null(exact.Error);
        Assert.Equal(TooComplex, oneMsShort.Error);
    }

    [Fact]
    public void The_raw_html_of_one_document_shares_one_time_limit()
    {
        // Each block costs its tokens plus 2 ms (DocInspector reads the clock before and after it, the parse once when
        // it starts). The limit covers two whole blocks and one ms less than the third one's tokens: the third block
        // runs out on its last token, and the fourth gets no time at all.
        var html = string.Concat(Enumerable.Repeat("<i>x</i>", 20));
        var tokens = TokenReads(html);
        var limit = TimeSpan.FromMilliseconds((2 * (tokens + 2)) + (tokens - 1));
        var inspector = new DocInspector(Manifest, new RawHtmlSanitizer(limit, new SteppingClock(TimeSpan.FromMilliseconds(1))));
        var blocks = Enumerable.Range(0, 4).Select(_ => (JsonNode)Node("rawHtml", Attrs(("html", html)))).ToArray();

        using var parsed = System.Text.Json.JsonDocument.Parse(DocWith(blocks).ToJsonString());
        var result = inspector.Inspect(parsed.RootElement);

        Assert.Equal(
            new Dictionary<string, string[]>
            {
                ["doc.content[0].content[2].attrs.html"] = [TooComplex],
                ["doc.content[0].content[3].attrs.html"] = [TooComplex],
            },
            result.Errors);
    }

    /// <summary>How many times parsing <paramref name="html"/> reads the clock per token (all reads but the first).</summary>
    private static long TokenReads(string html)
    {
        var clock = SteppingClock.Stopped();
        Assert.Null(new RawHtmlSanitizer(clock: clock).Sanitize(html).Error);
        return clock.Reads - 1;
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
