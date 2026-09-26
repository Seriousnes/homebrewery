using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Homebrewery.Api.Themes;

/// <summary>
/// A static (built-in) theme: one entry of <c>/themes/themes.json</c>, which the web build writes
/// (<c>web/vite/generateAssetsPlugin.ts</c>, <c>ThemeCatalogEntry</c>). <c>GET /api/themes</c> returns these entries
/// as they are.
/// </summary>
/// <param name="Key">Theme id, e.g. <c>5ePHB</c>; the value of a brew's <c>meta.theme</c>. Same as the folder name.</param>
/// <param name="Name">Display name, e.g. <c>5e PHB</c>.</param>
/// <param name="Renderer">Always <c>V3</c>.</param>
/// <param name="BaseTheme">Key of the theme whose CSS loads before this one, or null for a root theme.</param>
/// <param name="BaseSnippets">Key of the theme whose snippets upstream merged under this theme's, or null.
/// Informational: upstream no longer uses it and the bundle ignores it.</param>
/// <param name="Path">Folder name under <c>themes/V3</c> (legacy field).</param>
/// <param name="Style">URL of the compiled, unscoped stylesheet (export).</param>
/// <param name="ScopedStyle">URL of the stylesheet scoped under <c>.hb-canvas</c> (editor canvas).</param>
/// <param name="Preview">URL of the theme picker preview image, or null.</param>
/// <param name="Texture">URL of the theme picker texture image, or null.</param>
/// <param name="HasSnippets">Whether the theme has its own snippets (snippet group <c>V3_{key}</c>).</param>
public sealed record ThemeCatalogEntry(
    string Key,
    string Name,
    string Renderer,
    string? BaseTheme,
    string? BaseSnippets,
    string Path,
    string Style,
    string ScopedStyle,
    string? Preview,
    string? Texture,
    bool HasSnippets)
{
    /// <summary>The snippet group id the client loads for this theme, e.g. <c>V3_5ePHB</c>. Not serialized, so the
    /// JSON shape stays that of <c>themes.json</c>.</summary>
    [JsonIgnore]
    public string SnippetGroup => $"{Renderer}_{Key}";
}

/// <summary>
/// The static themes (plan §8.7), loaded once at startup from <c>wwwroot/themes/themes.json</c> (see
/// <see cref="ThemeCatalogSetup"/>). Keys are case-sensitive, like upstream's lookup.
/// </summary>
public sealed partial class ThemeCatalog
{
    /// <summary>Longest theme chain (static and user themes together) the bundle endpoint accepts.</summary>
    public const int MaxChain = 8;

    public const string Renderer = "V3";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip,
    };

    private readonly Dictionary<string, ThemeCatalogEntry> _byKey;

    private ThemeCatalog(IReadOnlyList<ThemeCatalogEntry> themes, string source)
    {
        Themes = themes;
        Source = source;
        _byKey = themes.ToDictionary(t => t.Key, StringComparer.Ordinal);
    }

    /// <summary>The static themes in catalog order.</summary>
    public IReadOnlyList<ThemeCatalogEntry> Themes { get; }

    /// <summary>Where the catalog came from (a file path, or a description of the fallback).</summary>
    public string Source { get; }

    public bool TryGet(string key, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out ThemeCatalogEntry? entry) =>
        _byKey.TryGetValue(key, out entry);

    public bool Contains(string key) => _byKey.ContainsKey(key);

    /// <summary>Theme keys: letters, digits, <c>_</c> and <c>-</c> (they are folder names and URL segments).</summary>
    [GeneratedRegex(@"\A[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ValidKey();

    /// <summary>Reads and validates a <c>themes.json</c> file.</summary>
    /// <exception cref="FileNotFoundException">The file does not exist.</exception>
    /// <exception cref="InvalidDataException">The file is not a valid catalog.</exception>
    public static ThemeCatalog Load(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"Theme catalog not found: {path}", path);
        return Parse(File.ReadAllText(path), path);
    }

    /// <summary>Parses and validates the JSON of a <c>themes.json</c> file.</summary>
    /// <exception cref="InvalidDataException">The JSON is not a valid catalog.</exception>
    public static ThemeCatalog Parse(string json, string source = "themes.json")
    {
        CatalogFile? file;
        try
        {
            file = JsonSerializer.Deserialize<CatalogFile>(json, Json);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException($"Theme catalog {source} is not valid JSON: {ex.Message}", ex);
        }

        if (file?.Themes is null) throw new InvalidDataException($"Theme catalog {source} has no \"themes\" array.");
        return Create(file.Themes, source);
    }

    /// <summary>
    /// Builds the catalog from the repository's theme sources (<c>themes/V3/*/settings.json</c>) the same way the web
    /// build does. Development fallback for a host that runs without a web build (e.g. a fresh <c>docker compose up</c>,
    /// where Vite serves the theme files from memory).
    /// </summary>
    /// <param name="themesDirectory">The repository's <c>themes/</c> directory.</param>
    /// <exception cref="DirectoryNotFoundException">There is no <c>V3</c> folder in it.</exception>
    /// <exception cref="InvalidDataException">A theme's settings are not valid.</exception>
    public static ThemeCatalog FromThemeSources(string themesDirectory)
    {
        var v3 = System.IO.Path.Combine(themesDirectory, Renderer);
        if (!Directory.Exists(v3)) throw new DirectoryNotFoundException($"No theme sources in {v3}.");

        var entries = new List<ThemeCatalogEntry>();
        foreach (var dir in Directory.GetDirectories(v3).Order(StringComparer.Ordinal))
        {
            var key = System.IO.Path.GetFileName(dir);
            var settingsFile = System.IO.Path.Combine(dir, "settings.json");
            if (!File.Exists(settingsFile) || !File.Exists(System.IO.Path.Combine(dir, "style.less"))) continue;

            ThemeSettings settings;
            try
            {
                settings = JsonSerializer.Deserialize<ThemeSettings>(File.ReadAllText(settingsFile), Json)
                           ?? throw new InvalidDataException($"{settingsFile} is empty.");
            }
            catch (JsonException ex)
            {
                throw new InvalidDataException($"{settingsFile} is not valid JSON: {ex.Message}", ex);
            }

            if (settings.Renderer != Renderer) continue;

            var url = $"/themes/{Renderer}/{key}";
            string? Image(string name) => File.Exists(System.IO.Path.Combine(dir, name)) ? $"{url}/{name}" : null;
            entries.Add(new ThemeCatalogEntry(
                key, settings.Name ?? key, Renderer, KeyOrNull(settings.BaseTheme), KeyOrNull(settings.BaseSnippets), key,
                $"{url}/style.css", $"{url}/style.scoped.css", Image("dropdownPreview.png"), Image("dropdownTexture.png"),
                File.Exists(System.IO.Path.Combine(dir, "snippets.js"))));
        }

        return Create(entries, $"{v3}{System.IO.Path.DirectorySeparatorChar}*{System.IO.Path.DirectorySeparatorChar}settings.json");
    }

    /// <summary>
    /// The chain for a static theme, root first (<c>5eDMG</c> gives Blank, 5ePHB, 5eDMG). Null when
    /// <paramref name="key"/> is not a static theme. The catalog was validated on load, so the chain is well formed.
    /// </summary>
    public IReadOnlyList<ThemeCatalogEntry>? ChainOf(string key)
    {
        if (!_byKey.TryGetValue(key, out var entry)) return null;
        var chain = new List<ThemeCatalogEntry>();
        for (var current = entry; current is not null; current = current.BaseTheme is { } b ? _byKey[b] : null)
        {
            chain.Add(current);
        }

        chain.Reverse();
        return chain;
    }

    private static ThemeCatalog Create(IEnumerable<ThemeCatalogEntry?> entries, string source)
    {
        var themes = new List<ThemeCatalogEntry>();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            if (entry is null) throw new InvalidDataException($"Theme catalog {source} has a null entry.");
            if (entry.Key is null || !ValidKey().IsMatch(entry.Key))
            {
                throw new InvalidDataException($"Theme catalog {source}: '{entry.Key}' is not a valid theme key.");
            }

            if (!keys.Add(entry.Key)) throw new InvalidDataException($"Theme catalog {source}: duplicate theme '{entry.Key}'.");
            if (entry.Renderer != Renderer)
            {
                throw new InvalidDataException($"Theme catalog {source}: theme '{entry.Key}' has renderer '{entry.Renderer}', expected '{Renderer}'.");
            }

            if (string.IsNullOrEmpty(entry.ScopedStyle) || string.IsNullOrEmpty(entry.Style))
            {
                throw new InvalidDataException($"Theme catalog {source}: theme '{entry.Key}' has no style URLs.");
            }

            themes.Add(entry with { Name = string.IsNullOrWhiteSpace(entry.Name) ? entry.Key : entry.Name });
        }

        // Every base theme must exist (checked for all themes first, so the chain walk below can't miss a key), and
        // every chain must end within MaxChain themes (no cycles).
        var byKey = themes.ToDictionary(t => t.Key, StringComparer.Ordinal);
        foreach (var theme in themes)
        {
            if (theme.BaseTheme is { } missing && !byKey.ContainsKey(missing))
            {
                throw new InvalidDataException($"Theme catalog {source}: theme '{theme.Key}' has an unknown base theme '{missing}'.");
            }
        }

        foreach (var theme in themes)
        {
            var length = 0;
            for (var current = theme; current is not null; current = current.BaseTheme is { } b ? byKey[b] : null)
            {
                if (++length > MaxChain)
                {
                    throw new InvalidDataException(
                        $"Theme catalog {source}: the base theme chain of '{theme.Key}' is a cycle or longer than {MaxChain}.");
                }
            }
        }

        return new ThemeCatalog(themes, source);
    }

    /// <summary><c>settings.json</c> uses <c>false</c> for "none"; the catalog uses null.</summary>
    private static string? KeyOrNull(JsonElement value) =>
        value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } key ? key : null;

    private sealed record CatalogFile(List<ThemeCatalogEntry?>? Themes);

    private sealed record ThemeSettings(string? Name, string? Renderer, JsonElement BaseTheme, JsonElement BaseSnippets);
}
