using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Homebrewery.Core.Documents;
using static Homebrewery.Api.Tests.Documents.TestDocs;

namespace Homebrewery.Api.Tests.Documents;

/// <summary>
/// RV-14: the server's URL policy against shared/url-policy-cases.json, the cases the client's isSafeHref/isSafeSrc
/// (web/src/editor/schema/urlPolicy.shared.test.ts) must agree with. Every case must pass here, including the ones
/// marked <c>clientGap</c> (those are client bugs).
/// </summary>
public sealed class UrlPolicyTests
{
    private const string FirstBlock = "doc.content[0].content[0]";

    public sealed record UrlCase(int Index, string Url, bool Href, bool Src, string Why, string? ClientGap)
    {
        public override string ToString() => $"#{Index} {Why}";
    }

    private static readonly Lazy<(int MaxLength, List<UrlCase> Cases)> Fixture = new(Load);

    public static TheoryData<int, string> Cases()
    {
        var data = new TheoryData<int, string>();
        foreach (var c in Fixture.Value.Cases) data.Add(c.Index, c.Why);
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void UrlPolicy_agrees_with_the_shared_case(int index, string why)
    {
        var c = Fixture.Value.Cases[index];

        Assert.True(c.Href == UrlPolicy.IsSafeHref(c.Url), $"{why}: IsSafeHref({Describe(c.Url)}) should be {c.Href}");
        Assert.True(c.Src == UrlPolicy.IsSafeSrc(c.Url), $"{why}: IsSafeSrc({Describe(c.Url)}) should be {c.Src}");
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void DocInspector_applies_the_shared_case_to_links_images_and_page_objects(int index, string why)
    {
        var c = Fixture.Value.Cases[index];

        var link = Inspect(DocWith(P(null, Text("click", Mark("link", Attrs(("href", c.Url)))))));
        var image = Inspect(DocWith(P(null, Node("image", Attrs(("src", c.Url))))));
        var pageObject = Inspect(Doc(PageWith(
            Attrs(("objects", new JsonArray(new JsonObject { ["id"] = "o1", ["kind"] = "image", ["src"] = c.Url }))),
            P("x"))));

        Assert.True(c.Href == link.IsValid, $"{why}: link.href {Describe(c.Url)} valid should be {c.Href}");
        Assert.True(c.Src == image.IsValid, $"{why}: image.src {Describe(c.Url)} valid should be {c.Src}");
        Assert.True(c.Src == pageObject.IsValid, $"{why}: page object src {Describe(c.Url)} valid should be {c.Src}");
        if (!c.Href) Assert.Contains($"{FirstBlock}.content[0].marks[0].attrs.href", link.Errors.Keys);
        if (!c.Src) Assert.Contains($"{FirstBlock}.content[0].attrs.src", image.Errors.Keys);
    }

    [Fact]
    public void The_fixture_matches_the_server_limit_and_covers_both_answers()
    {
        var (maxLength, cases) = Fixture.Value;

        Assert.Equal(UrlPolicy.MaxLength, maxLength);
        Assert.True(cases.Count >= 50, $"only {cases.Count} cases");
        Assert.Contains(cases, c => c.Href && c.Src);
        Assert.Contains(cases, c => !c.Href && !c.Src);
        Assert.Contains(cases, c => c.Href && !c.Src);
        Assert.Contains(cases, c => !c.Href && c.Src);
        Assert.Contains(cases, c => c.Url.Length == maxLength);
        Assert.Contains(cases, c => c.Url.Length == maxLength + 1);
        Assert.All(cases.Where(c => c.ClientGap is not null), c => Assert.False(string.IsNullOrWhiteSpace(c.ClientGap)));
    }

    [Theory]
    [InlineData("\uFEFFjavascript:alert(1)", "javascript")]   // U+FEFF is ignored, as by the client's \s (was: relative)
    [InlineData("java\u0085script:alert(1)", null)]           // U+0085 is not: 'java' then a non-scheme character (was: javascript)
    [InlineData("JavaScript:alert(1)", "javascript")]
    [InlineData(" \t java\nscript:x", "javascript")]
    [InlineData("web+app:x", "web+app")]
    [InlineData("1a:x", null)]
    [InlineData("", null)]
    [InlineData("https", null)]
    public void SchemeOf_reads_the_client_scheme(string url, string? expected)
    {
        Assert.Equal(expected, UrlPolicy.SchemeOf(url));
    }

    [Fact]
    public void SchemeOf_reads_schemes_of_any_length()
    {
        var scheme = new string('a', 5000);

        Assert.Equal(scheme, UrlPolicy.SchemeOf(scheme + ":x"));
        Assert.Equal(scheme, UrlPolicy.SchemeOf(new string(' ', 5000) + scheme.ToUpperInvariant() + ":x"));
        Assert.Null(UrlPolicy.SchemeOf(scheme));
    }

    [Fact]
    public void The_ignored_characters_are_the_clients()
    {
        // IGNORED_URL_CHARS in web/src/editor/schema/html.ts: /[\u0000-\u001F\u007F\s]+/g.
        var ecmaScriptWhiteSpace = "\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
        for (var c = char.MinValue; ; c++)
        {
            var expected = c <= '\u001F' || c == '\u007F' || ecmaScriptWhiteSpace.Contains(c);
            Assert.True(expected == UrlPolicy.IsIgnored(c), $"U+{(int)c:X4} ignored should be {expected}");
            if (c == char.MaxValue) break;
        }
    }

    private static (int, List<UrlCase>) Load()
    {
        var path = Path.Combine(SchemaManifestTests.RepositoryRoot(), "shared", "url-policy-cases.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        var cases = new List<UrlCase>();
        foreach (var item in root.GetProperty("cases").EnumerateArray())
        {
            string url;
            if (item.TryGetProperty("url", out var urlElement))
            {
                url = urlElement.GetString()!;
            }
            else
            {
                var sb = new StringBuilder();
                foreach (var part in item.GetProperty("parts").EnumerateArray())
                {
                    var repeat = part.TryGetProperty("repeat", out var r) ? r.GetInt32() : 1;
                    sb.Insert(sb.Length, part.GetProperty("text").GetString()!, repeat);
                }

                url = sb.ToString();
            }

            cases.Add(new UrlCase(
                cases.Count,
                url,
                item.GetProperty("href").GetBoolean(),
                item.GetProperty("src").GetBoolean(),
                item.GetProperty("why").GetString()!,
                item.TryGetProperty("clientGap", out var gap) ? gap.GetString() : null));
        }

        return (root.GetProperty("maxLength").GetInt32(), cases);
    }

    private static string Describe(string url)
    {
        var shown = url.Length > 80 ? $"{url[..40]}…({url.Length} chars)" : url;
        return JsonSerializer.Serialize(shown);
    }
}
