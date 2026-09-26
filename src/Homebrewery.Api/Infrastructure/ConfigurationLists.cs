namespace Homebrewery.Api.Infrastructure;

public static class ConfigurationLists
{
    /// <summary>
    /// A list setting: a JSON array (<c>Key__0=…</c>, <c>Key__1=…</c>) or one string separated by commas, semicolons or
    /// whitespace (<c>Key=a;b</c>). Empty entries are dropped.
    /// </summary>
    public static List<string> Read(IConfiguration configuration, string key)
    {
        var section = configuration.GetSection(key);
        IEnumerable<string?> raw = section.Value is { } single ? [single] : section.GetChildren().Select(c => c.Value);
        return [.. raw.SelectMany(v => (v ?? "").Split([',', ';', ' ', '\t', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries))];
    }
}
