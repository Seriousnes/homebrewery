using Homebrewery.Core;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Homebrewery.Data;

/// <summary>
/// The application database: Identity tables plus brews, brew_authors and notifications (plan §8.2).
/// <para>How to create one:</para>
/// <list type="bullet">
/// <item>In the host: resolve it from DI (Program.cs registers it with
/// <see cref="DbContextOptionsBuilderExtensions.UseHomebreweryNpgsql"/>).</item>
/// <item>Anywhere else (tools, tests against another database): <c>new AppDbContext(AppDbContext.CreateStandaloneOptions(cs))</c>.</item>
/// </list>
/// Identity builds its part of the model from <c>IdentityOptions.Stores.SchemaVersion</c>, which it reads
/// from the application service provider; a context created without it would get a different model,
/// so <see cref="OnModelCreating"/> refuses to build one.
/// </summary>
public sealed class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<AppUser, IdentityRole<Guid>, Guid>(options)
{
    /// <summary>Name of the connection string (<c>ConnectionStrings:Homebrewery</c>).</summary>
    public const string ConnectionStringName = "Homebrewery";

    /// <summary>
    /// The Identity schema the migrations were built with (Version 3 includes the passkeys table).
    /// The host must set <c>IdentityOptions.Stores.SchemaVersion</c> to this.
    /// </summary>
    public static readonly Version IdentitySchemaVersion = IdentitySchemaVersions.Version3;

    private static readonly Lazy<IServiceProvider> StandaloneServices = new(() => new ServiceCollection()
        .Configure<IdentityOptions>(o => o.Stores.SchemaVersion = IdentitySchemaVersion)
        .BuildServiceProvider());

    public DbSet<Brew> Brews => Set<Brew>();
    public DbSet<BrewAuthor> BrewAuthors => Set<BrewAuthor>();
    public DbSet<Notification> Notifications => Set<Notification>();

    /// <summary><c>Idempotency-Key</c>s of <c>POST /api/brews</c> (SAVE-8), kept for 24 hours.</summary>
    public DbSet<BrewCreateKey> BrewCreateKeys => Set<BrewCreateKey>();

    /// <summary>
    /// Options for a context created outside the host's DI: PostgreSQL, snake_case names and the
    /// Identity schema version the migrations expect.
    /// </summary>
    public static DbContextOptions<AppDbContext> CreateStandaloneOptions(string connectionString)
    {
        var builder = new DbContextOptionsBuilder<AppDbContext>().UseApplicationServiceProvider(StandaloneServices.Value);
        builder.UseHomebreweryNpgsql(connectionString);
        return builder.Options;
    }

    protected override void OnModelCreating(ModelBuilder builder)
    {
        // SchemaVersion is what base.OnModelCreating reads (IdentityOptions from the application services).
        if (SchemaVersion != IdentitySchemaVersion)
        {
            throw new InvalidOperationException(
                $"AppDbContext needs IdentityOptions.Stores.SchemaVersion = {IdentitySchemaVersion} (got {SchemaVersion}). " +
                "Resolve it from the host's DI, or create it with AppDbContext.CreateStandaloneOptions(connectionString).");
        }

        base.OnModelCreating(builder);                       // Identity tables
        UseSnakeCaseIdentityNames(builder);
        builder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }

    /// <summary>
    /// EFCore.NamingConventions only rewrites names it derives itself. Identity names its tables
    /// (<c>AspNetUsers</c>, …) and three indexes explicitly, so rename those to snake_case too.
    /// </summary>
    private static void UseSnakeCaseIdentityNames(ModelBuilder builder)
    {
        builder.Entity<AppUser>(b =>
        {
            b.ToTable("asp_net_users");
            b.HasIndex(u => u.NormalizedUserName).HasDatabaseName("ix_asp_net_users_normalized_user_name");
            b.HasIndex(u => u.NormalizedEmail).HasDatabaseName("ix_asp_net_users_normalized_email");
        });
        builder.Entity<IdentityRole<Guid>>(b =>
        {
            b.ToTable("asp_net_roles");
            b.HasIndex(r => r.NormalizedName).HasDatabaseName("ix_asp_net_roles_normalized_name");
        });
        builder.Entity<IdentityUserClaim<Guid>>().ToTable("asp_net_user_claims");
        builder.Entity<IdentityUserLogin<Guid>>().ToTable("asp_net_user_logins");
        builder.Entity<IdentityUserToken<Guid>>().ToTable("asp_net_user_tokens");
        builder.Entity<IdentityUserRole<Guid>>().ToTable("asp_net_user_roles");
        builder.Entity<IdentityRoleClaim<Guid>>().ToTable("asp_net_role_claims");
        builder.Entity<IdentityUserPasskey<Guid>>().ToTable("asp_net_user_passkeys");
    }
}
