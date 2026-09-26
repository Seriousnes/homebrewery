using Homebrewery.Core;
using Microsoft.AspNetCore.Identity;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>
/// Rejects creating or updating an account whose handle is not valid and normalized. Uniqueness is
/// enforced by the database index (and checked up front by the handle endpoint).
/// </summary>
public sealed class HandleValidator : IUserValidator<AppUser>
{
    public const string ErrorCode = "InvalidHandle";

    public Task<IdentityResult> ValidateAsync(UserManager<AppUser> manager, AppUser user) =>
        Task.FromResult(Handles.IsValid(user.Handle)
            ? IdentityResult.Success
            : IdentityResult.Failed(new IdentityError { Code = ErrorCode, Description = Handles.Rules }));
}
