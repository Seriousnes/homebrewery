using System.Text.Json;
using System.Text.Json.Serialization;

namespace Homebrewery.Api.Brews;

/// <summary>
/// JSON text written into a response as is: stored <c>jsonb</c> (a brew's doc and snippets) reaches the client
/// without being parsed and re-serialized (plan §8.2). In the OpenAPI document it is an unconstrained value.
/// </summary>
[JsonConverter(typeof(RawJsonConverter))]
public readonly record struct RawJson(string Json)
{
    public static RawJson? FromNullable(string? json) => json is null ? null : new RawJson(json);

    /// <summary>Parses the JSON (for tests and callers that need to look inside).</summary>
    public JsonElement Parse()
    {
        using var document = JsonDocument.Parse(Json);
        return document.RootElement.Clone();
    }

    public override string ToString() => Json;
}

public sealed class RawJsonConverter : JsonConverter<RawJson>
{
    public override RawJson Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        return new RawJson(document.RootElement.GetRawText());
    }

    // The text comes from PostgreSQL jsonb (always valid JSON), so the writer skips re-validating it.
    public override void Write(Utf8JsonWriter writer, RawJson value, JsonSerializerOptions options) =>
        writer.WriteRawValue(value.Json, skipInputValidation: true);
}
