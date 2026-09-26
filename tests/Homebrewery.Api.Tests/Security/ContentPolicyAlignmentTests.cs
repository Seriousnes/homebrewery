using Homebrewery.Core.Documents;

namespace Homebrewery.Api.Tests.Security;

/// <summary>
/// P8.3: stored raw HTML never asks the browser for something the page CSP (SecurityHeaders.DocumentPolicy) would block,
/// so a shared brew renders without CSP violations: no scripts, frames, plugins, media, stylesheets, base or refresh
/// tags, form targets or inline handlers survive the server's sanitizer (plan §14: "safeHTML is a blacklist").
/// </summary>
public sealed class ContentPolicyAlignmentTests
{
    private static readonly RawHtmlSanitizer Sanitizer = new();

    [Theory]
    [InlineData("<script src=\"https://cdn.example/x.js\"></script>", "<script")]
    [InlineData("<script>alert(1)</script>", "<script")]
    [InlineData("<iframe src=\"https://www.youtube.com/embed/x\"></iframe>", "<iframe")]
    [InlineData("<object data=\"https://x.example/a.swf\"></object>", "<object")]
    [InlineData("<embed src=\"https://x.example/a.swf\">", "<embed")]
    [InlineData("<video src=\"https://x.example/v.mp4\" controls></video>", "<video")]
    [InlineData("<audio src=\"https://x.example/a.mp3\"></audio>", "<audio")]
    [InlineData("<video><source src=\"https://x.example/v.mp4\"></video>", "<source")]
    [InlineData("<link rel=\"stylesheet\" href=\"https://x.example/a.css\">", "<link")]
    [InlineData("<style>@import url(https://x.example/a.css);</style>", "<style")]
    [InlineData("<base href=\"https://evil.example/\">", "<base")]
    [InlineData("<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">", "<meta")]
    [InlineData("<form action=\"https://evil.example/\"><button>Go</button></form>", "<form")]
    [InlineData("<input name=\"password\" type=\"password\">", "<input")]            // no fake sign-in fields
    [InlineData("<button formaction=\"https://evil.example/\">Go</button>", "formaction")]
    [InlineData("<textarea name=\"secret\"></textarea>", "<textarea")]
    [InlineData("<img src=\"x\" onerror=\"alert(1)\">", "onerror")]
    [InlineData("<a href=\"javascript:alert(1)\">x</a>", "javascript:")]
    [InlineData("<svg><use href=\"https://x.example/s.svg#a\"></use></svg>", "<use")]
    [InlineData("<svg><foreignObject><div>x</div></foreignObject></svg>", "foreignobject")]
    public void Raw_html_keeps_nothing_the_page_policy_blocks(string html, string forbidden)
    {
        var result = Sanitizer.Sanitize(html);

        Assert.Null(result.Error);
        Assert.DoesNotContain(forbidden, result.Html, StringComparison.OrdinalIgnoreCase);
    }

    // What the policy allows (img-src https: data:, style attributes) survives; the sanitizer may re-serialize styles
    // (quotes, spacing), so the check is on the parsed result.
    [Theory]
    [InlineData("<img src=\"https://i.example/a.png\">", "img", "src", "https://i.example/a.png")]
    [InlineData("<img src=\"data:image/png;base64,iVBORw0KGgo=\">", "img", "src", "data:image/png;base64,iVBORw0KGgo=")]
    [InlineData("<div style=\"background-image:url(https://i.example/a.png)\">x</div>", "div", "style", "https://i.example/a.png")]
    [InlineData("<span style=\"font-family:'Solbera Imitation'\">x</span>", "span", "style", "Solbera Imitation")]
    public void Raw_html_keeps_https_and_data_images_and_inline_styles(string html, string element, string attribute, string kept)
    {
        var result = Sanitizer.Sanitize(html);

        Assert.Null(result.Error);
        var value = new AngleSharp.Html.Parser.HtmlParser().ParseDocument(result.Html).QuerySelector(element)?.GetAttribute(attribute);
        Assert.NotNull(value);
        Assert.Contains(kept, value, StringComparison.Ordinal);
    }
}
