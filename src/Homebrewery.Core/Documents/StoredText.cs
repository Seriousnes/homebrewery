using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Homebrewery.Core.Documents;

/// <summary>
/// Makes client strings storable in PostgreSQL: <c>text</c> and <c>jsonb</c> reject U+0000, and <c>jsonb</c>
/// rejects unpaired surrogates (<c>"\ud800"</c>). Both would otherwise fail the save with a 500.
/// </summary>
public static class StoredText
{
    /// <summary><paramref name="value"/> without U+0000 and with unpaired surrogates replaced by U+FFFD.</summary>
    public static string Clean(string value)
    {
        var i = FirstProblem(value);
        if (i < 0) return value;

        var sb = new StringBuilder(value.Length);
        sb.Append(value, 0, i);
        for (; i < value.Length; i++)
        {
            var c = value[i];
            if (c == '\0') continue;
            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                sb.Append(c).Append(value[++i]);
            }
            else if (char.IsSurrogate(c))
            {
                sb.Append('�');
            }
            else
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }

    /// <inheritdoc cref="Clean(string)"/>
    public static string? CleanOrNull(string? value) => value is null ? null : Clean(value);

    /// <summary>
    /// The cleaned value of a JSON string. Unlike <see cref="JsonElement.GetString"/>, which throws on an escaped
    /// unpaired surrogate (<c>"\ud800"</c>, which JavaScript's JSON.stringify writes), this replaces it with U+FFFD.
    /// </summary>
    public static string GetString(JsonElement element)
    {
        try
        {
            return Clean(element.GetString() ?? "");
        }
        catch (InvalidOperationException) when (element.ValueKind == JsonValueKind.String)
        {
            return Clean(Unescape(element.GetRawText()));
        }
    }

    /// <summary>Decodes a JSON string literal (with quotes) without rejecting unpaired surrogates.</summary>
    private static string Unescape(string literal)
    {
        var sb = new StringBuilder(literal.Length);
        for (var i = 1; i < literal.Length - 1; i++)
        {
            var c = literal[i];
            if (c != '\\')
            {
                sb.Append(c);
                continue;
            }

            var e = literal[++i];
            switch (e)
            {
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    sb.Append((char)Convert.ToUInt16(literal.Substring(i + 1, 4), 16));
                    i += 4;
                    break;
                default: sb.Append(e); break;           // \" \\ \/
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Largest magnitude a stored number may have: JavaScript's <c>Number.MAX_SAFE_INTEGER</c>. PostgreSQL's
    /// <c>jsonb</c> prints numbers without exponents, so <c>1e308</c> (5 bytes) would be read back as 309 digits.
    /// </summary>
    public const double MaxNumber = 9_007_199_254_740_991;

    /// <summary>Non-zero numbers closer to zero than this are stored as 0 (<c>5e-324</c> would print 324 digits).</summary>
    public const double MinNumber = 1e-15;

    /// <summary>
    /// A deep copy of <paramref name="element"/> with every string and property name cleaned and every number in
    /// canonical form (<see cref="ToNumber"/>); a number that cannot be stored becomes null.
    /// </summary>
    public static JsonNode? ToNode(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => ToObject(element),
        JsonValueKind.Array => new JsonArray([.. element.EnumerateArray().Select(ToNode)]),
        JsonValueKind.String => JsonValue.Create(GetString(element)),
        JsonValueKind.Number => ToNumber(element),
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => JsonValue.Create(element),                     // booleans
    };

    /// <summary>
    /// A JSON number written as a double (<c>2.0</c> → <c>2</c>, <c>1.50</c> → <c>1.5</c>), or null when it is not
    /// finite or larger than <see cref="MaxNumber"/>. The client reads numbers as doubles anyway; without this,
    /// <c>1e131071</c> would come back from PostgreSQL as 131,072 characters and <c>1e131072</c> fail the save.
    /// </summary>
    public static JsonValue? ToNumber(JsonElement number)
    {
        if (!number.TryGetDouble(out var value) || !double.IsFinite(value) || Math.Abs(value) > MaxNumber) return null;
        return JsonValue.Create(Math.Abs(value) < MinNumber ? 0 : value);
    }

    /// <summary>
    /// <paramref name="value"/> cut to at most <paramref name="max"/> UTF-16 units without splitting a surrogate
    /// pair, and trimmed at the end.
    /// </summary>
    public static string Truncate(string value, int max)
    {
        if (value.Length <= max) return value;
        var cut = char.IsHighSurrogate(value[max - 1]) ? max - 1 : max;
        return value[..cut].TrimEnd();
    }

    private static JsonObject ToObject(JsonElement element)
    {
        var result = new JsonObject();
        foreach (var property in element.EnumerateObject())
        {
            result[Clean(property.Name)] = ToNode(property.Value);
        }

        return result;
    }

    private static int FirstProblem(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (c == '\0') return i;
            if (!char.IsSurrogate(c)) continue;
            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                i++;
                continue;
            }

            return i;
        }

        return -1;
    }
}
