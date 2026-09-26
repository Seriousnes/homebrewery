using System.Text;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// <c>GET /share/{shareId}</c> (plan §8.8): the SPA's index.html with link-preview tags (Open Graph and Twitter card)
/// for the brew, so chat apps and social sites show its title, description and thumbnail. Every value is HTML-encoded
/// (<see cref="HtmlEncoder.Default"/>); upstream wrote them unescaped. No page props are injected: the SPA loads the
/// brew from <c>/api/brews/share/{shareId}</c>, which is also what counts the view.
/// </summary>
/// <remarks>
/// Unknown and locked brews get the plain index.html (the SPA shows its not-found or lock page). Without an index
/// (no web build and no dev server, see <see cref="SpaIndex"/>) the answer is 404.
/// </remarks>
public static partial class ShareShell
{
    public const string SiteName = "The Homebrewery";

    /// <summary>Longest share id looked up; anything longer cannot be a brew.</summary>
    private const int MaxShareId = 64;

    public static async Task<IResult> RenderAsync(
        string shareId, HttpContext context, SpaIndex index, AppDbContext db, CancellationToken ct)
    {
        var html = await index.GetAsync(ct);
        if (html is null) return Results.NotFound();

        context.Response.Headers.CacheControl = "no-cache";
        if (shareId.Length > MaxShareId) return Html(html);

        var brew = await db.Brews.AsNoTracking()
            .Where(b => b.ShareId == shareId)
            .Select(b => new Preview(
                b.Title,
                b.Description,
                b.ThumbnailUrl,
                b.Lock != null,
                b.Authors.Where(a => a.Role == AuthorRole.Owner).Select(a => a.User!.Handle).FirstOrDefault()))
            .SingleOrDefaultAsync(ct);
        if (brew is null || brew.Locked) return Html(html);

        var url = $"{context.Request.Scheme}://{context.Request.Host.ToUriComponent()}/share/{Uri.EscapeDataString(shareId)}";
        return Html(Inject(html, brew, url));
    }

    /// <summary>
    /// <paramref name="html"/> with the brew's preview tags before <c>&lt;/head&gt;</c>, its <c>&lt;title&gt;</c> set to the
    /// brew title, and any existing <c>og:*</c>, <c>twitter:*</c> and description meta tags removed.
    /// </summary>
    internal static string Inject(string html, Preview brew, string url)
    {
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        if (headEnd < 0) return html;

        var title = string.IsNullOrWhiteSpace(brew.Title) ? "Untitled Brew" : brew.Title.Trim();
        var ogTitle = brew.Owner is { Length: > 0 } owner ? $"{title} - {owner}" : title;
        var description = string.IsNullOrWhiteSpace(brew.Description) ? "No description." : brew.Description.Trim();
        var image = brew.ThumbnailUrl is { Length: > 0 } thumbnail ? thumbnail : null;

        var tags = new StringBuilder();
        Meta(tags, "name", "description", description);
        Meta(tags, "property", "og:site_name", SiteName);
        Meta(tags, "property", "og:type", "article");
        Meta(tags, "property", "og:title", ogTitle);
        Meta(tags, "property", "og:description", description);
        Meta(tags, "property", "og:url", url);
        if (image is not null) Meta(tags, "property", "og:image", image);
        Meta(tags, "name", "twitter:card", image is null ? "summary" : "summary_large_image");
        Meta(tags, "name", "twitter:title", ogTitle);
        Meta(tags, "name", "twitter:description", description);
        if (image is not null) Meta(tags, "name", "twitter:image", image);

        var head = PreviewMeta().Replace(html[..headEnd], "");
        var titleElement = $"<title>{Encode($"{title} - {SiteName}")}</title>";
        head = TitleElement().Replace(head, _ => titleElement, 1);                // an evaluator: "$" is literal
        return head + tags + html[headEnd..];
    }

    private static void Meta(StringBuilder tags, string attribute, string key, string value) =>
        tags.Append("    <meta ").Append(attribute).Append("=\"").Append(key).Append("\" content=\"")
            .Append(Encode(value)).Append("\" />\n");

    private static string Encode(string value) => HtmlEncoder.Default.Encode(value);

    private static IResult Html(string html) => Results.Content(html, "text/html; charset=utf-8", Encoding.UTF8);

    /// <summary>Existing preview meta tags in the template (they would duplicate the brew's).</summary>
    [GeneratedRegex("""<meta\s[^>]*(?:property|name)\s*=\s*["']?(?:og:|twitter:|description["'\s/>])[^>]*>\s*""",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PreviewMeta();

    [GeneratedRegex(@"<title>[^<]*</title>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TitleElement();

    internal sealed record Preview(string Title, string Description, string? ThumbnailUrl, bool Locked, string? Owner);
}
