using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Homebrewery.Data.Configurations;

/// <summary><c>brew_authors</c>: primary key (brew_id, user_id); role is a smallint (<see cref="AuthorRole"/>).</summary>
public sealed class BrewAuthorConfiguration : IEntityTypeConfiguration<BrewAuthor>
{
    public void Configure(EntityTypeBuilder<BrewAuthor> b)
    {
        b.HasKey(x => new { x.BrewId, x.UserId });
        b.HasIndex(x => x.UserId).HasDatabaseName("ix_brew_authors_user");
        b.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        // The brews -> brew_authors relationship is configured in BrewConfiguration.
    }
}
