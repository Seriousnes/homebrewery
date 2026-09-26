using Homebrewery.Api.Tests.Infrastructure;
using Homebrewery.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Homebrewery.Api.Tests;

/// <summary>
/// P8 hardening: connection strings get <c>Gss Encryption Mode=Disable</c>, so Npgsql does not probe for Kerberos (and
/// log 'Cannot load library libgssapi_krb5.so.2' in the aspnet runtime image) unless the string asks for it.
/// </summary>
public sealed class ConnectionStringTests
{
    [Fact]
    public void Gss_encryption_is_disabled_by_default()
    {
        var result = HomebreweryConnectionStrings.WithDefaults("Host=db;Port=5432;Database=homebrewery;Username=u;Password=p;");

        var builder = new NpgsqlConnectionStringBuilder(result);
        Assert.Equal(GssEncryptionMode.Disable, builder.GssEncryptionMode);
        Assert.Equal("db", builder.Host);
        Assert.Equal("homebrewery", builder.Database);
        Assert.Equal("p", builder.Password);
    }

    [Theory]
    [InlineData("Host=db;Gss Encryption Mode=Prefer", GssEncryptionMode.Prefer)]
    [InlineData("Host=db;GssEncryptionMode=Require", GssEncryptionMode.Require)]
    [InlineData("Host=db;gss encryption mode=disable", GssEncryptionMode.Disable)]
    public void An_explicit_mode_is_kept(string connectionString, GssEncryptionMode expected)
    {
        var result = HomebreweryConnectionStrings.WithDefaults(connectionString);

        Assert.Equal(connectionString, result);
        Assert.Equal(expected, new NpgsqlConnectionStringBuilder(result).GssEncryptionMode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("Host=db;Not A Keyword=1")]
    public void Missing_or_unparsable_strings_are_returned_unchanged(string? connectionString)
    {
        Assert.Equal(connectionString, HomebreweryConnectionStrings.WithDefaults(connectionString));
    }
}

/// <summary>The running host's DbContext uses the defaults.</summary>
[Collection(ApiCollection.Name)]
public sealed class HostConnectionStringTests(ApiFixture api)
{
    [Fact]
    public async Task The_app_connects_with_gss_encryption_disabled()
    {
        var connectionString = await api.Factory.WithDbAsync(db => Task.FromResult(db.Database.GetConnectionString()));

        Assert.Equal(GssEncryptionMode.Disable, new NpgsqlConnectionStringBuilder(connectionString).GssEncryptionMode);
    }
}
