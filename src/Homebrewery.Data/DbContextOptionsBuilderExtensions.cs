using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Homebrewery.Data;

public static class DbContextOptionsBuilderExtensions
{
    /// <summary>
    /// PostgreSQL with snake_case names (EFCore.NamingConventions). Use this for every
    /// <see cref="AppDbContext"/> (host, tests, tools) so the runtime model matches the migrations.
    /// A null connection string is allowed here; the host checks it at startup. The connection string gets the
    /// defaults of <see cref="HomebreweryConnectionStrings.WithDefaults"/>.
    /// </summary>
    public static DbContextOptionsBuilder UseHomebreweryNpgsql(this DbContextOptionsBuilder options, string? connectionString) =>
        options
            .UseNpgsql(HomebreweryConnectionStrings.WithDefaults(connectionString))
            .UseSnakeCaseNamingConvention();
}

/// <summary>Connection string defaults for the Homebrewery database.</summary>
public static class HomebreweryConnectionStrings
{
    /// <summary>
    /// <paramref name="connectionString"/> with <c>Gss Encryption Mode=Disable</c> unless it sets a GSS encryption mode
    /// itself. Npgsql prefers GSS (Kerberos) encryption by default and, in the aspnet runtime image, which has no
    /// libgssapi_krb5, logs 'Cannot load library libgssapi_krb5.so.2' on the first connection. Homebrewery signs in to
    /// PostgreSQL with a password, so GSS encryption is never used. Null, blank and unparsable strings are returned
    /// unchanged (the host and Npgsql report those).
    /// </summary>
    public static string? WithDefaults(string? connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString)) return connectionString;
        try
        {
            if (SetsGssEncryptionMode(connectionString)) return connectionString;
            return new NpgsqlConnectionStringBuilder(connectionString) { GssEncryptionMode = GssEncryptionMode.Disable }.ConnectionString;
        }
        catch (ArgumentException)
        {
            return connectionString;
        }
    }

    private static bool SetsGssEncryptionMode(string connectionString)
    {
        var keys = new DbConnectionStringBuilder { ConnectionString = connectionString }.Keys;
        foreach (var key in keys.Cast<string>())
        {
            var compact = key.Replace(" ", "", StringComparison.Ordinal).ToLowerInvariant();
            if (compact is "gssencryptionmode" or "gssencmode") return true;
        }

        return false;
    }
}
