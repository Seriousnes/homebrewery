using Homebrewery.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Homebrewery.Data.Configurations;

public sealed class NotificationConfiguration : IEntityTypeConfiguration<Notification>
{
    public void Configure(EntityTypeBuilder<Notification> b)
    {
        b.HasIndex(x => x.DismissKey).IsUnique();
        b.Property(x => x.CreatedAt).HasDefaultValueSql("now()");
    }
}
