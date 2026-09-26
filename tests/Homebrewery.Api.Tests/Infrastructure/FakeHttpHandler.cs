using System.Collections.Concurrent;
using System.Net;
using System.Text;

namespace Homebrewery.Api.Tests.Infrastructure;

/// <summary>
/// An <see cref="HttpMessageHandler"/> that never touches the network: it records every request and answers with
/// <see cref="Respond"/>. Put it in a test host with
/// <c>services.AddHttpClient&lt;T&gt;().ConfigurePrimaryHttpMessageHandler(() =&gt; fake)</c>.
/// </summary>
public sealed class FakeHttpHandler : HttpMessageHandler
{
    private readonly ConcurrentQueue<RecordedRequest> _requests = new();

    /// <summary>The answer to each request. Default: 500.</summary>
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Respond { get; set; } =
        (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError));

    public IReadOnlyList<RecordedRequest> Requests => [.. _requests];

    public void Reset(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? respond = null)
    {
        _requests.Clear();
        if (respond is not null) Respond = respond;
    }

    /// <summary>Answers every request with <paramref name="status"/> and a text body.</summary>
    public static Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Text(
        string body, string mediaType = "text/plain", HttpStatusCode status = HttpStatusCode.OK) =>
        (_, _) => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, mediaType) });

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        _requests.Enqueue(new RecordedRequest(request.Method, request.RequestUri!, request.Headers.Host,
            request.Headers.ToString()));
        return Respond(request, cancellationToken);
    }
}

/// <summary>What <see cref="FakeHttpHandler"/> saw.</summary>
public sealed record RecordedRequest(HttpMethod Method, Uri Uri, string? Host, string Headers);
