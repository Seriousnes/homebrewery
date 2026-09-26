using Microsoft.AspNetCore.Http.Metadata;

namespace Homebrewery.Api.Infrastructure;

/// <summary>
/// Endpoint metadata for a request body cap. Request decompression applies it to the decompressed body, so a
/// small gzip body cannot expand past it (zip bombs get 413).
/// </summary>
public sealed record RequestSizeLimit(long? MaxRequestBodySize) : IRequestSizeLimitMetadata;
