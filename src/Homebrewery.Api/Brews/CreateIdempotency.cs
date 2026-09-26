using System.Buffers;
using System.Security.Cryptography;
using System.Text.Json;
using Homebrewery.Core;

namespace Homebrewery.Api.Brews;

/// <summary>
/// The <c>Idempotency-Key</c> header of <c>POST /api/brews</c> (SAVE-8): parsing, and the request fingerprint that
/// tells a replay (the same request sent again after its response was lost) from a different request that reuses
/// the key.
/// </summary>
public static class CreateIdempotency
{
    /// <summary>The request header.</summary>
    public const string HeaderName = "Idempotency-Key";

    /// <summary>The error key of a malformed header in a 400 validation problem.</summary>
    public const string ErrorKey = HeaderName;

    /// <summary>
    /// The raw header value, or null when the request has no such header. An empty header, and several headers
    /// (joined with ", "), come back as they are, so <see cref="Parse"/> refuses them.
    /// </summary>
    public static string? HeaderValue(IHeaderDictionary headers) =>
        headers.TryGetValue(HeaderName, out var values) ? string.Join(", ", values.Select(v => v ?? "")) : null;

    /// <summary>
    /// The key without the optional structured-field quotes (<c>"…"</c>, IETF draft-ietf-httpapi-idempotency-key-header),
    /// or null when the header is malformed: empty, longer than <see cref="BrewCreateKey.MaxKeyLength"/>, or with
    /// characters other than visible ASCII.
    /// </summary>
    public static string? Parse(string header)
    {
        var key = header.Length >= 2 && header[0] == '"' && header[^1] == '"' ? header[1..^1] : header;
        if (key.Length is 0 or > BrewCreateKey.MaxKeyLength) return null;
        foreach (var c in key)
        {
            if (c is < '!' or > '~') return null;
        }

        return key;
    }

    /// <summary>
    /// SHA-256 of the request as canonical JSON: object members sorted by name, numbers as doubles, no whitespace. Key
    /// order, whitespace, escapes, number spelling (<c>2.0</c> / <c>2</c>), a missing versus a null field and gzip make
    /// no difference; any change of a value does.
    /// </summary>
    public static byte[] Fingerprint(CreateBrewRequest request)
    {
        var element = JsonSerializer.SerializeToElement(request, JsonSerializerOptions.Web);
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            WriteCanonical(writer, element);
        }

        return SHA256.HashData(buffer.WrittenSpan);
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }

                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(element.GetString());
                break;
            case JsonValueKind.Number when element.TryGetDouble(out var number) && double.IsFinite(number):
                writer.WriteNumberValue(number);
                break;
            case JsonValueKind.Number:
                writer.WriteStringValue("number:" + element.GetRawText());
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            default:
                writer.WriteNullValue();
                break;
        }
    }
}
