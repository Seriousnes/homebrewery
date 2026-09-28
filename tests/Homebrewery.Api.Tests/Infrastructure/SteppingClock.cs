namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>
/// A clock that moves a fixed <paramref name="step"/> each time it is read, and counts the reads. Time limits measured
/// on it run out after a known amount of work, never because the machine is slow. With a zero step it stands still:
/// no time limit ever runs out.
/// </summary>
public sealed class SteppingClock(TimeSpan step) : TimeProvider
{
    private long _reads;

    /// <summary>A clock that never moves: for tests whose subject is not a time limit.</summary>
    public static SteppingClock Stopped() => new(TimeSpan.Zero);

    /// <summary>How often <see cref="GetTimestamp"/> was called.</summary>
    public long Reads => Interlocked.Read(ref _reads);

    public override long TimestampFrequency => TimeSpan.TicksPerSecond;

    public override long GetTimestamp() => Interlocked.Increment(ref _reads) * step.Ticks;
}
