namespace Homebrewery.Core.Documents;

/// <summary>
/// Which URLs a document may contain (plan §8.5 rule 4). Allowed:
/// <list type="bullet">
/// <item>links (<c>link.href</c>): <c>http:</c>, <c>https:</c>, <c>mailto:</c>, relative URLs and <c>#anchors</c>;</item>
/// <item>sources (<c>image.src</c>, page object <c>src</c>): <c>http:</c>, <c>https:</c>, relative URLs and
/// <c>data:image/*</c>.</item>
/// </list>
/// Everything else with a scheme (<c>javascript:</c>, <c>vbscript:</c>, <c>data:text/html</c>, <c>file:</c>, …) is
/// rejected, and so is any URL longer than <see cref="MaxLength"/>.
/// </summary>
/// <remarks>
/// <para>The scheme is read after removing, anywhere in the URL, the characters the client's
/// <c>IGNORED_URL_CHARS</c> removes (web/src/editor/schema/html.ts: C0 controls, DEL and JavaScript's <c>\s</c>), so
/// <c>" java\tscript:"</c> counts as <c>javascript:</c>. Browsers only strip C0 controls and spaces at the ends and
/// tabs and newlines inside, so removing more can only turn a would-be relative URL into a rejected one.</para>
/// <para>shared/url-policy-cases.json holds the cases both sides must agree on: UrlPolicyTests runs them here and
/// web/src/editor/schema/urlPolicy.shared.test.ts runs them against the client's <c>isSafeHref</c>/<c>isSafeSrc</c>.</para>
/// </remarks>
public static class UrlPolicy
{
    /// <summary>Longest URL accepted, in UTF-16 code units (a data: image can be large, but the document limit still applies).</summary>
    public const int MaxLength = 2 * 1024 * 1024;

    /// <summary>True when <paramref name="url"/> may be a link target.</summary>
    public static bool IsSafeHref(string url) => url.Length <= MaxLength && SchemeOf(url) is null or "http" or "https" or "mailto";

    /// <summary>True when <paramref name="url"/> may be an image source.</summary>
    public static bool IsSafeSrc(string url) => url.Length <= MaxLength && SchemeOf(url) switch
    {
        null or "http" or "https" => true,
        "data" => IsDataImage(url),
        _ => false,
    };

    /// <summary>
    /// The lower-case scheme of <paramref name="url"/> (<c>[A-Za-z][A-Za-z0-9+.-]*</c> before the first <c>:</c>), or
    /// null for a relative URL. Ignored characters (<see cref="IsIgnored"/>) are skipped wherever they are, and the
    /// scheme may be any length.
    /// </summary>
    public static string? SchemeOf(string url)
    {
        var start = -1;
        var length = 0;
        foreach (var (c, i) in Significant(url))
        {
            if (start < 0)
            {
                if (!char.IsAsciiLetter(c)) return null;
                start = i;
            }
            else if (c == ':')
            {
                return Collect(url, start, length);
            }
            else if (!(char.IsAsciiLetterOrDigit(c) || c is '+' or '-' or '.'))
            {
                return null;
            }

            length++;
        }

        return null;
    }

    /// <summary>
    /// The characters the client's <c>IGNORED_URL_CHARS</c> (<c>/[\u0000-\u001F\u007F\s]+/g</c>) removes: C0 controls,
    /// DEL and ECMAScript white space and line terminators, which include U+FEFF but, unlike
    /// <see cref="char.IsWhiteSpace(char)"/>, not U+0085.
    /// </summary>
    public static bool IsIgnored(char c) => c switch
    {
        <= ' ' or '\u007F' => true,                                   // C0 controls, space, DEL
        '\u00A0' or '\u1680' or (>= '\u2000' and <= '\u200A') => true,   // other space separators (Zs)
        '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' => true,
        _ => false,
    };

    private static bool IsDataImage(string url)
    {
        const string prefix = "data:image/";
        var matched = 0;
        foreach (var (c, _) in Significant(url))
        {
            if (AsciiLower(c) != prefix[matched]) return false;
            if (++matched == prefix.Length) return true;
        }

        return false;
    }

    /// <summary>ASCII-only lower case, like a JavaScript <c>/i</c> regex without the <c>u</c> flag (<c>İ</c> is not <c>i</c>).</summary>
    private static char AsciiLower(char c) => char.IsAsciiLetterUpper(c) ? (char)(c + ('a' - 'A')) : c;

    /// <summary>The characters of <paramref name="url"/> that are not <see cref="IsIgnored"/>, with their index.</summary>
    private static IEnumerable<(char C, int Index)> Significant(string url)
    {
        for (var i = 0; i < url.Length; i++)
        {
            if (!IsIgnored(url[i])) yield return (url[i], i);
        }
    }

    /// <summary>The <paramref name="length"/> significant characters from <paramref name="start"/>, lower-cased.</summary>
    private static string Collect(string url, int start, int length) => string.Create(length, (url, start), static (span, state) =>
    {
        var j = 0;
        for (var i = state.start; j < span.Length; i++)
        {
            if (!IsIgnored(state.url[i])) span[j++] = AsciiLower(state.url[i]);
        }
    });
}
