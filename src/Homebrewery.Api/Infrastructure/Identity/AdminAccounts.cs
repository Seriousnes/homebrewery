using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>
/// Grants the <see cref="Roles.Admin"/> role from configuration (plan §8.6).
/// <list type="bullet">
/// <item><c>Admin:Emails</c>: the admin email addresses, as an array (<c>Admin__Emails__0=…</c>) or one
/// string separated by commas, semicolons or spaces (<c>Admin__Emails=a@x.org;b@y.org</c>).</item>
/// <item><c>Admin:RequireConfirmedEmail</c> (default <c>true</c>): only grant the role when the account's
/// email is confirmed. Registration does not verify email ownership, so without this anyone could
/// register a listed address before its owner does and become an admin. Development sets it to
/// <c>false</c>. Until the app sends confirmation emails, confirm an admin in production by setting
/// <c>email_confirmed</c> on the row, or turn this off only while the listed accounts are created.</item>
/// </list>
/// The role is created at startup; listed accounts get it at startup, on registration and on every
/// sign-in (including cookie refresh). Removing an address does not revoke the role.
/// </summary>
public sealed partial class AdminAccounts(IConfiguration configuration, ILogger<AdminAccounts> logger)
{
    private static readonly char[] Separators = [',', ';', ' ', '\t', '\r', '\n'];

    /// <summary>The configured admin emails (case-insensitive). Read on each call, so reloads apply.</summary>
    public IReadOnlySet<string> Emails
    {
        get
        {
            var section = configuration.GetSection("Admin:Emails");
            var values = section.GetChildren().Select(c => c.Value).Append(section.Value)
                .SelectMany(v => (v ?? "").Split(Separators, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            return new HashSet<string>(values, StringComparer.OrdinalIgnoreCase);
        }
    }

    public bool RequireConfirmedEmail => configuration.GetValue("Admin:RequireConfirmedEmail", true);

    /// <summary>True when <paramref name="user"/> should hold the Admin role.</summary>
    public bool IsEligible(AppUser user) =>
        user.Email is { Length: > 0 } email
        && Emails.Contains(email.Trim())
        && (user.EmailConfirmed || !RequireConfirmedEmail);

    /// <summary>Adds the Admin role to an eligible user who does not have it yet.</summary>
    public async Task EnsureRoleAsync(UserManager<AppUser> users, AppUser user)
    {
        if (!IsEligible(user) || await users.IsInRoleAsync(user, Roles.Admin)) return;

        var result = await users.AddToRoleAsync(user, Roles.Admin);
        if (result.Succeeded) LogGranted(user.Id);
        else LogGrantFailed(user.Id, string.Join("; ", result.Errors.Select(e => e.Description)));
    }

    /// <summary>Startup: creates the Admin role if missing and grants it to existing listed accounts.</summary>
    public async Task SeedAsync(IServiceProvider services, CancellationToken ct)
    {
        var roles = services.GetRequiredService<RoleManager<IdentityRole<Guid>>>();
        if (!await roles.RoleExistsAsync(Roles.Admin))
        {
            try
            {
                var created = await roles.CreateAsync(new IdentityRole<Guid>(Roles.Admin) { Id = Guid.CreateVersion7() });
                if (!created.Succeeded && !await roles.RoleExistsAsync(Roles.Admin))
                {
                    throw new InvalidOperationException(
                        "Could not create the Admin role: " + string.Join("; ", created.Errors.Select(e => e.Description)));
                }
            }
            catch (DbUpdateException)
            {
                // Another instance may have created it at the same time; anything else is fatal.
                // Drop the failed insert so the grants below don't retry it.
                services.GetRequiredService<AppDbContext>().ChangeTracker.Clear();
                if (!await roles.RoleExistsAsync(Roles.Admin)) throw;
            }
        }

        var users = services.GetRequiredService<UserManager<AppUser>>();
        foreach (var email in Emails)
        {
            ct.ThrowIfCancellationRequested();
            var user = await users.FindByEmailAsync(email);
            if (user is not null) await EnsureRoleAsync(users, user);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Granted the Admin role to user {UserId} (listed in Admin:Emails).")]
    private partial void LogGranted(Guid userId);

    [LoggerMessage(Level = LogLevel.Error, Message = "Could not grant the Admin role to user {UserId}: {Errors}")]
    private partial void LogGrantFailed(Guid userId, string errors);
}
