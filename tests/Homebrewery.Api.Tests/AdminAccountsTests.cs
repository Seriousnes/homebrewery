using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Homebrewery.Api.Tests;

/// <summary>Parsing of <c>Admin:Emails</c> and the eligibility rule (no database).</summary>
public sealed class AdminAccountsTests
{
    [Fact]
    public void Emails_accept_an_array()
    {
        var admins = Create(new()
        {
            ["Admin:Emails:0"] = "one@example.com",
            ["Admin:Emails:1"] = " Two@Example.com ",
        });

        Assert.Equal(2, admins.Emails.Count);
        Assert.Contains("two@example.com", admins.Emails);           // case-insensitive
    }

    [Fact]
    public void Emails_accept_a_separated_string()
    {
        var admins = Create(new() { ["Admin:Emails"] = "one@example.com; two@example.com,three@example.com  four@example.com" });

        Assert.Equal(4, admins.Emails.Count);
    }

    [Fact]
    public void No_configuration_means_no_admins()
    {
        var admins = Create(new());

        Assert.Empty(admins.Emails);
        Assert.True(admins.RequireConfirmedEmail);                       // secure default
        Assert.False(admins.IsEligible(new AppUser { Email = "one@example.com", EmailConfirmed = true }));
    }

    [Theory]
    [InlineData("one@example.com", true, true, true)]
    [InlineData("ONE@example.com", true, true, true)]
    [InlineData("one@example.com", false, true, false)]                 // unconfirmed, confirmation required
    [InlineData("one@example.com", false, false, true)]                 // unconfirmed, confirmation not required
    [InlineData("other@example.com", true, false, false)]
    [InlineData(null, true, false, false)]
    public void IsEligible_requires_a_listed_and_by_default_confirmed_email(
        string? email, bool confirmed, bool requireConfirmed, bool expected)
    {
        var admins = Create(new()
        {
            ["Admin:Emails"] = "one@example.com",
            ["Admin:RequireConfirmedEmail"] = requireConfirmed ? "true" : "false",
        });

        Assert.Equal(expected, admins.IsEligible(new AppUser { Email = email, EmailConfirmed = confirmed }));
    }

    private static AdminAccounts Create(Dictionary<string, string?> settings) =>
        new(new ConfigurationBuilder().AddInMemoryCollection(settings).Build(), NullLogger<AdminAccounts>.Instance);
}
