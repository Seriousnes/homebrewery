using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Homebrewery.Core.Documents;

/// <summary>
/// Checks for inline style strings in documents (plan §8.5 rule 5): at most <see cref="MaxLength"/> characters
/// and none of the script-capable constructs in <see cref="BadCss"/>. The check also runs on a decoded copy
/// (CSS comments removed, <c>\6a</c>-style escapes resolved), so <c>java\73 cript:</c> and <c>expr/**/ession(</c>
/// are caught too.
/// </summary>
/// <remarks>
/// The names must stand alone, so <c>scroll-behavior</c> and a path such as <c>url(https://x/javascript:1.png)</c>
/// pass. <c>expression(</c>, <c>behavior:</c> and <c>-moz-binding</c> only count outside quoted strings
/// (<c>font-family: "Expression (Bold)"</c> passes); <c>javascript:</c> and <c>vbscript:</c> count inside them too,
/// because <c>url("javascript:…")</c> is a URL.
/// </remarks>
public static partial class CssPolicy
{
    /// <summary>Longest style string accepted on a node, mark or page object.</summary>
    public const int MaxLength = 4096;

    /// <summary>A <c>javascript:</c> or <c>vbscript:</c> URL (not a path segment such as <c>/javascript:1.png</c>).</summary>
    private const string ScriptScheme = @"(?<![\w/.-])(?:javascript|vbscript)\s*:";

    /// <summary>Script-capable CSS: IE's <c>expression()</c> and <c>behavior</c>, <c>-moz-binding</c>, script URLs.</summary>
    [GeneratedRegex(@"(?<![a-z0-9-])expression\s*\(|(?<![a-z0-9-])(?:-ms-)?behavior\s*:|-moz-binding|" + ScriptScheme,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    public static partial Regex BadCss();

    [GeneratedRegex(ScriptScheme, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ScriptUrl();

    [GeneratedRegex(@"\\(?:([0-9a-fA-F]{1,6})\s?|(.))", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex Escape();

    /// <summary>Null when <paramref name="style"/> is acceptable, otherwise the reason it is not.</summary>
    public static string? Check(string style)
    {
        if (style.Length > MaxLength) return $"must be at most {MaxLength} characters";
        var code = Tokens(style, keepStrings: false);
        var text = Tokens(style, keepStrings: true);
        if (BadCss().IsMatch(code) || BadCss().IsMatch(Unescape(code))
            || ScriptUrl().IsMatch(text) || ScriptUrl().IsMatch(Unescape(text)))
        {
            return "must not contain expression(), javascript:, vbscript:, behavior or -moz-binding";
        }

        return null;
    }

    /// <summary>The CSS text with comments removed and escapes resolved (for matching only).</summary>
    public static string Decode(string css) => Unescape(Tokens(css, keepStrings: true));

    private static string Unescape(string css) => Escape().Replace(css, m =>
    {
        if (!m.Groups[1].Success) return m.Groups[2].Value;
        var code = int.Parse(m.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return code is > 0 and <= 0x10FFFF and not (>= 0xD800 and <= 0xDFFF)
            ? char.ConvertFromUtf32(code)
            : "\uFFFD";
    }).Normalize(NormalizationForm.FormKC);

    /// <summary>
    /// The CSS text without comments, read the way CSS tokenizes it: a backslash escapes the next character, a
    /// quote starts a string that ends at the same quote or an unescaped newline, and <c>/*</c> inside a string is
    /// text. With <paramref name="keepStrings"/> false the strings' contents are dropped (the quotes stay).
    /// </summary>
    private static string Tokens(string css, bool keepStrings)
    {
        var sb = new StringBuilder(css.Length);
        for (var i = 0; i < css.Length; i++)
        {
            var c = css[i];
            if (c == '\\')
            {
                sb.Append(c);
                if (i + 1 < css.Length) sb.Append(css[++i]);
            }
            else if (c == '/' && i + 1 < css.Length && css[i + 1] == '*')
            {
                var end = css.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = end < 0 ? css.Length : end + 1;
            }
            else if (c is '"' or '\'')
            {
                var start = i;
                for (i++; i < css.Length && css[i] != c && css[i] is not ('\n' or '\r' or '\f'); i++)
                {
                    if (css[i] == '\\') i++;
                }

                if (keepStrings) sb.Append(css, start, Math.Min(i + 1, css.Length) - start);
                else sb.Append(c).Append(c);
            }
            else
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }
}
