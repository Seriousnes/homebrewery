using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Homebrewery.Data.Configurations;

/// <summary>
/// <c>brews</c> (plan §8.2). The column defaults mirror the reference SQL so rows inserted outside EF
/// get the same values; EF itself always sends the CLR initial values. The migration also sets lz4
/// TOAST compression on <c>doc</c> (raw SQL in the migration, not part of the model).
/// </summary>
public sealed class BrewConfiguration : IEntityTypeConfiguration<Brew>
{
    public const string PublishedUpdatedIndexName = "ix_brews_published_updated";

    public void Configure(EntityTypeBuilder<Brew> b)
    {
        b.HasIndex(x => x.ShareId).IsUnique();
        b.HasIndex(x => x.EditId).IsUnique();

        b.Property(x => x.Title).HasDefaultValue("");
        b.Property(x => x.Description).HasDefaultValue("");
        b.Property(x => x.Lang).HasDefaultValue("en");
        b.Property(x => x.Theme).HasDefaultValue("5ePHB");
        b.Property(x => x.DocSchemaVersion).HasDefaultValue(1);
        b.Property(x => x.Doc).HasColumnType("jsonb");
        b.Property(x => x.Style).HasDefaultValue("");
        b.Property(x => x.Snippets).HasColumnType("jsonb");
        b.Property(x => x.SearchText).HasDefaultValue("");
        b.Property(x => x.Tags).HasDefaultValueSql("'{}'::text[]");
        b.Property(x => x.PageCount).HasDefaultValue(1);
        b.Property(x => x.Published).HasDefaultValue(false);
        b.Property(x => x.Views).HasDefaultValue(0);
        b.Property(x => x.Version).HasDefaultValue(1).IsConcurrencyToken();   // UPDATE … WHERE version = @original
        b.Property(x => x.CreatedAt).HasDefaultValueSql("now()");
        b.Property(x => x.UpdatedAt).HasDefaultValueSql("now()");

        b.OwnsOne(x => x.Lock, l =>                                            // jsonb column "lock"
        {
            l.ToJson();
            // camelCase keys like the rest of the app's JSON, e.g. lock->>'reviewRequested'.
            l.Property(p => p.Code).HasJsonPropertyName("code");
            l.Property(p => p.EditMessage).HasJsonPropertyName("editMessage");
            l.Property(p => p.ShareMessage).HasJsonPropertyName("shareMessage");
            l.Property(p => p.Applied).HasJsonPropertyName("applied");
            l.Property(p => p.ReviewRequested).HasJsonPropertyName("reviewRequested");
        });

        b.HasIndex(x => x.Tags).HasMethod("gin");
        b.HasIndex(x => new { x.Published, x.UpdatedAt })
            .IsDescending(false, true)
            .HasDatabaseName(PublishedUpdatedIndexName);

        b.HasGeneratedTsVectorColumn(x => x.SearchVector, "simple",
                x => new { x.Title, x.Description, x.SearchText })
            .HasIndex(x => x.SearchVector).HasMethod("gin");

        b.HasMany(x => x.Authors).WithOne().HasForeignKey(a => a.BrewId).OnDelete(DeleteBehavior.Cascade);
    }
}
