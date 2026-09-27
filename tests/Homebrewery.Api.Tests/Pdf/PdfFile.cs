using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Homebrewery.Api.Tests.Pdf;

/// <summary>
/// Just enough PDF reading for the renderer tests. Chromium writes page, image and font dictionaries as plain objects
/// (only content streams are compressed), so a Latin-1 view of the file finds them.
/// </summary>
internal sealed partial class PdfFile(byte[] bytes)
{
    private readonly string _text = Encoding.Latin1.GetString(bytes);

    public bool IsPdf => _text.StartsWith("%PDF-", StringComparison.Ordinal);

    /// <summary>Page objects (<c>/Type /Page</c>, not <c>/Pages</c>).</summary>
    public int PageCount => PageRegex().Count(_text);

    /// <summary>Width and height in points of each page's MediaBox.</summary>
    public IReadOnlyList<(double Width, double Height)> MediaBoxes => MediaBoxRegex().Matches(_text)
        .Select(m => (Number(m.Groups[3]) - Number(m.Groups[1]), Number(m.Groups[4]) - Number(m.Groups[2])))
        .ToList();

    public int ImageCount => ImageRegex().Count(_text);

    /// <summary>Embedded font names without the subset prefix (<c>ABCDEF+OpenSans</c> → <c>OpenSans</c>).</summary>
    public IReadOnlyList<string> FontNames => FontRegex().Matches(_text).Select(m => m.Groups[1].Value).Distinct().ToList();

    public bool HasOutline => _text.Contains("/Outlines", StringComparison.Ordinal);

    private static double Number(Group g) => double.Parse(g.Value, CultureInfo.InvariantCulture);

    [GeneratedRegex(@"/Type\s*/Page(?![a-zA-Z])")]
    private static partial Regex PageRegex();

    [GeneratedRegex(@"/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]")]
    private static partial Regex MediaBoxRegex();

    [GeneratedRegex(@"/Subtype\s*/Image")]
    private static partial Regex ImageRegex();

    [GeneratedRegex(@"/BaseFont\s*/(?:[A-Z]{6}\+)?([^\s/\]>]+)")]
    private static partial Regex FontRegex();
}
