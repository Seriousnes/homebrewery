using System.Text.RegularExpressions;
using AngleSharp;
using AngleSharp.Dom;
using AngleSharp.Html.Dom;
using AngleSharp.Html.Parser;
using AngleSharp.Html.Parser.Tokens;
using AngleSharp.Html.Parser.Tokens.Struct;
using Ganss.Xss;

namespace Homebrewery.Core.Documents;

/// <summary>
/// Sanitizes <c>rawHtml.html</c> (plan §8.5 rule 6) with Ganss.Xss <see cref="HtmlSanitizer"/>. Close to the
/// client's DOMPurify settings for the same node:
/// <list type="bullet">
/// <item>kept: HtmlSanitizer's default HTML tags and attributes, <c>class</c>, <c>style</c>, <c>id</c>,
/// <c>data-*</c>, <c>aria-*</c>, <c>role</c>, a static SVG subset (shapes, text, gradients, clip paths, masks,
/// patterns) and every CSS property, including custom properties such as <c>--HB_src</c>, unless its value fails
/// <see cref="CssPolicy"/>; <c>shape-outside</c>, <c>shape-margin</c> and <c>shape-image-threshold</c> too, with
/// http(s) or relative <c>url()</c>s only;</item>
/// <item>removed: <c>script</c>, <c>iframe</c>, <c>object</c>, <c>embed</c>, <c>style</c>, <c>link</c>, <c>meta</c>,
/// <c>base</c>, forms and form controls, SVG <c>use</c>/<c>foreignObject</c>/animation, every <c>on*</c> handler,
/// <c>contenteditable</c> and <c>autofocus</c>;</item>
/// <item>URLs: <c>http</c>, <c>https</c>, <c>mailto</c> and relative; <c>data:image/*</c> only in <c>img src</c>.</item>
/// </list>
/// <para>Refused (<see cref="RawHtmlResult.Error"/>): more than <see cref="MaxLength"/> characters,
/// <see cref="MaxTags"/> tags, <see cref="MaxAttributes"/> attributes on one tag or <see cref="MaxElements"/>
/// elements, elements nested deeper than <see cref="MaxDepth"/>, or a parse that runs out of its time limit.
/// AngleSharp's DOM code recurses once per nesting level, so deep HTML would overflow the stack and end the process
/// (a <see cref="StackOverflowException"/> cannot be caught), and its tree construction slows down quadratically on
/// deep nesting, many attributes on one tag and misnested formatting tags. The tag and attribute limits and the time
/// limit are checked while parsing; the depth is checked before anything walks the DOM recursively.</para>
/// Thread-safe: the settings never change after construction.
/// </summary>
public sealed partial class RawHtmlSanitizer
{
    /// <summary>Longest <c>rawHtml.html</c> accepted (characters).</summary>
    public const int MaxLength = 1024 * 1024;

    /// <summary>Most start and end tags one <c>rawHtml.html</c> may have.</summary>
    public const int MaxTags = 10_000;

    /// <summary>Most attributes one tag may have.</summary>
    public const int MaxAttributes = 256;

    /// <summary>Deepest element nesting accepted (the HTML parsers of browsers stop nesting at 512 too).</summary>
    public const int MaxDepth = 512;

    /// <summary>Most elements the parsed HTML may have (misnested formatting tags make the parser clone elements).</summary>
    public const int MaxElements = 20_000;

    /// <summary>Default <see cref="TimeLimit"/>.</summary>
    public static readonly TimeSpan DefaultTimeLimit = TimeSpan.FromSeconds(3);

    /// <summary>Shape properties AngleSharp's CSS parser does not know (so HtmlSanitizer would drop them).</summary>
    private static readonly string[] ShapeProperties = ["shape-outside", "shape-margin", "shape-image-threshold"];

    private const string TooComplex = "is too complex to check in time";

    private static readonly string[] RemovedTags =
    [
        "form", "input", "button", "select", "textarea", "option", "optgroup", "datalist", "keygen", "output",
        "html", "head", "body", "title",
    ];

    private static readonly string[] SvgTags =
    [
        "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "text", "tspan", "defs",
        "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "desc",
    ];

    private static readonly string[] SvgAttributes =
    [
        "viewBox", "xmlns", "version", "preserveAspectRatio", "d", "points", "transform", "pathLength",
        "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "fx", "fy", "offset",
        "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
        "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "stroke-miterlimit", "opacity",
        "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
        "clip-path", "clip-rule", "clipPathUnits", "mask", "maskUnits", "maskContentUnits",
        "patternUnits", "patternContentUnits", "patternTransform",
        "text-anchor", "dominant-baseline", "font-family", "font-size", "font-weight", "font-style",
        "letter-spacing", "textLength", "lengthAdjust", "vector-effect", "visibility", "display", "paint-order",
    ];

    private readonly HtmlSanitizer _sanitizer;

    /// <param name="timeLimit">The time the raw HTML of one document may take to check (<see cref="TimeLimit"/>).</param>
    /// <param name="clock">The clock the time limit is measured on (<see cref="Clock"/>). Default: the system clock.</param>
    public RawHtmlSanitizer(TimeSpan? timeLimit = null, TimeProvider? clock = null)
    {
        TimeLimit = timeLimit ?? DefaultTimeLimit;
        Clock = clock ?? TimeProvider.System;

        var options = new HtmlSanitizerOptions
        {
            AllowedTags = new HashSet<string>(HtmlSanitizerDefaults.AllowedTags, StringComparer.OrdinalIgnoreCase),
            AllowedAttributes = new HashSet<string>(HtmlSanitizerDefaults.AllowedAttributes, StringComparer.OrdinalIgnoreCase),
            AllowedCssProperties = new HashSet<string>(HtmlSanitizerDefaults.AllowedCssProperties, StringComparer.OrdinalIgnoreCase),
            AllowedAtRules = new HashSet<AngleSharp.Css.Dom.CssRuleType>(HtmlSanitizerDefaults.AllowedAtRules),
            AllowedSchemes = new HashSet<string>(["http", "https", "mailto"], StringComparer.OrdinalIgnoreCase),
            UriAttributes = new HashSet<string>(HtmlSanitizerDefaults.UriAttributes, StringComparer.OrdinalIgnoreCase),
            AllowedCssClasses = new HashSet<string>(StringComparer.Ordinal),                       // empty = any class
            AllowCssCustomProperties = true,
            AllowDataAttributes = true,
        };
        foreach (var tag in RemovedTags) options.AllowedTags.Remove(tag);
        foreach (var tag in SvgTags) options.AllowedTags.Add(tag);
        foreach (var attribute in SvgAttributes) options.AllowedAttributes.Add(attribute);
        options.AllowedAttributes.UnionWith(["class", "style", "id", "role", "title", "lang", "dir"]);
        options.AllowedAttributes.ExceptWith(["contenteditable", "autofocus"]);

        _sanitizer = new HtmlSanitizer(options);
        _sanitizer.RemovingAttribute += (_, e) =>
        {
            // aria-* has no wildcard in the options; keep them (their values are plain text).
            if (e.Reason == RemoveReason.NotAllowedAttribute
                && e.Attribute.Name.StartsWith("aria-", StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
            }
        };
        _sanitizer.RemovingStyle += (_, e) =>
        {
            // Keep properties missing from HtmlSanitizer's list (column-span, mask-image, …) as long as the value is
            // harmless. Values it removed for a bad URL or a bad character stay removed. Properties AngleSharp's CSS
            // parser does not know never get here (it drops them while parsing); see SaveShapes.
            if (e.Reason == RemoveReason.NotAllowedStyle && CssPolicy.Check($"{e.Style.Name}:{e.Style.Value}") is null)
            {
                e.Cancel = true;
            }
        };
        _sanitizer.FilterUrl += (_, e) =>
        {
            if (e.SanitizedUrl is null
                && e.Tag.LocalName.Equals("img", StringComparison.OrdinalIgnoreCase)
                && UrlPolicy.SchemeOf(e.OriginalUrl) == "data"
                && UrlPolicy.IsSafeSrc(e.OriginalUrl))
            {
                e.SanitizedUrl = e.OriginalUrl.Trim();
            }
        };
    }

    /// <summary>
    /// How long the raw HTML of one document may take to check. <see cref="DocInspector"/> shares it across all
    /// <c>rawHtml</c> nodes of a document, so a document of many small but slow fragments is refused too.
    /// </summary>
    public TimeSpan TimeLimit { get; }

    /// <summary>
    /// The clock <see cref="TimeLimit"/> is measured on: read once when a parse starts and once per token. Tests pass
    /// one that moves a fixed step per read, so the limit runs out after a known number of tokens.
    /// </summary>
    public TimeProvider Clock { get; }

    /// <summary>Sanitizes <paramref name="html"/> within <see cref="TimeLimit"/>.</summary>
    public RawHtmlResult Sanitize(string html) => Sanitize(html, TimeLimit);

    /// <summary>
    /// Sanitizes <paramref name="html"/>; returns the HTML and its text content, or why it was refused (see the
    /// class remarks).
    /// </summary>
    public RawHtmlResult Sanitize(string html, TimeSpan timeLimit)
    {
        if (html.Length > MaxLength) return RawHtmlResult.Refused($"must be at most {MaxLength / (1024 * 1024)} MB of HTML");
        if (timeLimit <= TimeSpan.Zero) return RawHtmlResult.Refused(TooComplex);

        using var dom = Parse(html, timeLimit, out var error);
        if (dom is null) return RawHtmlResult.Refused(error!);
        var body = dom.Body;
        if (body is null) return new RawHtmlResult("", "");
        if (CheckTree(body) is { } treeError) return RawHtmlResult.Refused(treeError);

        var shapes = SaveShapes(body);
        _sanitizer.SanitizeDom(dom, body);
        RestoreShapes(body, shapes);

        var output = body.ChildNodes.ToHtml(_sanitizer.OutputFormatter).Trim();
        return new RawHtmlResult(output, body.TextContent);
    }

    /// <summary>
    /// Parses <paramref name="html"/> as HtmlSanitizer does (into the body of an HTML document, with its CSS-aware
    /// parser), stopping as soon as a tag, attribute or time limit is exceeded. Null (with the reason) when stopped.
    /// </summary>
    private IHtmlDocument? Parse(string html, TimeSpan timeLimit, out string? error)
    {
        var template = _sanitizer.HtmlParserFactory();
        IBrowsingContext context;
        using (var seed = template.ParseDocument("")) context = seed.Context;

        var clock = Clock;
        var deadline = clock.GetTimestamp() + (long)(Math.Min(timeLimit.TotalSeconds, 86_400) * clock.TimestampFrequency);
        var tags = 0;
        var attributes = 0;
        var options = template.Options;
        options.ShouldEmitAttribute = (ref StructHtmlToken _, ReadOnlyMemory<char> _) => ++attributes <= MaxAttributes
            ? true
            : throw new LimitExceeded($"must have at most {MaxAttributes} attributes on one element");
        options.OnToken = (token, _) =>
        {
            attributes = 0;
            if (token.Type is HtmlTokenType.StartTag or HtmlTokenType.EndTag && ++tags > MaxTags)
            {
                throw new LimitExceeded($"must have at most {MaxTags} tags");
            }

            if (clock.GetTimestamp() > deadline) throw new LimitExceeded(TooComplex);
        };

        try
        {
            error = null;
            return new HtmlParser(options, context).ParseDocument("<!doctype html><html><body>" + html);
        }
        catch (LimitExceeded ex)
        {
            error = ex.Message;
            return null;
        }
    }

    /// <summary>Null when the tree is small and shallow enough to sanitize and serialize, else the reason. Iterative.</summary>
    private static string? CheckTree(IElement body)
    {
        var elements = 0;
        var pending = new Stack<(IElement Element, int Depth)>();
        pending.Push((body, 0));
        while (pending.Count > 0)
        {
            var (element, depth) = pending.Pop();
            if (depth > MaxDepth) return $"must not nest elements more than {MaxDepth} levels deep";
            if (++elements > MaxElements) return $"must have at most {MaxElements} elements";
            foreach (var child in element.Children) pending.Push((child, depth + 1));
            if (element is IHtmlTemplateElement template)
            {
                foreach (var child in template.Content.Children) pending.Push((child, depth + 1));
            }
        }

        return null;
    }

    /// <summary>
    /// The harmless shape declarations of each element's <c>style</c> (see <see cref="Shape"/>), before HtmlSanitizer
    /// drops them.
    /// </summary>
    private static Dictionary<IElement, List<string>> SaveShapes(IElement body)
    {
        var saved = new Dictionary<IElement, List<string>>();
        foreach (var element in body.QuerySelectorAll("[style]"))
        {
            var style = element.GetAttribute("style");
            if (style is null || !style.Contains("shape-", StringComparison.OrdinalIgnoreCase)) continue;
            var shapes = Declarations(style).Select(Shape).OfType<string>().ToList();
            if (shapes.Count > 0) saved[element] = shapes;
        }

        return saved;
    }

    /// <summary>
    /// Appends the saved shape declarations HtmlSanitizer dropped to the sanitized styles of the elements that are
    /// still there.
    /// </summary>
    private static void RestoreShapes(IElement body, Dictionary<IElement, List<string>> saved)
    {
        foreach (var (element, shapes) in saved)
        {
            if (!body.Contains(element)) continue;                      // removed with a disallowed ancestor
            var style = element.GetAttribute("style")?.Trim().TrimEnd(';').TrimEnd() ?? "";
            var present = Declarations(style).Select(d => d.Split(':')[0].Trim().ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
            var missing = shapes.Where(s => !present.Contains(s[..s.IndexOf(':')])).ToList();
            if (missing.Count == 0) continue;
            element.SetAttribute("style", string.Join("; ", style.Length > 0 ? [style, .. missing] : missing));
        }
    }

    /// <summary>The declarations of a style attribute: split at <c>;</c> outside strings and parentheses.</summary>
    private static IEnumerable<string> Declarations(string style)
    {
        var start = 0;
        var depth = 0;
        var quote = '\0';
        for (var i = 0; i < style.Length; i++)
        {
            var c = style[i];
            if (c == '\\')
            {
                i++;
            }
            else if (quote != '\0')
            {
                if (c == quote) quote = '\0';
            }
            else if (c is '"' or '\'')
            {
                quote = c;
            }
            else if (c == '(')
            {
                depth++;
            }
            else if (c == ')' && depth > 0)
            {
                depth--;
            }
            else if (c == ';' && depth == 0)
            {
                yield return style[start..i];
                start = i + 1;
            }
        }

        if (start < style.Length) yield return style[start..];
    }

    /// <summary>
    /// <paramref name="declaration"/> as <c>name: value</c> when it sets a shape property to a value that passes
    /// <see cref="CssPolicy"/> and whose <c>url()</c>s are http(s) or relative (as for other style URLs); else null.
    /// </summary>
    private static string? Shape(string declaration)
    {
        var colon = declaration.IndexOf(':');
        if (colon < 0) return null;
        var name = declaration[..colon].Trim().ToLowerInvariant();
        var value = declaration[(colon + 1)..].Trim();
        if (!ShapeProperties.Contains(name) || value.Length == 0) return null;

        var shape = $"{name}: {value}";
        if (CssPolicy.Check(shape) is not null) return null;
        foreach (Match url in CssUrl().Matches(CssPolicy.Decode(value)))
        {
            if (UrlPolicy.SchemeOf(url.Groups[2].Value) is not (null or "http" or "https")) return null;
        }

        return shape;
    }

    [GeneratedRegex(@"url\(\s*(['""]?)(.*?)\1\s*\)", RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex CssUrl();

    /// <summary>Stops the parser when a limit is exceeded.</summary>
    private sealed class LimitExceeded(string message) : Exception(message);
}

/// <param name="Html">The sanitized HTML (trimmed); empty when refused.</param>
/// <param name="Text">Its text content (for search).</param>
/// <param name="Error">Why the HTML was refused (<see cref="RawHtmlSanitizer"/> limits), or null.</param>
public readonly record struct RawHtmlResult(string Html, string Text, string? Error = null)
{
    internal static RawHtmlResult Refused(string error) => new("", "", error);
}
