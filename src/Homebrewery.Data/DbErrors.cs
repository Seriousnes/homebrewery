using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Homebrewery.Data;

/// <summary>Classifies database errors raised by <see cref="DbContext.SaveChangesAsync(CancellationToken)"/>.</summary>
public static class DbErrors
{
    /// <summary>
    /// True when the save failed on a unique constraint or unique index, optionally a specific one
    /// (e.g. <see cref="Configurations.AppUserConfiguration.HandleIndexName"/>).
    /// </summary>
    public static bool IsUniqueViolation(DbUpdateException exception, string? constraintName = null) =>
        exception.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } pg
        && (constraintName is null || pg.ConstraintName == constraintName);
}
