using System.Text.Json;
using System.Text.Json.Serialization;
using Homebrewery.Api.Brews;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Homebrewery.Api.Themes;

/// <summary>Response of <c>GET /api/themes</c>: every theme the caller can pick.</summary>
/// <param name="Static">The built-in themes, as in <c>/themes/themes.json</c>.</param>
/// <param name="User">User themes (brews tagged <c>meta:theme</c>): the caller's own first (published or not), then
/// published ones, each group by name. At most 500.</param>
public sealed record ThemeList(IReadOnlyList<ThemeCatalogEntry> Static, IReadOnlyList<UserThemeInfo> User);

/// <summary>A user theme: a brew tagged <c>meta:theme</c>, used as a theme by its share id.</summary>
/// <param name="ShareId">The theme id to store in a brew's <c>meta.theme</c>.</param>
/// <param name="Name">The theme brew's title.</param>
/// <param name="Author">Handle of the theme brew's owner, or null.</param>
/// <param name="BaseTheme">The theme this one builds on (the theme brew's own <c>meta.theme</c>): a static key or
/// another user theme's share id.</param>
/// <param name="ThumbnailUrl">The theme brew's thumbnail, or null.</param>
/// <param name="Published">Whether the theme brew is published (listed for everyone).</param>
/// <param name="Mine">Whether the caller is an owner or author of the theme brew.</param>
public sealed record UserThemeInfo(
    string ShareId,
    string Name,
    string? Author,
    string BaseTheme,
    string? ThumbnailUrl,
    bool Published,
    bool Mine,
    DateTimeOffset UpdatedAt);

/// <summary>
/// Response of <c>GET /api/themes/{theme}/bundle</c> (plan §8.7): the theme's inheritance chain, root first. Apply
/// <c>styles</c> in order, then the brew's own CSS.
/// </summary>
/// <param name="Theme">The theme that was asked for.</param>
/// <param name="Name">Display name of that theme (a static theme's name or a user theme's title).</param>
/// <param name="Author">Owner handle of that theme when it is a user theme; otherwise null.</param>
/// <param name="Styles">Stylesheets, root first: the scoped URL of each static theme, then each user theme's CSS
/// (raw: the client scopes it to the canvas, like user CSS). User themes without CSS add nothing.</param>
/// <param name="Snippets">Snippet sources, root first: a static theme's snippet group id (<c>V3_5ePHB</c>), or a user
/// theme's snippets as <c>{ name, snippets }</c>. User themes without snippets add nothing.</param>
public sealed record ThemeBundle(
    string Theme,
    string Name,
    string? Author,
    IReadOnlyList<ThemeStyle> Styles,
    IReadOnlyList<ThemeSnippetRef> Snippets);

/// <summary>One stylesheet of a theme chain: <c>{ kind: 'url', href }</c> or <c>{ kind: 'css', css, shareId }</c>.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(ThemeStyleUrl), "url")]
[JsonDerivedType(typeof(ThemeStyleCss), "css")]
public abstract record ThemeStyle;

/// <summary>A static theme's stylesheet (already scoped under <c>.hb-canvas</c>).</summary>
/// <param name="Href">Site-relative URL, e.g. <c>/themes/V3/Blank/style.scoped.css</c>.</param>
public sealed record ThemeStyleUrl(string Href) : ThemeStyle;

/// <summary>A user theme's CSS, unscoped.</summary>
/// <param name="Css">The theme brew's CSS as stored.</param>
/// <param name="ShareId">The user theme it came from.</param>
public sealed record ThemeStyleCss(string Css, string ShareId) : ThemeStyle;

/// <summary>
/// A snippet source in a theme bundle. In JSON it is either a string (a static theme's snippet group id, e.g.
/// <c>V3_5ePHB</c>) or an object <c>{ name, snippets }</c> (a user theme's name and its snippets array).
/// </summary>
[JsonConverter(typeof(ThemeSnippetRefConverter))]
public sealed record ThemeSnippetRef
{
    private ThemeSnippetRef(string? group, string? name, RawJson? snippets)
    {
        Group = group;
        Name = name;
        Snippets = snippets;
    }

    /// <summary>A static theme's snippet group id, or null for a user theme's snippets.</summary>
    public string? Group { get; }

    /// <summary>The user theme's name, or null for a snippet group.</summary>
    public string? Name { get; }

    /// <summary>The user theme's snippets (JSON array as stored), or null for a snippet group.</summary>
    public RawJson? Snippets { get; }

    public static ThemeSnippetRef ForGroup(string group) => new(group, null, null);

    public static ThemeSnippetRef ForUserTheme(string name, RawJson snippets) => new(null, name, snippets);
}

public sealed class ThemeSnippetRefConverter : JsonConverter<ThemeSnippetRef>
{
    public override ThemeSnippetRef Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String) return ThemeSnippetRef.ForGroup(reader.GetString()!);
        using var document = JsonDocument.ParseValue(ref reader);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String
            || !root.TryGetProperty("snippets", out var snippets))
        {
            throw new JsonException("A theme snippet reference is a string or an object { name, snippets }.");
        }

        return ThemeSnippetRef.ForUserTheme(name.GetString()!, new RawJson(snippets.GetRawText()));
    }

    public override void Write(Utf8JsonWriter writer, ThemeSnippetRef value, JsonSerializerOptions options)
    {
        if (value.Group is { } group)
        {
            writer.WriteStringValue(group);
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("name", value.Name);
        writer.WritePropertyName("snippets");
        writer.WriteRawValue(value.Snippets?.Json ?? "null", skipInputValidation: true);
        writer.WriteEndObject();
    }
}

/// <summary>
/// Completes the bundle schemas for the generated web client:
/// <list type="bullet">
/// <item><see cref="ThemeSnippetRef"/> becomes a component <c>oneOf: [string, { name: string, snippets: any }]</c> and
/// <c>ThemeBundle.snippets</c> an array of it. This needs a document transformer: the type has a custom converter, so
/// its inferred schema is "any value", which JSON Schema writes as a missing <c>items</c>, leaving no element schema
/// for a schema transformer to change.</item>
/// <item>The discriminator <c>kind</c> is required in each <see cref="ThemeStyle"/> variant (it is always written).</item>
/// </list>
/// </summary>
internal sealed class ThemeBundleDocumentTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        var schemas = document.Components?.Schemas;
        if (schemas is null) return Task.CompletedTask;

        if (schemas.TryGetValue(nameof(ThemeStyle), out var style) && style.Discriminator is { } discriminator)
        {
            foreach (var variant in discriminator.Mapping?.Values ?? [])
            {
                if (variant.Reference.Id is { } id && schemas.TryGetValue(id, out var target) && target is OpenApiSchema schema)
                {
                    schema.Required ??= new HashSet<string>();
                    schema.Required.Add(discriminator.PropertyName ?? "kind");
                }
            }
        }

        if (!schemas.TryGetValue(nameof(ThemeBundle), out var bundle)
            || bundle.Properties?.TryGetValue("snippets", out var snippets) != true
            || snippets is not OpenApiSchema list)
        {
            return Task.CompletedTask;
        }

        schemas[nameof(ThemeSnippetRef)] = new OpenApiSchema
        {
            Description = "A static theme's snippet group id (e.g. \"V3_5ePHB\"), or a user theme's name and snippets.",
            OneOf =
            [
                new OpenApiSchema { Type = JsonSchemaType.String },
                new OpenApiSchema
                {
                    Type = JsonSchemaType.Object,
                    Required = new HashSet<string> { "name", "snippets" },
                    Properties = new Dictionary<string, IOpenApiSchema>
                    {
                        ["name"] = new OpenApiSchema { Type = JsonSchemaType.String },
                        ["snippets"] = new OpenApiSchema { Description = "The user theme's snippets (JSON array)." },
                    },
                },
            ],
        };
        list.Items = new OpenApiSchemaReference(nameof(ThemeSnippetRef), document);
        return Task.CompletedTask;
    }
}
