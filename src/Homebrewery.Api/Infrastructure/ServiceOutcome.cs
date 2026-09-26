using Microsoft.AspNetCore.Http.HttpResults;

namespace Homebrewery.Api.Infrastructure;

/// <summary>What a notification or admin service call produced; endpoints map it to HTTP (<see cref="ServiceOutcomes.ToProblem{T}"/> for the errors).</summary>
public abstract record ServiceOutcome<T>
{
    private ServiceOutcome()
    {
    }

    /// <summary>200 (or 201).</summary>
    public sealed record Ok(T Value) : ServiceOutcome<T>;

    /// <summary>404 with this problem title.</summary>
    public sealed record NotFound(string Title) : ServiceOutcome<T>;

    /// <summary>400 validation problem, errors keyed by field.</summary>
    public sealed record Invalid(IDictionary<string, string[]> Errors) : ServiceOutcome<T>;

    /// <summary>403 problem.</summary>
    public sealed record Forbidden(string Detail) : ServiceOutcome<T>;

    /// <summary>409 problem.</summary>
    public sealed record Conflict(string Title, string Detail) : ServiceOutcome<T>;
}

public static class ServiceOutcomes
{
    /// <summary>
    /// The error cases of <paramref name="outcome"/> as problem+json. Endpoints map <see cref="ServiceOutcome{T}.Invalid"/>
    /// to <c>TypedResults.ValidationProblem</c> themselves (for the OpenAPI schema); here it is a plain 400 problem
    /// with the same <c>errors</c>.
    /// </summary>
    /// <exception cref="InvalidOperationException">The outcome is <see cref="ServiceOutcome{T}.Ok"/>.</exception>
    public static ProblemHttpResult ToProblem<T>(this ServiceOutcome<T> outcome) => outcome switch
    {
        ServiceOutcome<T>.Invalid invalid => TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest,
            title: "One or more validation errors occurred.",
            extensions: new Dictionary<string, object?> { ["errors"] = invalid.Errors }),
        ServiceOutcome<T>.NotFound notFound => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: notFound.Title),
        ServiceOutcome<T>.Forbidden forbidden => TypedResults.Problem(
            statusCode: StatusCodes.Status403Forbidden, title: "Forbidden", detail: forbidden.Detail),
        ServiceOutcome<T>.Conflict conflict => TypedResults.Problem(
            statusCode: StatusCodes.Status409Conflict, title: conflict.Title, detail: conflict.Detail),
        _ => throw new InvalidOperationException($"{outcome.GetType().Name} is not an error."),
    };
}
