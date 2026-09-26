using System.Text;
using Homebrewery.Api.Import;
using Homebrewery.Api.Infrastructure;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Endpoints;

/// <summary><c>/api/import/*</c> (plan §8.3, P2.8): server-side fetches for the import page.</summary>
public static class ImportEndpoints
{
    public static RouteGroupBuilder MapImportEndpoints(this IEndpointRouteBuilder api)
    {
        var import = api.MapGroup("/import").WithTags("Import");

        import.MapGet("/homebrewery/{shareId}", ImportFromHomebreweryAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimits.Import)
            .WithName("ImportFromHomebrewery")
            .WithSummary("The Homebrewery markdown of a brew on homebrewery.naturalcrit.com, by its share id.")
            .WithDescription(
                "Fetches `https://homebrewery.naturalcrit.com/download/{shareId}` and returns it as text/plain (the brew text " +
                "with its ```metadata and ```css blocks). `shareId` must be 10-14 letters, digits, `_` or `-` (400 otherwise). " +
                "404 when the Homebrewery has no such brew, 413 when the text is over 2 MB, 502 when the Homebrewery fails, " +
                "answers an error (then `upstreamStatus` holds its status; a locked brew answers its lock code), " +
                "redirects or times out. Rate limited per user (429).")
            .Produces<string>(StatusCodes.Status200OK, "text/plain")
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway);

        return import;
    }

    internal static async Task<Results<ContentHttpResult, ValidationProblem, ProblemHttpResult>> ImportFromHomebreweryAsync(
        string shareId, HttpContext context, UpstreamImportClient upstream, CancellationToken ct)
    {
        switch (await upstream.DownloadAsync(shareId, ct))
        {
            case ImportOutcome.Ok ok:
                context.Response.Headers.CacheControl = "no-store";
                context.Response.Headers.XContentTypeOptions = "nosniff";
                return TypedResults.Text(ok.Text, "text/plain", Encoding.UTF8);
            case ImportOutcome.InvalidId:
                return TypedResults.ValidationProblem(
                    new Dictionary<string, string[]> { ["shareId"] = ["must be a Homebrewery share id: 10-14 letters, digits, _ or -"] },
                    title: "Not a Homebrewery share id.");
            case ImportOutcome.NotFound:
                return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Brew not found",
                    detail: "The Homebrewery has no brew with this share id.");
            case ImportOutcome.TooLarge:
                return TypedResults.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: "Brew too large",
                    detail: $"Brews over {UpstreamImportClient.MaxBytes / (1024 * 1024)} MB cannot be imported.");
            case ImportOutcome.Failed { UpstreamStatus: { } status }:
                // A locked brew answers with its lock code as the status; the import page can say so.
                return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: "Download from the Homebrewery failed",
                    detail: $"The Homebrewery answered HTTP {status}. The brew may be locked or unavailable.",
                    extensions: new Dictionary<string, object?> { ["upstreamStatus"] = status });
            case ImportOutcome.Failed:
                return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: "Download from the Homebrewery failed",
                    detail: "The Homebrewery did not answer with the brew's text. Try again later.");
            case var other:
                throw new InvalidOperationException($"Unexpected outcome {other.GetType().Name}.");
        }
    }
}
