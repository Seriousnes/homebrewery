using Homebrewery.Core;

namespace Homebrewery.Api.Infrastructure.Identity;

/// <summary>Authorization policy names.</summary>
public static class Policies
{
    /// <summary>Requires the <see cref="Roles.Admin"/> role.</summary>
    public const string Admin = "Admin";
}
