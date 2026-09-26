using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace Homebrewery.Api.Tests.Operations;

/// <summary>One captured log entry: its state as key/value pairs and the values of every scope around it.</summary>
public sealed record CapturedLog(
    string Category,
    LogLevel Level,
    EventId EventId,
    string Message,
    IReadOnlyDictionary<string, object?> State,
    IReadOnlyList<IReadOnlyDictionary<string, object?>> Scopes,
    Exception? Exception)
{
    /// <summary>Message, state values and scope values as one string, for "never logged" assertions.</summary>
    public string AllText() => string.Join('\n', [
        Message,
        Exception?.ToString() ?? "",
        .. State.Select(kv => $"{kv.Key}={kv.Value}"),
        .. Scopes.SelectMany(s => s.Select(kv => $"{kv.Key}={kv.Value}")),
    ]);
}

/// <summary>
/// An <see cref="ILoggerProvider"/> that keeps every entry the logging filters let through, with its scopes
/// (<see cref="ISupportExternalScope"/>). Add it to a test host with
/// <c>ConfigureTestServices(s =&gt; s.AddSingleton&lt;ILoggerProvider&gt;(capture))</c>.
/// </summary>
public sealed class LogCapture : ILoggerProvider, ISupportExternalScope
{
    private readonly ConcurrentQueue<CapturedLog> _entries = new();
    private IExternalScopeProvider _scopes = new LoggerExternalScopeProvider();

    public IReadOnlyList<CapturedLog> Entries => [.. _entries];

    public IEnumerable<CapturedLog> ForCategory(string category) => Entries.Where(e => e.Category == category);

    public void Clear() => _entries.Clear();

    public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

    public void SetScopeProvider(IExternalScopeProvider scopeProvider) => _scopes = scopeProvider;

    public void Dispose() { }

    internal static IReadOnlyDictionary<string, object?> ToDictionary(object? state) => state switch
    {
        IEnumerable<KeyValuePair<string, object?>> pairs => pairs.GroupBy(p => p.Key)
            .ToDictionary(g => g.Key, g => g.Last().Value, StringComparer.Ordinal),
        null => new Dictionary<string, object?>(),
        _ => new Dictionary<string, object?> { ["{Scope}"] = state.ToString() },
    };

    private sealed class Logger(LogCapture owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => owner._scopes.Push(state);

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var scopes = new List<IReadOnlyDictionary<string, object?>>();
            owner._scopes.ForEachScope((scope, list) => list.Add(ToDictionary(scope)), scopes);
            owner._entries.Enqueue(new CapturedLog(category, logLevel, eventId, formatter(state, exception),
                ToDictionary(state), scopes, exception));
        }
    }
}
