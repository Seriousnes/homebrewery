using System.Text.Json;
using System.Text.RegularExpressions;
using Homebrewery.Core;
using Homebrewery.Core.Documents;

namespace Homebrewery.Api.Brews;

/// <summary>Limits and validation for brew fields other than the document (which is <see cref="DocInspector"/>'s job).</summary>
public static partial class BrewRules
{
    /// <summary>Request body cap for brew writes, compressed and decompressed (plan §8.4).</summary>
    public const long MaxRequestBytes = 20 * 1024 * 1024;

    public const int MaxTitle = 100;                // upstream MAX_TITLE_LENGTH
    public const int MaxDescription = 500;          // upstream metadata validation
    public const int MaxTags = 50;
    public const int MaxTag = 100;
    public const int MaxThumbnailUrl = 256;         // upstream metadata validation
    public const int MaxAuthors = 50;
    public const int MaxStyle = 2 * 1024 * 1024;
    public const int MaxSnippets = 2 * 1024 * 1024;
    public const int MaxSourceMarkdown = 10 * 1024 * 1024;

    public const string DefaultLang = "en";
    public const string DefaultTheme = "5ePHB";

    /// <summary>A new brew's document: one empty page.</summary>
    public const string EmptyDoc = """{"type":"doc","content":[{"type":"page","content":[{"type":"paragraph"}]}]}""";

    /// <summary>Upstream's language rule: <c>en</c>, <c>pt-BR</c>, <c>zh-Hant</c>, <c>es-419</c>.</summary>
    [GeneratedRegex(@"\A[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-(?:[0-9]{3}|[a-zA-Z]{2}))?\z", RegexOptions.CultureInvariant)]
    private static partial Regex Lang();

    /// <summary>A static theme key or a user theme's share id.</summary>
    [GeneratedRegex(@"\A[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex Theme();

    /// <summary>
    /// Applies <paramref name="input"/> to <paramref name="current"/> (null fields keep the current value) and
    /// validates the result. Errors are added under <c>meta.*</c>. The title fallback is applied by the caller.
    /// </summary>
    public static BrewMeta Merge(BrewMeta current, BrewMetaInput? input, IDictionary<string, string[]> errors)
    {
        if (input is null) return current;

        var title = input.Title is null ? current.Title : StoredText.Clean(input.Title).Trim();
        if (title.Length > MaxTitle) Add(errors, "meta.title", $"must be at most {MaxTitle} characters");

        var description = input.Description is null ? current.Description : StoredText.Clean(input.Description).Trim();
        if (description.Length > MaxDescription) Add(errors, "meta.description", $"must be at most {MaxDescription} characters");

        var tags = input.Tags is null ? current.Tags : NormalizeTags(input.Tags, errors);

        var lang = input.Lang is null ? current.Lang : input.Lang.Trim();
        if (lang.Length == 0) lang = DefaultLang;
        if (!Lang().IsMatch(lang)) Add(errors, "meta.lang", "must be a language code such as en, pt-BR or zh-Hant");

        var theme = input.Theme is null ? current.Theme : input.Theme.Trim();
        if (theme.Length == 0) theme = DefaultTheme;
        if (!Theme().IsMatch(theme)) Add(errors, "meta.theme", "must be a theme key or a user theme's share id");

        var thumbnail = input.ThumbnailUrl is null ? current.ThumbnailUrl : input.ThumbnailUrl.Trim();
        if (thumbnail is { Length: 0 }) thumbnail = null;
        if (thumbnail is not null && !IsThumbnailUrl(thumbnail))
        {
            Add(errors, "meta.thumbnailUrl", $"must be an absolute http(s) URL of at most {MaxThumbnailUrl} characters");
        }

        return new BrewMeta(title, description, tags, lang, theme, input.Published ?? current.Published, thumbnail);
    }

    /// <summary>The title to store: <paramref name="title"/>, or the first heading when it is blank.</summary>
    public static string TitleOrFallback(string title, string? firstHeading) =>
        title.Length > 0 ? title : (firstHeading ?? "");

    /// <summary>Metadata of a brand-new brew before the request is applied.</summary>
    public static BrewMeta Defaults { get; } = new("", "", [], DefaultLang, DefaultTheme, false, null);

    /// <summary>Checks user CSS; returns it cleaned (storable), or null with an error added.</summary>
    public static string? Style(string? style, IDictionary<string, string[]> errors)
    {
        var clean = StoredText.Clean(style ?? "");
        if (clean.Length <= MaxStyle) return clean;
        Add(errors, "style", $"must be at most {MaxStyle / (1024 * 1024)} MB");
        return null;
    }

    /// <summary>Checks snippets (a JSON array or null); returns the JSON to store.</summary>
    public static string? Snippets(JsonElement? snippets, IDictionary<string, string[]> errors)
    {
        if (snippets is not { } element || element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (element.ValueKind != JsonValueKind.Array)
        {
            Add(errors, "snippets", "must be a JSON array or null");
            return null;
        }

        var json = StoredText.ToNode(element)!.ToJsonString();
        if (json.Length <= MaxSnippets) return json;
        Add(errors, "snippets", $"must be at most {MaxSnippets / (1024 * 1024)} MB");
        return null;
    }

    public static string? SourceMarkdown(string? markdown, IDictionary<string, string[]> errors)
    {
        if (markdown is null) return null;
        var clean = StoredText.Clean(markdown);
        if (clean.Length <= MaxSourceMarkdown) return clean;
        Add(errors, "sourceMarkdown", $"must be at most {MaxSourceMarkdown / (1024 * 1024)} MB");
        return null;
    }

    /// <summary>The server's document schema version; a request may only name that one.</summary>
    public static void CheckDocSchemaVersion(int? requested, SchemaManifest manifest, IDictionary<string, string[]> errors)
    {
        if (requested is { } version && version != manifest.DocSchemaVersion)
        {
            Add(errors, "docSchemaVersion",
                $"the server stores documents of schema version {manifest.DocSchemaVersion}; migrate the document first");
        }
    }

    /// <summary>
    /// Lists longer than this many times their limit are refused before they are read: duplicates and blanks may
    /// make a list look longer than it is, but not this much longer.
    /// </summary>
    private const int ListSlack = 4;

    /// <summary>
    /// Normalized, de-duplicated handles in order, or null (with errors) when one is not a valid handle or there
    /// are too many. Only the first invalid handle is reported.
    /// </summary>
    public static IReadOnlyList<string>? NormalizeHandles(IReadOnlyList<string> handles, IDictionary<string, string[]> errors)
    {
        var tooMany = $"a brew has at most {MaxAuthors} authors";
        if (handles.Count > MaxAuthors * ListSlack)
        {
            Add(errors, "meta.authors", tooMany);
            return null;
        }

        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in handles)
        {
            // JSON binding keeps null list entries ("authors":[null]).
            if (raw is null)
            {
                Add(errors, "meta.authors", "authors must be handles, not null");
                return null;
            }

            var handle = Handles.Normalize(raw);
            if (!Handles.IsValid(handle))
            {
                Add(errors, "meta.authors", $"'{StoredText.Clean(raw)}' is not a valid handle. {Handles.Rules}");
                return null;
            }

            if (seen.Add(handle)) result.Add(handle);
        }

        if (result.Count > MaxAuthors) Add(errors, "meta.authors", tooMany);
        return errors.ContainsKey("meta.authors") ? null : result;
    }

    public static void Add(IDictionary<string, string[]> errors, string key, string message) =>
        errors[key] = errors.TryGetValue(key, out var existing) ? [.. existing, message] : [message];

    private static IReadOnlyList<string> NormalizeTags(IReadOnlyList<string> tags, IDictionary<string, string[]> errors)
    {
        var tooMany = $"a brew has at most {MaxTags} tags";
        if (tags.Count > MaxTags * ListSlack)
        {
            Add(errors, "meta.tags", tooMany);
            return [];
        }

        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var tooLong = false;
        foreach (var raw in tags)
        {
            var tag = StoredText.Clean(raw ?? "").Trim();
            if (tag.Length == 0 || seen.Contains(tag)) continue;
            if (tag.Length > MaxTag)
            {
                tooLong = true;
                continue;
            }

            seen.Add(tag);
            result.Add(tag);
        }

        if (tooLong) Add(errors, "meta.tags", $"tags must be at most {MaxTag} characters");
        if (result.Count > MaxTags) Add(errors, "meta.tags", tooMany);
        return result;
    }

    private static bool IsThumbnailUrl(string url) =>
        url.Length <= MaxThumbnailUrl
        && Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);
}
