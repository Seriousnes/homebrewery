using System.Net;
using System.Text.RegularExpressions;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Tests.Brews;
using Homebrewery.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Tests.Share;

/// <summary>
/// P2.7 ShareShell (plan §8.8): <c>GET /share/{shareId}</c> is the SPA's index.html with HTML-encoded link-preview tags.
/// Uses a fixture index.html in a temporary web root, never the real wwwroot.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed partial class ShareShellTests(ApiFixture api, ShareShellTests.IndexWebRoot webRoot)
    : IClassFixture<ShareShellTests.IndexWebRoot>
{
    private const string HostileTitle = "</script><script>alert(\"t\")</script>";
    private const string HostileDescription = "He said \"hi\" & 'bye' <b>bold</b></script><script>alert(1)</script>";
    private const string HostileThumbnail = "https://img.example/a.png?x=\"><script>alert('i')</script>";

    private WebApplicationFactory<Program> Factory => webRoot.FactoryFor(api);

    [Fact]
    public async Task Preview_values_are_html_encoded()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct, title: "placeholder", description: "placeholder");
        await Factory.UpdateAsync(brew.ShareId, s => s
            .SetProperty(b => b.Title, HostileTitle)
            .SetProperty(b => b.Description, HostileDescription)
            .SetProperty(b => b.ThumbnailUrl, HostileThumbnail), ct);
        using var anonymous = Factory.CreateClient();

        using var response = await anonymous.GetAsync($"/share/{brew.ShareId}", ct);
        var html = await response.Content.ReadAsStringAsync(ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);

        // Nothing the brew supplied survives unencoded: no new script elements, no attribute break-outs.
        Assert.Equal(1, Count(html, "<script"));                                   // the template's module script only
        Assert.DoesNotContain("</script><script>", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("\"><script", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("'bye'", html, StringComparison.Ordinal);
        Assert.Contains("&lt;/script&gt;&lt;script&gt;", html, StringComparison.Ordinal);
        Assert.Contains("&quot;hi&quot;", html, StringComparison.Ordinal);

        // ...and each tag decodes back to exactly the stored value.
        var tags = MetaTags(html);
        Assert.Equal($"{HostileTitle} - {owner.Handle}", tags["og:title"]);
        Assert.Equal(HostileDescription, tags["og:description"]);
        Assert.Equal(HostileThumbnail, tags["og:image"]);
        Assert.Equal("article", tags["og:type"]);
        Assert.Equal(ShareShell.SiteName, tags["og:site_name"]);
        Assert.Equal($"http://localhost/share/{brew.ShareId}", tags["og:url"]);
        Assert.Equal("summary_large_image", tags["twitter:card"]);
        Assert.Equal(tags["og:title"], tags["twitter:title"]);
        Assert.Equal(HostileDescription, tags["twitter:description"]);
        Assert.Equal(HostileThumbnail, tags["twitter:image"]);
        Assert.Equal(HostileDescription, tags["description"]);
        Assert.Equal($"{HostileTitle} - {ShareShell.SiteName}", WebUtility.HtmlDecode(TitleText().Match(html).Groups[1].Value));
    }

    [Fact]
    public async Task The_rest_of_the_page_is_the_template()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct, title: "Tavern Guide", description: "Food & drink");
        using var anonymous = Factory.CreateClient();

        var html = await anonymous.GetStringAsync($"/share/{brew.ShareId}", ct);

        Assert.Contains(IndexWebRoot.Marker, html, StringComparison.Ordinal);
        Assert.Contains(IndexWebRoot.ModuleScript, html, StringComparison.Ordinal);
        Assert.DoesNotContain("Template title", html, StringComparison.Ordinal);          // template previews replaced
        Assert.DoesNotContain("Template description", html, StringComparison.Ordinal);
        Assert.Equal(1, Count(html, "og:title"));
        Assert.Equal(1, Count(html, "<title>"));
        Assert.Contains("<title>Tavern Guide - The Homebrewery</title>", html, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"og:description\" content=\"Food &amp; drink\" />", html, StringComparison.Ordinal);
        Assert.True(html.IndexOf("og:title", StringComparison.Ordinal) < html.IndexOf("</head>", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Without_description_or_thumbnail_the_tags_use_defaults()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct, title: "Plain");
        await Factory.UpdateAsync(brew.ShareId, s => s.SetProperty(b => b.Title, ""), ct);
        using var anonymous = Factory.CreateClient();

        var tags = MetaTags(await anonymous.GetStringAsync($"/share/{brew.ShareId}", ct));

        Assert.Equal($"Untitled Brew - {owner.Handle}", tags["og:title"]);
        Assert.Equal("No description.", tags["og:description"]);
        Assert.False(tags.ContainsKey("og:image"));
        Assert.Equal("summary", tags["twitter:card"]);
    }

    [Fact]
    public async Task The_shell_does_not_count_views()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await Factory.CreateUserAsync(ct: ct);
        var brew = await TestBrews.CreateAsync(owner.Client, ct);
        using var anonymous = Factory.CreateClient();

        using var response = await anonymous.GetAsync($"/share/{brew.ShareId}", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, await Factory.WithDbAsync(db => db.Brews.Where(b => b.ShareId == brew.ShareId).Select(b => b.Views).SingleAsync(ct)));
    }

    [Theory]
    [InlineData("noSuchBrew12")]
    [InlineData("x")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public async Task Unknown_ids_get_the_plain_index(string shareId)
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = Factory.CreateClient();

        using var response = await client.GetAsync($"/share/{shareId}", ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(IndexWebRoot.Template, await response.Content.ReadAsStringAsync(ct));
    }

    [Fact]
    public async Task Locked_brews_get_the_plain_index()
    {
        var ct = TestContext.Current.CancellationToken;
        using var owner = await Factory.CreateUserAsync(ct: ct);
        var title = TestBrews.Token();
        var brew = await TestBrews.CreateAsync(owner.Client, ct, title: title);
        await Factory.LockAsync(brew.ShareId, ct);
        using var anonymous = Factory.CreateClient();

        var html = await anonymous.GetStringAsync($"/share/{brew.ShareId}", ct);

        Assert.Equal(IndexWebRoot.Template, html);
        Assert.DoesNotContain(title, html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Without_an_index_the_share_route_is_404()
    {
        var ct = TestContext.Current.CancellationToken;
        using var client = api.Factory.CreateClient();                      // the shared host's web root is empty

        using var response = await client.GetAsync("/share/noSuchBrew12", ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public void Dollar_signs_in_titles_are_literal()
    {
        var html = ShareShell.Inject(IndexWebRoot.Template,
            new ShareShell.Preview("Costs $0, $1 and $&", "", null, false, null), "http://localhost/share/x");

        Assert.Contains("<title>Costs $0, $1 and $&amp; - The Homebrewery</title>", html, StringComparison.Ordinal);
    }

    [Fact]
    public void Pages_without_a_head_are_returned_unchanged()
    {
        const string html = "<html><body>no head</body></html>";

        Assert.Equal(html, ShareShell.Inject(html, new ShareShell.Preview("T", "D", null, false, "o"), "http://x/share/y"));
    }

    private static Dictionary<string, string> MetaTags(string html) =>
        MetaTag().Matches(html).ToDictionary(m => m.Groups[1].Value, m => WebUtility.HtmlDecode(m.Groups[2].Value));

    private static int Count(string html, string value) =>
        Regex.Matches(html, Regex.Escape(value), RegexOptions.IgnoreCase).Count;

    [GeneratedRegex("""<meta (?:property|name)="([^"]+)" content="([^"]*)" />""")]
    private static partial Regex MetaTag();

    [GeneratedRegex("<title>([^<]*)</title>")]
    private static partial Regex TitleText();

    /// <summary>A temporary web root with a fixture index.html, and one host serving it.</summary>
    public sealed class IndexWebRoot : IAsyncDisposable
    {
        public const string Marker = "<!-- share-shell-fixture -->";
        public const string ModuleScript = "<script type=\"module\" crossorigin src=\"/static/index-fixture.js\"></script>";

        public const string Template = $"""
            <!doctype html>
            <html lang="en">
              <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <meta property="og:title" content="Template title" />
                <meta name="description" content="Template description" />
                <title>The Homebrewery</title>
                {ModuleScript}
              </head>
              <body><div id="root"></div>{Marker}</body>
            </html>
            """;

        private readonly DirectoryInfo _webRoot = Directory.CreateTempSubdirectory("homebrewery-share-wwwroot-");
        private WebApplicationFactory<Program>? _factory;

        public IndexWebRoot() => File.WriteAllText(Path.Combine(_webRoot.FullName, "index.html"), Template);

        public WebApplicationFactory<Program> FactoryFor(ApiFixture api) =>
            _factory ??= api.Factory.WithWebHostBuilder(b => b.UseWebRoot(_webRoot.FullName));

        public async ValueTask DisposeAsync()
        {
            if (_factory is not null) await _factory.DisposeAsync();
            _webRoot.Delete(recursive: true);
        }
    }
}
