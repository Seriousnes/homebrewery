namespace Homebrewery.Core;

/// <summary>Tags with a meaning to the application (brew tags are otherwise free-form).</summary>
public static class BrewTags
{
    /// <summary>
    /// Marks a brew as a user theme (plan §8.7): its CSS and snippets can be used as another brew's theme, by share
    /// id. Upstream accepts this spelling and <c>meta:Theme</c>; see <see cref="ThemeVariants"/>.
    /// </summary>
    public const string Theme = "meta:theme";

    /// <summary>Every spelling of <see cref="Theme"/> that marks a user theme (upstream's rule, exact match).</summary>
    public static IReadOnlyList<string> ThemeVariants { get; } = [Theme, "meta:Theme"];

    /// <summary>Whether <paramref name="tags"/> mark a brew as a user theme.</summary>
    public static bool IsTheme(IEnumerable<string> tags) => tags.Any(t => t is Theme or "meta:Theme");
}
