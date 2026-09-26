using Homebrewery.Core;
using Homebrewery.Data;
using Homebrewery.Data.Configurations;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>
/// <see cref="UserManager{TUser}"/> that gives every new account a free default handle (see
/// <see cref="Handles"/>) and grants the Admin role to listed emails on registration.
/// Registered as <c>UserManager&lt;AppUser&gt;</c>, so MapIdentityApi's /register goes through it.
/// </summary>
public sealed class AppUserManager(
    IUserStore<AppUser> store,
    IOptions<IdentityOptions> optionsAccessor,
    IPasswordHasher<AppUser> passwordHasher,
    IEnumerable<IUserValidator<AppUser>> userValidators,
    IEnumerable<IPasswordValidator<AppUser>> passwordValidators,
    ILookupNormalizer keyNormalizer,
    IdentityErrorDescriber errors,
    IServiceProvider services,
    ILogger<UserManager<AppUser>> logger,
    AdminAccounts admins)
    : UserManager<AppUser>(store, optionsAccessor, passwordHasher, userValidators, passwordValidators,
        keyNormalizer, errors, services, logger)
{
    private const int CandidateBatch = 16;
    private const int MaxInsertAttempts = 3;

    /// <inheritdoc />
    /// <remarks>
    /// When <see cref="AppUser.Handle"/> is empty, assigns the first free default handle. Two
    /// registrations can race for the same handle; the loser retries with a fresh lookup.
    /// </remarks>
    public override async Task<IdentityResult> CreateAsync(AppUser user)
    {
        ArgumentNullException.ThrowIfNull(user);
        var generateHandle = string.IsNullOrEmpty(user.Handle);
        for (var attempt = 1; ; attempt++)
        {
            if (generateHandle)
            {
                user.Handle = await FindFreeHandleAsync(Handles.FromEmail(user.Email ?? user.UserName), CancellationToken);
            }

            try
            {
                var result = await base.CreateAsync(user);
                if (result.Succeeded) await admins.EnsureRoleAsync(this, user);
                return result;
            }
            catch (DbUpdateException ex) when (generateHandle && attempt < MaxInsertAttempts
                                               && DbErrors.IsUniqueViolation(ex, AppUserConfiguration.HandleIndexName))
            {
                // Taken between the lookup and the insert. The user is still tracked as Added, so the
                // next CreateAsync inserts it again with the new handle.
            }
        }
    }

    /// <summary>
    /// The first of <c>base</c>, <c>base-2</c>, <c>base-3</c>, … that no account uses. Looks up
    /// candidates in batches with an indexed <c>handle = ANY(...)</c> query.
    /// </summary>
    public async Task<string> FindFreeHandleAsync(string baseHandle, CancellationToken ct = default)
    {
        for (var first = 1; ; first += CandidateBatch)
        {
            var candidates = Enumerable.Range(first, CandidateBatch).Select(n => Handles.WithSuffix(baseHandle, n)).ToList();
            var taken = await Users.Where(u => candidates.Contains(u.Handle)).Select(u => u.Handle).ToListAsync(ct);
            var free = candidates.FirstOrDefault(c => !taken.Contains(c));
            if (free is not null) return free;
        }
    }

    /// <summary>True when another account already uses <paramref name="handle"/> (normalized).</summary>
    public Task<bool> IsHandleTakenAsync(string handle, Guid exceptUserId, CancellationToken ct = default) =>
        Users.AnyAsync(u => u.Handle == handle && u.Id != exceptUserId, ct);
}
