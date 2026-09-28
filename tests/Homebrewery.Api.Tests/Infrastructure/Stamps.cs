namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>
/// Checks the times the in-process API stamps (UpdatedAt, a lock's Applied, …) without a tolerance: the API reads the
/// same system clock as the test, truncated to microseconds, so a stamp made during a request lies between
/// <see cref="Now"/> before it and <see cref="Now"/> after it.
/// </summary>
public static class Stamps
{
    /// <summary>Now, truncated to microseconds like the API's stamps.</summary>
    public static DateTimeOffset Now()
    {
        var now = DateTimeOffset.UtcNow;
        return now.AddTicks(-(now.Ticks % 10));
    }

    /// <summary>Asserts that <paramref name="stamp"/> was made between <paramref name="before"/> and <paramref name="after"/>.</summary>
    public static void Between(DateTimeOffset? stamp, DateTimeOffset before, DateTimeOffset after)
    {
        Assert.NotNull(stamp);
        Assert.InRange(stamp.Value, before, after);
    }
}
