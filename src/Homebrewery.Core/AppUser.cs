using Microsoft.AspNetCore.Identity;

namespace Homebrewery.Core;

/// <summary>An account (ASP.NET Core Identity user, <c>asp_net_users</c>).</summary>
public sealed class AppUser : IdentityUser<Guid>
{
    public AppUser()
    {
        Id = Guid.CreateVersion7();
        SecurityStamp = Guid.NewGuid().ToString();
    }

    /// <summary>
    /// Public handle used in <c>/user/{handle}</c>. Always stored normalized (lower case) and valid
    /// per <see cref="Handles"/>; unique. New accounts get a default derived from the email address
    /// (see <see cref="Handles.FromEmail"/>).
    /// </summary>
    public string Handle { get; set; } = "";
}
