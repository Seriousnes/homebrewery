using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Homebrewery.Core;

/// <summary>
/// Rules for public handles (plan §8.6): unique, case-insensitive, 3–32 characters from
/// <c>[a-z0-9_-]</c>. Handles are compared and stored in their normalized (lower-case) form, so
/// the database unique index makes them case-insensitively unique.
/// </summary>
/// <remarks>
/// <para><b>Default handles.</b> Every account has a handle from the moment it is created, so
/// <c>/user/{handle}</c> always resolves. Registration (MapIdentityApi) only asks for an email and a
/// password, so the default is derived from the email's local part: <see cref="FromEmail"/> drops any
/// <c>+tag</c>, strips accents, lower-cases, replaces other characters with <c>-</c> and pads short
/// results with a <c>user-</c> prefix. If that handle is taken, a numeric suffix is added
/// (<c>jane-doe</c>, <c>jane-doe-2</c>, <c>jane-doe-3</c>, …; see <see cref="WithSuffix"/>).</para>
/// <para>Trade-off: the default handle is public and reveals part of the email address. Users can
/// change it at any time with <c>PUT /api/account/handle</c>, and the client should prompt for a
/// handle after registration. Alternatives (random handles such as <c>user-8f3k2q</c>) avoid the leak
/// but make author lists unreadable until users pick a name.</para>
/// </remarks>
public static partial class Handles
{
    public const int MinLength = 3;
    public const int MaxLength = 32;

    /// <summary>The format as a PostgreSQL regular expression (used by the check constraint).</summary>
    public const string SqlPattern = "^[a-z0-9_-]{3,32}$";

    /// <summary>Human-readable rules, used in validation messages.</summary>
    public const string Rules = "A handle is 3 to 32 characters: lower-case letters a-z, digits, '-' and '_'.";

    // \A and \z, not ^ and $: in .NET '$' also matches before a trailing newline.
    [GeneratedRegex(@"\A[a-z0-9_-]{3,32}\z", RegexOptions.CultureInvariant)]
    private static partial Regex ValidHandle();

    /// <summary>Normalizes user input: trims and lower-cases. Does not validate.</summary>
    public static string Normalize(string? handle) => (handle ?? "").Trim().ToLowerInvariant();

    /// <summary>True when <paramref name="handle"/> is a valid, already normalized handle.</summary>
    public static bool IsValid(string? handle) => handle is not null && ValidHandle().IsMatch(handle);

    /// <summary>
    /// Derives a valid default handle from an email address (see the class remarks). The result may be
    /// taken; pick a free one with <see cref="WithSuffix"/>.
    /// </summary>
    public static string FromEmail(string? email)
    {
        var local = email ?? "";
        var at = local.LastIndexOf('@');
        if (at >= 0) local = local[..at];
        var plus = local.IndexOf('+');
        if (plus >= 0) local = local[..plus];

        var result = new StringBuilder(local.Length);
        var pendingDash = false;
        foreach (var ch in local.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;   // é -> e
            var c = char.ToLowerInvariant(ch);
            if (c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' or '-')
            {
                if (pendingDash && result.Length > 0) result.Append('-');
                pendingDash = false;
                result.Append(c);
            }
            else
            {
                pendingDash = true;                                   // "jane.doe" -> "jane-doe"
            }
        }

        var handle = result.ToString().Trim('-');
        if (handle.Length > MaxLength) handle = handle[..MaxLength].TrimEnd('-');
        if (handle.Length < MinLength) handle = handle.Length == 0 ? "user" : $"user-{handle}";
        return handle;
    }

    /// <summary>
    /// The <paramref name="n"/>-th candidate for a base handle: <c>n = 1</c> is the base itself,
    /// <c>n ≥ 2</c> appends <c>-n</c>, truncating the base so the result stays within
    /// <see cref="MaxLength"/>. Every candidate for <c>n &lt; 1,000,000</c> starts with the first
    /// <see cref="MaxLength"/> − 7 characters of the base.
    /// </summary>
    public static string WithSuffix(string baseHandle, int n)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(n, 1);
        if (n == 1) return baseHandle;
        var suffix = "-" + n.ToString(CultureInfo.InvariantCulture);
        var keep = Math.Min(baseHandle.Length, MaxLength - suffix.Length);
        return string.Concat(baseHandle.AsSpan(0, keep), suffix);
    }
}
