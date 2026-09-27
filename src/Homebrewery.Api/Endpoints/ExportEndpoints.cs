using System.Globalization;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Pdf;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Endpoints;

/// <summary>The exported brew (self-contained HTML, built by the web client) as a PDF.</summary>
/// <param name="Html">The exported HTML file (web/src/editor/export: exportBrewHtml).</param>
public sealed record PdfExportRequest(string Html);

/// <summary><c>/api/export/*</c>: files made from a brew on the server.</summary>
public static class ExportEndpoints
{
    /// <summary>Request body cap, before and after decompression (the host's Kestrel limit).</summary>
    public const long MaxRequestBytes = BrewRules.MaxRequestBytes;

    /// <summary>Response header: how many files the page asked for are not in the PDF.</summary>
    public const string MissingFilesHeader = "X-Pdf-Missing-Files";

    /// <summary>Retry-After of a 503 when every render slot is busy.</summary>
    public const int BusyRetryAfterSeconds = 5;

    public static RouteGroupBuilder MapExportEndpoints(this IEndpointRouteBuilder api)
    {
        var export = api.MapGroup("/export").WithTags("Export");

        // Anyone may export (share pages are read without an account). It is a POST only to carry the HTML: it stores
        // nothing, so it is one of EndpointAuditTests' listed anonymous writes. The rate limit is per user, or per
        // client address for anonymous callers; SameOriginWriteGuard still requires the site's own Origin.
        export.MapPost("/pdf", ExportPdfAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimits.Pdf)
            .WithMetadata(new RequestSizeLimit(MaxRequestBytes))
            .WithName("ExportPdf")
            .WithSummary("The exported brew (self-contained HTML) rendered as a PDF.")
            .WithDescription(
                "Renders `html` with headless Chromium: JavaScript off, page size from the HTML's `@page` rule, one brew " +
                "page per sheet. https images, fonts and stylesheets of other sites are fetched from public addresses " +
                "within per-render limits; every other request is blocked. The `" + MissingFilesHeader + "` header " +
                "counts the files that are not in the PDF. The body may be gzip-compressed and is capped at 20 MB. " +
                "400 when `html` is empty, 503 (with Retry-After when busy) when the renderer is busy or unavailable, " +
                "500 when the render fails or times out. No account needed; rate limited per user, or per client " +
                "address when signed out (429).")
            .Produces<Stream>(StatusCodes.Status200OK, "application/pdf")
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status413PayloadTooLarge)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status500InternalServerError)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        return export;
    }

    internal static async Task<Results<FileContentHttpResult, ValidationProblem, ProblemHttpResult>> ExportPdfAsync(
        PdfExportRequest request, HttpContext context, IPdfRenderer renderer, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Html))
        {
            return TypedResults.ValidationProblem(
                new Dictionary<string, string[]> { ["html"] = ["must be the exported HTML of a brew"] },
                title: "Nothing to render.");
        }

        try
        {
            var result = await renderer.RenderAsync(request.Html, ct);
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers[MissingFilesHeader] = result.MissingFiles.ToString(CultureInfo.InvariantCulture);
            return TypedResults.File(result.Pdf, "application/pdf");
        }
        catch (PdfRendererBusyException)
        {
            context.Response.Headers.RetryAfter = BusyRetryAfterSeconds.ToString(CultureInfo.InvariantCulture);
            return TypedResults.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "PDF export is busy",
                detail: $"Too many PDFs are being made right now. Try again in {BusyRetryAfterSeconds} seconds.");
        }
        catch (PdfRendererUnavailableException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "PDF export is unavailable",
                detail: "The server can't make PDFs right now.");
        }
        catch (PdfRenderFailedException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status500InternalServerError, title: "Couldn't make the PDF",
                detail: ex.Message);
        }
    }
}
