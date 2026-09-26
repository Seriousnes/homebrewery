using Homebrewery.Core;

namespace Homebrewery.Api.Tests;

/// <summary>Handle rules (plan §8.6) and default handles derived from email addresses.</summary>
public sealed class HandlesTests
{
    [Theory]
    [InlineData("abc")]
    [InlineData("jane-doe")]
    [InlineData("under_score")]
    [InlineData("0123456789")]
    [InlineData("---")]
    [InlineData("abcdefghijklmnopqrstuvwxyz012345")]    // 32
    public void Valid_handles(string handle) => Assert.True(Handles.IsValid(handle));

    [Theory]
    [InlineData("ab")]
    [InlineData("abcdefghijklmnopqrstuvwxyz0123456")]   // 33
    [InlineData("Upper")]                               // not normalized
    [InlineData("has space")]
    [InlineData("dots.not.allowed")]
    [InlineData("héllo")]
    [InlineData("abc\n")]                               // '$' would accept this; the pattern uses \z
    [InlineData("")]
    [InlineData(null)]
    public void Invalid_handles(string? handle) => Assert.False(Handles.IsValid(handle));

    [Theory]
    [InlineData("  MiXeD_Case ", "mixed_case")]
    [InlineData(null, "")]
    public void Normalize_trims_and_lower_cases(string? input, string expected) =>
        Assert.Equal(expected, Handles.Normalize(input));

    [Theory]
    [InlineData("jane.doe@example.com", "jane-doe")]
    [InlineData("Jane.Doe+newsletter@example.com", "jane-doe")]         // +tag dropped, lower-cased
    [InlineData("under_score-dash@example.com", "under_score-dash")]
    [InlineData("élodie.ñúñez@example.com", "elodie-nunez")]           // accents stripped
    [InlineData("a..b...c@example.com", "a-b-c")]                      // runs collapse to one '-'
    [InlineData(".leading.trailing.@example.com", "leading-trailing")]
    [InlineData("q@example.com", "user-q")]                            // padded to 3+
    [InlineData("ab@example.com", "user-ab")]
    [InlineData("abc@example.com", "abc")]
    [InlineData("名前@example.com", "user")]                            // nothing usable
    [InlineData("@example.com", "user")]
    [InlineData("", "user")]
    [InlineData(null, "user")]
    [InlineData("no-at-sign", "no-at-sign")]
    public void FromEmail_derives_a_handle_from_the_local_part(string? email, string expected) =>
        Assert.Equal(expected, Handles.FromEmail(email));

    [Fact]
    public void FromEmail_truncates_to_the_maximum_length()
    {
        var handle = Handles.FromEmail(new string('x', 31) + ".yyyy@example.com");

        Assert.Equal(new string('x', 31), handle);                       // "xxx…x-" trimmed at 32
        Assert.True(Handles.IsValid(Handles.FromEmail(new string('z', 100) + "@example.com")));
    }

    [Theory]
    [InlineData("jane.doe@example.com")]
    [InlineData("!!!@example.com")]
    [InlineData("o'brien@example.com")]
    [InlineData("x@example.com")]
    [InlineData("ÄÖÜß.straße@example.com")]
    public void FromEmail_always_returns_a_valid_handle(string email) =>
        Assert.True(Handles.IsValid(Handles.FromEmail(email)), Handles.FromEmail(email));

    [Theory]
    [InlineData("jane", 1, "jane")]
    [InlineData("jane", 2, "jane-2")]
    [InlineData("jane", 17, "jane-17")]
    [InlineData("abcdefghijklmnopqrstuvwxyz012345", 2, "abcdefghijklmnopqrstuvwxyz0123-2")]
    [InlineData("abcdefghijklmnopqrstuvwxyz012345", 123456, "abcdefghijklmnopqrstuvwxy-123456")]
    public void WithSuffix_appends_a_number_and_stays_within_the_maximum(string baseHandle, int n, string expected)
    {
        var handle = Handles.WithSuffix(baseHandle, n);

        Assert.Equal(expected, handle);
        Assert.True(Handles.IsValid(handle));
    }

    [Fact]
    public void WithSuffix_rejects_numbers_below_one() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => Handles.WithSuffix("jane", 0));
}
