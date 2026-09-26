using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Homebrewery.Data.Configurations;

/// <summary>
/// <c>brew_create_keys</c> (SAVE-8): the <c>Idempotency-Key</c>s of <c>POST /api/brews</c>. The primary key
/// (user_id, key) is the unique index that makes two requests with one key create one brew: the second insert waits
/// for the first transaction and then fails, and the service answers it with the first brew. Rows cascade with their
/// brew and their user; <c>created_at</c> is indexed for the 24-hour cleanup.
/// </summary>
public sealed class BrewCreateKeyConfiguration : IEntityTypeConfiguration<BrewCreateKey>
{
    public const string PrimaryKeyName = "pk_brew_create_keys";
    public const string CreatedAtIndexName = "ix_brew_create_keys_created_at";
    public const string BrewIndexName = "ix_brew_create_keys_brew_id";

    public void Configure(EntityTypeBuilder<BrewCreateKey> b)
    {
        b.HasKey(x => new { x.UserId, x.Key }).HasName(PrimaryKeyName);
        b.Property(x => x.Key).HasMaxLength(BrewCreateKey.MaxKeyLength);
        b.HasIndex(x => x.CreatedAt).HasDatabaseName(CreatedAtIndexName);
        b.HasIndex(x => x.BrewId).HasDatabaseName(BrewIndexName);
        b.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        b.HasOne<Brew>().WithMany().HasForeignKey(x => x.BrewId).OnDelete(DeleteBehavior.Cascade);
    }
}
