using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Homebrewery.Data.Configurations;

/// <summary>
/// Adds the public handle to Identity's <c>asp_net_users</c> table: unique index plus a check constraint
/// on the normalized format, so a lower-case handle is the only thing the database accepts.
/// </summary>
public sealed class AppUserConfiguration : IEntityTypeConfiguration<AppUser>
{
    public const string HandleIndexName = "ix_asp_net_users_handle";
    public const string HandleCheckName = "ck_asp_net_users_handle";

    public void Configure(EntityTypeBuilder<AppUser> b)
    {
        b.Property(x => x.Handle).HasMaxLength(Handles.MaxLength).IsRequired();
        b.HasIndex(x => x.Handle).IsUnique().HasDatabaseName(HandleIndexName);
        b.ToTable(t => t.HasCheckConstraint(HandleCheckName, $"handle ~ '{Handles.SqlPattern}'"));
    }
}
