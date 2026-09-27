using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// The OpenAPI document (<c>/openapi/v1.json</c>, Development and Testing only) that web/ generates its client types from.
/// </summary>
/// <remarks>
/// The committed copy is <c>shared/openapi.json</c>; <c>npm --prefix web run api:types</c> turns it into
/// <c>web/src/api/schema.d.ts</c>. The test <c>OpenApiExportTests</c> fails when the copy is stale; run it with
/// <c>HB_UPDATE_OPENAPI=1</c> to rewrite it (see that test for the command).
/// </remarks>
public static class ApiDocument
{
    public const string Path = "/openapi/v1.json";

    public static IServiceCollection AddApiDocument(this IServiceCollection services) =>
        services.AddOpenApi(o => o.AddDocumentTransformer((document, _, _) =>
        {
            document.Info = new OpenApiInfo
            {
                Title = "Homebrewery API",
                Version = "v1",
                Description = "The Homebrewery WYSIWYG back end. Same origin as the SPA: " +
                              "cookie sign-in, and writes need an Origin header matching the site. Errors are problem+json.",
            };
            // The SPA calls relative URLs on its own origin; the request's host would only make the export machine-specific.
            document.Servers = [];
            CollapseNullableAny(document);
            return Task.CompletedTask;
        }));

    /// <summary>
    /// A nullable property whose type accepts any JSON value (<c>RawJson?</c>: <c>oneOf: [{type: null}, {$ref: RawJson}]</c>)
    /// becomes the plain reference: null is already a JSON value. Otherwise the generated TypeScript is
    /// <c>null | unknown</c>, which the web lint rejects as redundant.
    /// </summary>
    private static void CollapseNullableAny(OpenApiDocument document)
    {
        if (document.Components?.Schemas is not { } schemas) return;
        var any = schemas.Where(s => s.Value is OpenApiSchema schema && AcceptsAnything(schema)).Select(s => s.Key).ToHashSet();
        if (any.Count == 0) return;

        foreach (var schema in schemas.Values.OfType<OpenApiSchema>())
        {
            if (schema.Properties is null) continue;
            foreach (var (name, property) in schema.Properties.ToList())
            {
                if (property is OpenApiSchema { OneOf: [OpenApiSchema { Type: JsonSchemaType.Null }, OpenApiSchemaReference target] }
                    && target.Reference.Id is { } id && any.Contains(id))
                {
                    schema.Properties[name] = target;
                }
            }
        }
    }

    private static bool AcceptsAnything(OpenApiSchema schema) =>
        schema.Type is null
        && schema.Properties is not { Count: > 0 }
        && schema.Items is null
        && schema.AdditionalProperties is null
        && schema.OneOf is not { Count: > 0 }
        && schema.AnyOf is not { Count: > 0 }
        && schema.AllOf is not { Count: > 0 }
        && schema.Enum is not { Count: > 0 }
        && schema.Const is null;
}
