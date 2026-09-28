using System.Text.Json;
using System.Text.Json.Serialization;
using Homebrewery.Api.Admin;
using Homebrewery.Api.Brews;
using Homebrewery.Api.Endpoints;
using Homebrewery.Api.Import;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Api.Infrastructure.Identity;
using Homebrewery.Api.Notifications;
using Homebrewery.Api.Pdf;
using Homebrewery.Api.Themes;
using Homebrewery.Core;
using Homebrewery.Core.Documents;
using Homebrewery.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.DependencyInjection.Extensions;

// Plan §8.1 has the full shape.

var builder = WebApplication.CreateBuilder(args);

// Brew saves send whole documents, gzip-compressed (plan §8.4). Kestrel caps the wire body; request
// decompression caps the inflated body with the brew endpoints' RequestSizeLimit metadata.
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = BrewRules.MaxRequestBytes);
builder.Services.AddRequestDecompression();
builder.Services.ConfigureHttpJsonOptions(o =>
{
    // A document may nest DocInspector.MaxDepth nodes, two JSON levels each; deeper JSON is a 400.
    o.SerializerOptions.MaxDepth = DocInspector.MaxJsonDepth;
    // Enums as camelCase strings (AuthorRole: "owner" | "author" | "invited"), also in the OpenAPI document.
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
    // Numbers are JSON numbers only (the web defaults also accept "1"), so the OpenAPI types are plain integers.
    o.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
});

// Errors are problem+json everywhere: unhandled exceptions (UseExceptionHandler), bodyless error responses under /api
// (UseStatusCodePages), and the problems the endpoints return. Development adds the exception text.
builder.Services.AddProblemDetails(o => o.CustomizeProblemDetails = ctx =>
{
    if (ctx.Exception is { } ex && ctx.HttpContext.RequestServices.GetRequiredService<IHostEnvironment>().IsDevelopment())
    {
        ctx.ProblemDetails.Detail ??= ex.Message;
        ctx.ProblemDetails.Extensions["exception"] = ex.ToString();
    }
});
// Development throws BadHttpRequestException for request binding errors (RouteHandlerOptions.ThrowOnBadRequest); answer
// them with their own status (400, 413, ...) as the other environments do, not with a 500.
builder.Services.Configure<ExceptionHandlerOptions>(o => o.StatusCodeSelector = ex =>
    ex is BadHttpRequestException badRequest ? badRequest.StatusCode : StatusCodes.Status500InternalServerError);
builder.Services.AddProxyForwardedHeaders();                // X-Forwarded-For/-Proto/-Host behind a reverse proxy
builder.Services.AddSecurityHeaders();                      // CSP, HSTS, nosniff, ... (SecurityHeaders:*)
builder.Services.AddRateLimits();                           // RateLimits:* (auth, import, pdf, writes)
builder.Services.TryAddSingleton(TimeProvider.System);

// The connection string is read when the context is created, not here, so test hosts
// (WebApplicationFactory) can supply it. DatabaseInitializer fails startup when it is missing.
builder.Services.AddDbContext<AppDbContext>((sp, o) => o.UseHomebreweryNpgsql(
    sp.GetRequiredService<IConfiguration>().GetConnectionString(AppDbContext.ConnectionStringName)));

builder.Services
    .AddIdentityApiEndpoints<AppUser>(o =>
    {
        o.User.RequireUniqueEmail = true;
        o.Stores.SchemaVersion = AppDbContext.IdentitySchemaVersion;    // the migrations' Identity schema (passkeys)
    })
    .AddRoles<IdentityRole<Guid>>()
    .AddEntityFrameworkStores<AppDbContext>()
    .AddUserManager<AppUserManager>()                                   // default handle, admin on register
    .AddSignInManager<AppSignInManager>()                               // admin on sign-in
    .AddUserValidator<HandleValidator>();
builder.Services.ConfigureApplicationCookie(o =>
{
    o.Cookie.HttpOnly = true;          // upstream's session cookie was readable from JS; don't repeat that
    o.Cookie.SameSite = SameSiteMode.Lax;
    o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
    o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
});
builder.Services.AddAuthCookieSecurity();                               // Auth:CookieSecurePolicy (Secure over HTTPS, also via the proxy)
builder.Services.AddPersistentDataProtection();                         // DataProtection:KeysPath: sign-ins survive re-created containers
builder.Services.AddAuthorizationBuilder().AddPolicy(Policies.Admin, p => p.RequireRole(Roles.Admin));
builder.Services.AddSingleton<AdminAccounts>();                         // Admin:Emails
builder.Services.AddHostedService<DatabaseInitializer>();               // connection check, migrations, admin seeding
builder.Services.AddDocumentValidation();                               // shared/schema-manifest.json + DocInspector
builder.Services.AddScoped<BrewService>();
builder.Services.AddScoped<BrewListService>();                          // vault search, user brew lists
builder.Services.AddThemes();                                           // themes.json catalog + user themes (Themes:*)
builder.Services.AddScoped<NotificationService>();
builder.Services.AddScoped<AdminService>();                             // stats, lookups, locks
builder.Services.AddUpstreamImport();                                   // homebrewery.naturalcrit.com /download proxy
builder.Services.AddPdfExport();                                        // headless Chromium for /api/export/pdf (Pdf:*)
builder.Services.AddSingleton<SpaIndex>();                              // index.html for ShareShell (Spa:DevServerUrl)
builder.Services.AddHttpClient(SpaIndex.DevServerClient, c => c.Timeout = TimeSpan.FromSeconds(5));

builder.Services.AddApiDocument();                          // web/ generates its client from this (shared/openapi.json)
builder.Services.AddAppHealthChecks();                      // /healthz checks the database (SELECT 1)
builder.Services.AddAppLogging();                           // JSON console logs outside Development (P8.4)

// UseStaticFiles and MapFallbackToFile both read these options. The defaults already cover every
// theme asset type (.woff2 .otf .webp .svg ...); only .woff and .ttf still use pre-RFC 8081 names.
builder.Services.Configure<StaticFileOptions>(o =>
{
    var contentTypes = new FileExtensionContentTypeProvider();
    contentTypes.Mappings[".woff"] = "font/woff";
    contentTypes.Mappings[".ttf"] = "font/ttf";
    o.ContentTypeProvider = contentTypes;
});

var app = builder.Build();

// `migrate` (first argument): apply migrations, seed the Admin role, exit without serving (P8.4).
if (MigrateCommand.IsRequested(args)) { Environment.ExitCode = await MigrateCommand.RunAsync(app); return; }

app.UseRequestLogging();                                    // one log entry per request: method, route template, status, ms (P8.4)
// Forwarded headers run before this pipeline when ASPNETCORE_FORWARDEDHEADERS_ENABLED=true (ForwardedHeadersSetup).
app.UseSecurityHeaders();                                   // first, so every response (errors too) gets them (P8.3)
app.UseExceptionHandler();                                  // unhandled exceptions: 500 problem+json
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/api"),
    branch => branch.UseStatusCodePages());                 // bodyless 4xx/5xx under /api (401, 405, ...): problem+json
app.UseRequestDecompression();                              // Content-Encoding: gzip | br | deflate
app.UseDefaultFiles();
app.UseStaticFiles();                                       // Vite build output in wwwroot
app.UseMiddleware<SameOriginWriteGuard>();                  // 403 for POST/PUT/PATCH/DELETE from another origin
app.UseAuthentication();
app.UseRateLimiter();                                       // after authentication (per-user import limit), before
app.UseAuthorization();                                     // authorization, so rejected anonymous writes count too

// /openapi/v1.json. Also in the Testing environment, where tests check the document the web client is
// generated from.
if (app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing")) app.MapOpenApi(ApiDocument.Path);

app.MapAppHealthChecks();                                   // /healthz: 200 {status:'ok', checks:{database:'ok'}} or 503

var api = app.MapGroup("/api");
api.MapGroup("/auth").MapIdentityApi<AppUser>().WithTags("Auth").RequireRateLimiting(RateLimits.Auth)
    .AddEndpointFilter(RegisterPrivacy.HideExistingAccounts);  // /register must not reveal which emails have accounts
api.MapAccountEndpoints();
api.MapBrewEndpoints();
api.MapBrewListEndpoints();                                 // /vault, /users/{handle}/brews
api.MapThemeEndpoints();
api.MapImportEndpoints();                                   // /import/homebrewery/{shareId}
api.MapExportEndpoints();                                   // /export/pdf
api.MapNotificationEndpoints();                             // /notifications/active
api.MapAdminEndpoints();                                    // the group itself requires the Admin policy

// Unmatched /api/* requests are API misses, not client-side routes: answer 404 problem+json
// instead of index.html. Fallback endpoints have the lowest order, so real /api endpoints win.
app.MapFallback("/api/{**path}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound));

app.MapGet("/share/{shareId}", ShareShell.RenderAsync)      // index.html + HTML-encoded link-preview tags (plan §8.8)
    .ExcludeFromDescription();
app.MapFallbackToFile("index.html");

app.RunOrExit();                                            // a failed start is logged, then exits 1 (P8.4)

public partial class Program;                               // for WebApplicationFactory
