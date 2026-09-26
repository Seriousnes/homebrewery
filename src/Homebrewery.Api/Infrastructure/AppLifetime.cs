namespace Homebrewery.Api.Infrastructure;

/// <summary>Process exit behaviour of the host (plan P8.4, docs/operations.md "Logs" and "Health").</summary>
public static class AppLifetime
{
    /// <summary>Exit code of a failed start.</summary>
    public const int StartupFailedExitCode = 1;

    /// <summary>
    /// Runs the app like <c>app.Run()</c>. A failure while starting (database unreachable, pending migrations, invalid
    /// settings, a port in use) has already been logged by the host as <c>Hosting failed to start</c> (an Error entry
    /// with the exception, JSON in production). When that exception then goes unhandled, the process exits with code 1
    /// instead of the runtime's crash, which writes a second, plain-text copy of the trace to stderr and ends a Linux
    /// container with a signal (exit code 134 or 139).
    /// </summary>
    /// <remarks>
    /// The exception is still rethrown: <c>WebApplicationFactory</c> runs this entry point and learns about a failed
    /// start from it (and catches it, so the handler never ends a test run). Exceptions after a successful start are
    /// left alone.
    /// </remarks>
    public static void RunOrExit(this WebApplication app)
    {
        // Recorded up front: once Run fails, the host is disposed and its services can no longer be resolved.
        var started = false;
        using var registration = app.Lifetime.ApplicationStarted.Register(() => started = true);
        try
        {
            app.Run();
        }
        catch (Exception failure) when (!started)
        {
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            {
                if (ReferenceEquals(e.ExceptionObject, failure)) Environment.Exit(StartupFailedExitCode);
            };
            throw;
        }
    }
}
