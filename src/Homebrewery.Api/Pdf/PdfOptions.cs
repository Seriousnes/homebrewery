namespace Homebrewery.Api.Pdf;

/// <summary>
/// PDF export settings, configuration section <c>Pdf</c> (e.g. <c>Pdf__MaxConcurrentRenders=4</c>). Chromium is found
/// where Playwright installs it: <c>PLAYWRIGHT_BROWSERS_PATH</c>, else the user's <c>ms-playwright</c> cache.
/// </summary>
public sealed class PdfOptions
{
    public const string SectionName = "Pdf";

    /// <summary>Renders that run at the same time. Default 2; each one is a Chromium page (tens of MB).</summary>
    public int MaxConcurrentRenders { get; set; } = 2;

    /// <summary>How long a request waits for a free render slot before it gets 503. Default 10 s.</summary>
    public TimeSpan QueueTimeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>The whole render, other sites' files included. Default 60 s.</summary>
    public TimeSpan RenderTimeout { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>Other sites' files (https images, fonts, stylesheets) fetched for one render. Default 100.</summary>
    public int MaxRemoteFiles { get; set; } = 100;

    /// <summary>Size cap of one fetched file. Default 10 MB.</summary>
    public long MaxRemoteFileBytes { get; set; } = 10 * 1024 * 1024;

    /// <summary>Size cap of all fetched files of one render. Default 50 MB.</summary>
    public long MaxRemoteBytes { get; set; } = 50 * 1024 * 1024;

    /// <summary>Time limit of one fetched file. Default 10 s.</summary>
    public TimeSpan RemoteFileTimeout { get; set; } = TimeSpan.FromSeconds(10);

    internal bool IsValid =>
        MaxConcurrentRenders >= 1 && QueueTimeout >= TimeSpan.Zero && RenderTimeout > TimeSpan.Zero &&
        MaxRemoteFiles >= 0 && MaxRemoteFileBytes >= 1 && MaxRemoteBytes >= 1 && RemoteFileTimeout > TimeSpan.Zero;
}
