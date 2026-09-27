# Implementation notes (agent handoff)

Interfaces, conventions and deviations recorded by the agents that built each task. Read the section for the area you touch; update it when you change an interface. The plan (docs/wysiwyg-plan.md) stays the spec; this file records what was actually built.

**Test timeouts: the fail-fast rule supersedes older notes.** Many sections below were written on an overloaded machine and mention long test timeouts (90 s to 40 min, `test.slow`, `navigationTimeout: 90_000`, 150–180 s load waits) or advice such as "run Firefox with one worker". Those timeouts are gone. The limits now are: Playwright 15 s per test, 5 s expect and action, 10 s navigation, explicit overrides at most 60 s; Vitest 5 s per test. There are no long tests and no long test runs (no `@long` tag, no `E2E_LONG` / `HB_LONG` switch, no nightly long jobs): coverage that took minutes is now many short tests (the 1,000-edit fuzzes are 20 tests of 50 edits per browser, the unit fuzz 4 × 250; the perf budgets are `@serial`, one budget per test; the full fidelity runs are one short test per fixture or chunk, split into short sets). Every Playwright run is capped at 5 minutes, so the whole suite runs as short sets (e2e/suiteSets.mjs: `node e2e/matrix/run-suite.mjs`, 6 parallel sets and 2 serial ones, each 2 to 3 minutes). Notes below that mention `@long`, `E2E_LONG`, the `*-long` projects or the nightly jobs describe the old setup. docs/testing.md is the reference, and web/scripts/testTimeouts.test.ts enforces the caps.



## Backend: data model and identity (P2.1, P2.2)

### Interfaces
ENTITIES (namespace Homebrewery.Core, project src/Homebrewery.Core)
- Brew: plan §8.2 shape. Timestamps must be UTC (DateTimeOffset.UtcNow). SearchVector is NpgsqlTsVector, generated and read-only.
- BrewAuthor { BrewId, UserId, AuthorRole Role, short Position, AppUser? User (optional navigation) }.
- enum AuthorRole : short { Owner = 0, Author = 1, Invited = 2 }.
- BrewLock { int Code, string EditMessage, string ShareMessage, DateTimeOffset Applied, DateTimeOffset? ReviewRequested }. Stored as jsonb column "lock" with camelCase keys, e.g. lock->>'reviewRequested'.
- Notification { Guid Id, DismissKey, Title, Body, StartsAt, StopsAt, CreatedAt }.
- AppUser : IdentityUser<Guid> { string Handle }. Id is a v7 Guid.
- Roles.Admin = "Admin".
- static Handles: Normalize(string?) (trim + lower-invariant), IsValid(string?) (\A[a-z0-9_-]{3,32}\z), FromEmail(string?), WithSuffix(base, n), Rules (message text), SqlPattern, MinLength = 3, MaxLength = 32. To look up /user/{handle}: `var h = Handles.Normalize(input); db.Users.Where(u => u.Handle == h)`.

DATA (namespace Homebrewery.Data)
- AppDbContext : IdentityDbContext<AppUser, IdentityRole<Guid>, Guid>, with DbSets Brews, BrewAuthors, Notifications (plus Users, Roles, …).
- AppDbContext.ConnectionStringName = "Homebrewery".
- AppDbContext.IdentitySchemaVersion = IdentitySchemaVersions.Version3. Program sets IdentityOptions.Stores.SchemaVersion to it.
- Always resolve AppDbContext from DI. Outside DI, use `new AppDbContext(AppDbContext.CreateStandaloneOptions(cs))`. A context built without IdentityOptions throws on purpose, because Identity reads the schema version from the application services.
- DbContextOptionsBuilder.UseHomebreweryNpgsql(string? cs) = UseNpgsql + UseSnakeCaseNamingConvention.
- DbErrors.IsUniqueViolation(DbUpdateException, string? constraintName = null).
- Constants: AppUserConfiguration.HandleIndexName = "ix_asp_net_users_handle", AppUserConfiguration.HandleCheckName = "ck_asp_net_users_handle", BrewConfiguration.PublishedUpdatedIndexName = "ix_brews_published_updated".
- Table names: brews, brew_authors, notifications, asp_net_users (…all Identity tables snake_case), plus __EFMigrationsHistory.
- Unique indexes: ix_brews_share_id, ix_brews_edit_id, ix_notifications_dismiss_key.
- Migrations live in src/Homebrewery.Data/Migrations (first one: 20260924103638_InitialCreate). Add new ones with: dotnet tool restore; dotnet ef migrations add <Name> --project src/Homebrewery.Data --startup-project src/Homebrewery.Api. SchemaTests fail if the model has changes without a migration.

API (src/Homebrewery.Api)
- Routes:
  - /api/auth/* (MapIdentityApi: register, login?useCookies=true, refresh, confirmEmail, manage/info, …).
  - GET /api/account/me → 200 AccountInfo {id, handle, email, roles[]} or 204 when anonymous.
  - POST /api/account/logout → 204 (requires a signed-in user).
  - PUT /api/account/handle, body SetHandleRequest {handle} → 200 AccountInfo; 400 ValidationProblem with errors.handle; 409 problem+json 'Handle taken'; 401 when anonymous.
  - GET /api/admin/ping → 200 {status:'pong'}.
- Endpoint mapping: static class Homebrewery.Api.Endpoints.AccountEndpoints.MapAccountEndpoints(this IEndpointRouteBuilder) and AdminEndpoints.MapAdminEndpoints(this IEndpointRouteBuilder). MapAdminEndpoints returns the /admin RouteGroupBuilder, which already calls RequireAuthorization(Policies.Admin). Add admin endpoints inside that group.
- Program: `var api = app.MapGroup("/api")`. Map new endpoint groups there, before the /api/{**path} 404 fallback.
- Auth: the default scheme is Identity's BearerAndApplication (cookie for the SPA). Protected endpoints answer 401 or 403 without redirects. Policy name: Homebrewery.Api.Infrastructure.Identity.Policies.Admin = "Admin". Get the current user with UserManager<AppUser>.GetUserAsync(ClaimsPrincipal) or the NameIdentifier claim (a Guid string).
- Identity services (Homebrewery.Api.Infrastructure.Identity):
  - AppUserManager is registered as UserManager<AppUser> and can also be injected directly. It exposes FindFreeHandleAsync(base, ct) and IsHandleTakenAsync(handle, exceptUserId, ct).
  - AppSignInManager.
  - HandleValidator (IUserValidator; checks format only).
  - AdminAccounts (singleton): Emails, RequireConfirmedEmail, IsEligible(user), EnsureRoleAsync(users, user), SeedAsync(sp, ct).
- DatabaseInitializer (IHostedLifecycleService.StartingAsync, runs before Kestrel starts): checks the connection string, then migrates or fails on pending migrations, then seeds the Admin role.
- Configuration keys:
  - ConnectionStrings:Homebrewery (required; only Development has a default).
  - Database:MigrateOnStartup (bool, default false; compose should set it true).
  - Admin:Emails: array (Admin__Emails__0=…) or one string separated by , ; or whitespace (Admin__Emails=a@x;b@y).
  - Admin:RequireConfirmedEmail (default true; false in appsettings.Development.json).

TESTS (tests/Homebrewery.Api.Tests; namespace Homebrewery.Api.Tests.Infrastructure)
- Put [Collection(ApiCollection.Name)] on the test class and take ApiFixture api in the constructor. Tests in the collection run one at a time.
- api.Factory is a started HomebreweryApiFactory (env 'Testing', empty temp web root, migrated, Admin role exists, no admin emails configured). Its clients send `Origin: http://localhost` by default, for the P2.7 SameOriginWriteGuard.
- api.ConnectionString is the connection string of the test database.
- Per-host config: `await using var host = api.Factory.WithWebHostBuilder(b => b.UseSetting(k, v));`.
- Helpers are extension methods on WebApplicationFactory<Program>:
  - RegisterAsync(email, password?, ct)
  - SignInAsync(email, password?, ct) → cookie HttpClient
  - CreateUserAsync(email?, ct) → TestUser(Id, Handle, Email, Password, Client), which is IDisposable
  - CreateAdminAsync(ct)
  - SignInUserAsync(email, ct)
  - WithServicesAsync(Func<IServiceProvider, Task[<T>]>)
  - WithDbAsync<T>(Func<AppDbContext, Task<T>>)
- TestUsers.Password = "Passw0rd!". TestUsers.UniqueEmail(prefix).
- ScratchDatabase.CreateAsync(api.ConnectionString, ct) gives an empty extra database that is dropped on dispose.
- The database is shared for the whole run and never reset: always create your own data and never assume an empty table.
- For a custom web root: api.Factory.WithWebHostBuilder(b => b.UseWebRoot(path)), as in StaticFilesTests.TempWebRoot.

### Notes for later phases
- Default handles are public and reveal the email local part (plus-tags removed, accents stripped, '.' becomes '-'). The client should prompt new users to pick a handle after registration. This choice and its trade-off are documented on Handles in src/Homebrewery.Core/Handles.cs.
- Identity's default AllowedUserNameCharacters applies to the username, which is the email. Emails containing an apostrophe (o'brien@…) or non-ASCII characters currently fail /api/auth/register with InvalidUserName. Consider setting o.User.AllowedUserNameCharacters = null in Program.cs.
- Brew.SearchVector is a computed column, so EF reads it back (RETURNING) on every INSERT and UPDATE of a brew, and plain entity loads select it. With search_text up to 200 KB, P2.3 and P2.6 should project it away in reads. For autosave, consider an ExecuteUpdate-based save or ignoring its after-save behaviour.
- The brews columns have database defaults matching §8.2. Because of EF sentinel semantics, inserting Version/PageCount/DocSchemaVersion = 0 stores 1, and Published=false or Views=0 are left out of the INSERT and read back. This is harmless, but don't rely on writing 0 to those columns.
- lz4 compression on brews.doc is raw SQL in InitialCreate and not part of the EF model. Re-apply it if a future migration rebuilds that column.
- Admin:RequireConfirmedEmail defaults to true and there is no IEmailSender yet, so emails never get confirmed. For a production admin, set email_confirmed=true on the row (or turn the flag off while creating the account), or add an email sender. Removing an email from Admin:Emails does not revoke the role.
- P8 hardening: behind Caddy/TLS, add ForwardedHeaders so the cookie is marked Secure (the cookie SecurePolicy is SameAsRequest). Persist DataProtection keys (e.g. Microsoft.AspNetCore.DataProtection.EntityFrameworkCore into this database), or containers invalidate cookies on restart.
- P2.7: rate-limit /api/auth/* and PUT /api/account/handle. Consider returning 401/403 as problem+json once AddProblemDetails is in.
- /register no longer reveals existing accounts: RegisterPrivacy (Infrastructure/Identity, an endpoint filter on the /api/auth group) turns Identity's DuplicateUserName/DuplicateEmail-only errors into the same empty 200 a new registration gets; the existing account is unchanged. Password and email-format errors are still 400. Residual: signing in with the password just registered still tells the cases apart; closing that needs confirmed emails (an IEmailSender) and a uniform "check your email" answer.
- Put P2.3+ integration tests in [Collection(ApiCollection.Name)]; don't start more containers. The run is serial, about 20 s now.
- Npgsql rejects DateTimeOffset values with a non-zero offset for timestamptz; always use UtcNow.
- __EFMigrationsHistory keeps EF's default name. If you want it snake_case, it has to be set via MigrationsHistoryTable in UseHomebreweryNpgsql before any production deploy.


## Container-first dev stack (compose + Caddy)

### Interfaces
Commands:
- Dev stack: `docker compose up` (or `docker compose up -d --wait`) → http://localhost:8080. Only Caddy publishes a port (127.0.0.1:${HB_HTTP_PORT:-8080}); db stays on 0.0.0.0:5432. The containers do NOT publish 5080 or 5173, so host `dotnet run` (:5080), host Vite (:5173) and Playwright (E2E_PORT) never collide with them.
- DB only (host dev, backend agents, unchanged): `docker compose up -d db`.
- Production image: `docker compose -f docker-compose.yml -f compose.prod.yml up -d --build` (service `app`, image `homebrewery:local`, the root Dockerfile; dev api/web scaled to 0). Back to dev: `docker compose up -d --remove-orphans`.
- Stop dev servers but keep the db: `docker compose stop api web caddy`.
- Compose project name is the directory name (wysiwyg-editor); do not add `name:`, because it would create a second db on port 5432.

Service contract (docker-compose.yml):
- `api`: mcr.microsoft.com/dotnet/sdk:10.0, `dotnet watch run --project src/Homebrewery.Api --no-launch-profile --non-interactive`, working dir /repo (whole repo bind-mounted), Kestrel on :8080. Env:
  - ASPNETCORE_ENVIRONMENT=Development, ASPNETCORE_HTTP_PORTS=8080, ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
  - ConnectionStrings__Homebrewery=Host=db;Port=5432;Database=homebrewery;Username=homebrewery;Password=homebrewery
  - Database__MigrateOnStartup=true
  - DOTNET_USE_POLLING_FILE_WATCHER=1, DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1, DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1
  - Named volumes over src/Homebrewery.{Api,Core,Data}/{bin,obj} and tests/Homebrewery.Api.Tests/{bin,obj}, plus nuget-packages (/root/.nuget/packages) and aspnet-keys (/root/.aspnet).
  - restart: on-failure. Healthcheck: curl /healthz with a 10m start_period.
  - A NEW .NET project under src/ or tests/ needs its own bin/obj volume entries in docker-compose.yml, or its Linux build output lands in the host tree.
- `web`: node:24, working dir /repo/web (whole repo bind-mounted), web/node_modules in the named volume `web-node-modules`. Runs `npm ci` only when sha256(package-lock.json) or `node --version` differs from node_modules/.hb-install-stamp, then `npm run dev -- --host 0.0.0.0 --port 5173`. Env: HB_API_URL=http://api:8080, HB_WATCH_POLLING=1, HB_HMR_CLIENT_PORT=${HB_HTTP_PORT:-8080}. restart: on-failure. Healthcheck: node fetch of http://localhost:5173/.
- `caddy`: caddy:2, `caddy run --watch`, config dir ./deploy/caddy mounted at /etc/caddy. Env HB_HTTP_PORT (default 8080), HB_API_UPSTREAM (api:8080; app:8080 in prod), HB_WEB_UPSTREAM (web:5173; app:8080 in prod). Routes `/api`, `/api/*`, `/share`, `/share/*`, `/openapi`, `/openapi/*` and `/healthz` to the API; everything else to web. The Host header is preserved (the API and Vite see localhost:8080), and X-Forwarded-For/Proto/Host are added. A new server-side top-level path must be added to the `@api` matcher in deploy/caddy/Caddyfile.

web/vite.config.ts (server section), env-driven and all unset on the host:
- HB_WATCH_POLLING=1|true → server.watch = {usePolling:true, interval:300, binaryInterval:1000}.
- HB_HMR_CLIENT_PORT=<n> → server.ws.clientPort (Vite 8.3 replacement for the deprecated server.hmr.clientPort).
- HB_API_URL (existing) → proxy target, default http://localhost:5080.
- The container passes --host 0.0.0.0 on the CLI; allowedHosts is not needed because Caddy forwards Host=localhost:8080.

.dockerignore also excludes compose*.yml and deploy/caddy/ from the production build context.

### Notes for later phases
- Backend (ForwardedHeaders task): the compose files set ASPNETCORE_FORWARDEDHEADERS_ENABLED=true (built-in, trusts any peer). If Program.cs adds an explicit UseForwardedHeaders with its own config key, tell the owner of docker-compose.yml/compose.prod.yml to switch to that key, so the middleware isn't configured twice.
- Backend: `Database__MigrateOnStartup=true` in the dev api container means every api (re)start migrates the SHARED compose db. When iterating on a migration (remove and re-add InitialCreate), stop the dev api container first (`docker compose stop api`), or the db history can end up out of sync with the files on disk.
- Backend P2 (ThemeCatalog): in the dev container, src/Homebrewery.Api/wwwroot is whatever the host last built, because Vite serves /themes in dev. If the server reads wwwroot/themes/themes.json at runtime, dev (host or container) needs a fallback or a prior `npm run build`.
- Backend P8: persist Data Protection keys (e.g. PersistKeysToDbContext) so production containers keep sign-ins across re-creation. The dev container already persists /root/.aspnet in a volume.
- Repo hygiene: add `.env` to .gitignore; README suggests .env for HB_HTTP_PORT.
- If a new .NET project is added under src/ or tests/, add bin/obj named volumes for it in docker-compose.yml (api service). Otherwise container builds write Linux obj/project.assets.json into the host tree.
- Changing the web/ dependency set needs no action: the web container runs npm ci on its next start when package-lock.json changes. Run `docker compose restart web` to trigger it right away.
- dotnet watch's polling watcher can crash on bind mounts while directories change mid-scan (seen once in this session: ArgumentException 'An item with the same key has already been added'). restart: on-failure recovers it. If it becomes frequent, consider narrowing what dotnet watch polls.


## Editor schema, plugins, theme loader, canvas.css, dev registry (P3.1)

### Interfaces
SCHEMA (web/src/editor/schema/index.ts; relative imports only inside schema/, no DOM at import time):
- createSchemaExtensions(options?: { link?: Partial<LinkOptions> }): AnyExtension[]; schemaExtensions: AnyExtension[] (use for getSchema/generateJSON/generateHTML/manifest); DOC_SCHEMA_VERSION = 1; migrateDoc(json: JSONContent, fromVersion: number): JSONContent (same object for v1; throws RangeError for >1 or <1).
- Extensions (extend these for NodeViews): HbDocument('doc', content 'page+'), Page, HbText, HbParagraph, HbHeading, HbBulletList, HbOrderedList, HbListItem, DefinitionList, DefinitionTerm, DefinitionDesc, HbBlockquote, HbCodeBlock, HbHorizontalRule, HbTable, HbTableRow, HbTableHeader, HbTableCell, ThemeBlock, ColumnBreak, Spacer, Toc, RawHtml, HbImage, Icon, RawInline, InlineBox, HbHardBreak, Span, createHbLink(opts), HbBold, HbItalic, HbUnderline, HbStrike, HbCode, HbSuperscript, HbSubscript, HbAttributes.
- Attributes (generic = classes: string[], style: string|null, id: string|null, attributes: Record<string,string>, on HB_ATTR_TYPES):
  page: pid, kind 'manual'|'auto', columns 1|2|null, markers string[], pageNumber boolean, footer string|null, objects PageObject[], oversized (not rendered), plus generic. normalizeMarkers / normalizePageObjects (render and parse) drop RESERVED_CLASSES and editor-state classes, and the page rule's flow is `:scope > div.columnWrapper` (review fix RV-9: a marker 'columnWrapper' hijacked the flow). attrs.ts also exports isAuthorClass(c).
  paragraph: align 'left'|'right'|'center'|'justify'|null, continuation, plus generic.
  heading: level, customId boolean (true = author's id; otherwise the HeadingIds plugin owns `id`), plus generic. Parsing HTML without data-custom-id (review fix RV-13): an id counts as generated only if it is exactly upstream's slug for that heading at its place in document order (slug.ts isGeneratedHeadingId; ids of data-custom-id headings are taken first), so an author's {#intro-2} stays custom; in this editor's clipboard HTML (data-pm-slice) any slug or slug-n id is generated.
  bulletList / orderedList(start, type) / listItem: continuation, plus generic.
  definitionList: multiline, continuation, plus generic. definitionTerm, definitionDesc: continuation.
  codeBlock: language.
  tableCell / tableHeader: colspan, rowspan, colwidth number[]|null, align 'left'|'right'|'center'|null, width string|null (upstream %).
  toc: depth 1-6 (default 3), wide (default true), title (default 'Contents'). HTML without a valid data-depth (an imported {{toc,wide …}}, pasted upstream HTML) parses as depth 6, so the theme's --TOC decides as upstream's generator did (Blank's .tocDepthH4… / .tocIncludeH4… re-include h4–h6; review UI-8). JSON without depth still gets 3; the manifest default is unchanged.
  rawHtml: html. rawInline (inline atom, review fix RV-6): html, for svg/math/video/audio/canvas/map/object/picture inside paragraph, heading, dt or dd (ParseRule context; elsewhere they stay block rawHtml); multi-root HTML renders in span[data-hb-raw]. image: src, alt, title, width, height, plus generic. icon: font (ICON_FONTS: 'df'|'ei'|'gi'|'fas'|'far'|'fab'|'fa'|'fa-solid'|'fa-regular'|'fa-brands'|'fa-classic'; the first icon-font class in class order, so raw FA markup renders back as written), glyph (the other classes). inlineBox: generic.
  span mark: classes, style, id, attributes; excludes '' and outermost.
  continuation renders class hb-continued.
- Page DOM contract (PageView must emit the same): div.page[.hb-cols-1|.hb-cols-2 + author classes][data-kind][data-pid][data-markers JSON][data-objects JSON][data-footer][data-page-number] > span.inline-block.<marker>…, objects (img | span.inline-block), span.inline-block.footnote, span.inline-block.pageNumber.auto, then div.columnWrapper (contentDOM). Helpers: pageChromeSpec(attrs): DOMOutputSpec[]; pageClass(columns, authorClass): string. Also exported: SECTION_ATTRS, PAGE_MARKERS, PageObject/PageAttrs/PageKind types.
- Other exports: HB_ATTR_TYPES, RESERVED_ATTRS (includes data-hb-clipboard), RESERVED_CLASSES, SAFE_ATTR, RAW_HTML_TAGS, RAW_INLINE_TAGS, ICON_FONTS, LINK_DEFAULTS, cleanClasses, cleanAttributes, isAllowedAttribute, normalizeMarkers, normalizePageObjects, markMultilineDefinitionLists(root: ParentNode) (importer/snippets MUST call it on hbfm HTML before generateJSON/insertContent), normalizeStyle(style, doc?) (inspector: store style normalized like cssText), parseStyle, hbSrcDeclaration, stripHbSrc, isSafeHref (links) / isSafeSrc (image and page-object src) / urlScheme (mirror the server UrlPolicy: http, https, mailto, relative, #anchor for links; http, https, relative, data:image/* for sources; review fix RV-14. Since review SEC-2 urlScheme and the data:image/ check scan like UrlPolicy.SchemeOf: ignored characters (C0, DEL, JavaScript \s) are skipped wherever they are and however many, schemes of any length are read, nothing is cut first; shared/url-policy-cases.json has no clientGap cases left), isSafeUrl (deprecated deny-list, no longer used by the schema), sanitizeRawHtml (DOMPurify, also removes what RawHtmlSanitizer removes: forms and controls, SVG use/foreignObject/animation, tabindex, formaction, URLs other than http/https/mailto/relative), HeadingSlugger, headingSlugSource, slugify. JSON types: DocJSON, PageJSON, NodeName, MarkName, ParagraphAttrs, HeadingAttrs, OrderedListAttrs, DefinitionListAttrs, CodeBlockAttrs, TableCellAttrs, ImageAttrs, IconAttrs, RawHtmlAttrs, RawInlineAttrs, LinkAttrs, SpanAttrs, HbGenericAttrs, TocAttrs.
- Attributes with a `validate` type string throw a RangeError when set with the wrong type (e.g. columns: '2').
- marked-hbfm types live in web/src/editor/schema/marked-hbfm.d.ts (exports hbfm: Hbfm, HbfmInjectedTags). Extend it; never declare 'marked-hbfm' a second time.
- Test helpers: web/src/editor/schema/testing.ts (schema, normalize, toHtml, fromHtml [TipTap path], fromDom [clipboard path], dom, text/node/p/page/docOf/docWith).

PLUGINS (web/src/editor/schema/plugins/index.ts):
- Extensions: HeadingIds, PageIds, PageIndexIds (DOM id 'p{n}', written on the page elements by its plugin view since P8.1's second pass, no longer node decorations: see the performance section), PagesRoot (class 'pages' on the ProseMirror root).
- Functions: headingIdUpdates(doc, keeps?) → {pos, id, customId?: false}[], assignHeadingIds(tr, keeps?), assignPageIds(tr, generate?, keeps?), pagesNeedingIds(doc, keeps?), newPageId() (8 chars [0-9a-z]), pageDomId(index) → 'p{index+1}', runOnceAfterInit(fix), survivors(transactions, before: () => Map<pos, id>) → Survives ((pos, id) => boolean: the node at pos of the new doc is the one that had id before).
- Uniqueness (review fixes RV-11, RV-12): generated heading slugs avoid the page ids p1…pN (a heading 'P2' gets 'p2-1'). A custom heading id or a pid held by two nodes stays with the node that had it before the transaction (mapped through it, so a copy pasted in front of its original doesn't take over); on mount, with the first in document order. The other heading becomes customId false with a generated slug; the other page gets a new pid.
- Keys: headingIdsKey, pageIdsKey, pageIndexIdsKey.
- LAYOUT_NEUTRAL_META = 'hbLayoutNeutral': set (with addToHistory: false) on the pid and heading-id transactions. Pagination should skip them; their AttrSteps have empty step maps.

EDITOR EXTENSIONS (web/src/editor/editorExtensions.ts): buildEditorExtensions(opts?: { schema?: SchemaExtensionOptions; history?: false | Partial<UndoRedoOptions>; dropcursor?: false | Partial<DropcursorOptions>; gapcursor?: boolean; extensions?: AnyExtension[] }): AnyExtension[]. An entry in opts.extensions with the same name as an existing extension replaces it in place (use this for NodeViews, since TipTap ignores editorProps.nodeViews). Other entries are appended. Configure TipTap with shouldRerenderOnTransaction: false.

MANIFEST: web/src/editor/schema/manifest.ts exports buildSchemaManifest(schema), serializeSchemaManifest(m), MANIFEST_VERSION, and types SchemaManifest / NodeManifest / MarkManifest / AttributeManifest / AttributeConstraints / AttributeKind ('url'|'html'|'css'|'classes'|'attributes'|'pageObjects'|'text').
shared/schema-manifest.json = { version, docSchemaVersion, topNode, generic{types, safeAttributePattern, reservedAttributes, reservedClasses}, pageMarkers, iconFonts, nodes{<name>: {attrs{<attr>: {default, type, kind?, enum?, integer?, min?, max?}}, content, group, inline, atom, leaf, textblock, marks ('_'|''|names), children[], allowsEmpty}}, marks{<name>: {attrs, excludes, inclusive}} }. DocInspector (P2.4) should read this file. enum/integer/min/max (review fix RV-15, from ATTR_CONSTRAINTS in manifest.ts; manifest.test.ts proves every enum value survives an HTML round trip) are additive, so MANIFEST_VERSION stays 1: page.kind, page.columns, paragraph.align, heading.level, toc.depth, table cell align (enums); colspan/rowspan, image width/height (integer, min 1); orderedList.start (integer).
Regenerate with `npm --prefix web run schema`. `npm --prefix web run schema -- --check` exits 1 when the file is stale.

THEME LOADER (web/src/editor/canvas/themeLoader.ts):
- loadThemeChain(theme, { source?: 'auto'|'api'|'static', fetch?, signal? }): Promise<ThemeChain> — GET /api/themes/{theme}/bundle first; falls back to /themes/themes.json on 404, 5xx, a network error or a bad body; a 422 is rethrown.
- loadThemeCatalog(opts); staticThemeChain(catalog, theme) (pure, root first).
- applyThemeStyles(chain, userCss?, { slot = 'canvas', scopeCss?: (css, baseURL) => CSSStyleSheet, document?, timeoutMs = 15000 }): Promise<AppliedThemeStyles { slot, links, sheets, failed, skippedCss, dispose }>. Links are inserted at the start of <head>. CSS text goes to adoptedStyleSheets only through scopeCss (cssScope.ts, canvas lane).
- disposeThemeSlot(slot, document?): removes every link and adopted sheet of the slot (review fix RV-4). A result's dispose() only knows its own links; an owner that goes away should dispose the slot.
- waitForFonts({ document?, root?, loadAll?, timeoutMs = 10000 }): Promise<boolean>.
- Types: ThemeStyle, ThemeSnippetRef, ThemeBundle, ThemeChain, ThemeCatalog(Entry), ThemeLoadError(.status). Constants: MAX_THEME_CHAIN = 8, THEME_CATALOG_URL, themeBundleUrl(theme).

CANVAS.CSS: `import '@/editor/canvas/canvas.css'` once where the canvas mounts. Expected DOM: div.hb-canvas[lang] > div.pages.ProseMirror > div.page. It provides:
- the upstream reset and base font at :where() zero specificity
- content-visibility: visible on pages
- .hb-cols-1/.hb-cols-2 column overrides
- .columnWrapper at height 100% with column-fill: auto
- non-wrapper children of .page are position: absolute by default
- .hb-continued with text-indent 0
- dl line breaks (class hb-dl-multiline)
- hooks for PageView: class .hb-oversized on the page and an element .hb-oversized-badge
Theme links must come before canvas.css in document order; applyThemeStyles guarantees this.

DEV REGISTRY: create web/src/dev/<name>/route.tsx that exports `path` ('/dev/<name>'), `element` (JSX) and optionally `title`, with the component in its own file. web/src/dev/registry.tsx (devPages) finds pages through import.meta.glob('./*/route.tsx', {eager: true}). web/src/app/routes.tsx mounts them lazily at /dev/* via web/src/dev/DevRoutes.tsx when DEV_ROUTES_ENABLED (import.meta.env.DEV || VITE_HB_DEV_ROUTES === '1'). /dev lists all pages. Production builds leave this code out. Pattern for specs: put data-theme-status on the page frame, and in the spec wait for [data-theme-status="ready"].

PLAYWRIGHT: from web/, run `E2E_PORT=<your port> npx playwright test <your spec files>`; results go to test-results/<port>. P3.1 used 5300. Don't edit playwright.config.ts. When the API isn't running, stub `**/api/themes/*/bundle` with page.route (404) to get the static theme fallback without Vite proxy errors; see e2e/dev-schema.spec.ts.

### Notes for later phases
- package.json deps: add @tiptap/extension-{paragraph,heading,blockquote,code-block,horizontal-rule,hard-break,bold,italic,strike,code}@3.31.3 explicitly. The schema imports them, but they currently resolve only through @tiptap/starter-kit's hoisted dependencies (I could not npm install).
- P5.6/S3 tables: header rows sit in <tbody> (one contentDOM), so theme `thead` rules and `tbody tr:nth-child(odd)` striping differ from upstream. It needs an export post-process (move leading header rows into <thead>) and some editor-side answer. canvas.css already makes `td/th > p:only-child` display: contents so rows match upstream's 16px.
- Canvas lane (P3.3): serve Open Sans (legacy/shared/naturalcrit/styles/fonts/open-sans-latin-{400,700}-normal.woff2) and add @font-face for it; Blank-theme pages inherit it upstream. Also port brewRenderer.less (spreads, zoom, print).
- S3: tight lists render li > p, so `p + *` margins apply before nested lists where upstream had bare text. Also, paragraph-renderer quirks (a trailing inline span pulled out of the <p>) become separate paragraphs.
- Importer (P6.2) and snippets (P5.1): call markMultilineDefinitionLists(root) on hbfm HTML before generateJSON or insertContent. TipTap's elementFromString strips "\n" text nodes, which are the only sign of the multi-line dl form. Page shells use data-kind / data-markers / data-objects / data-footer / data-page-number on div.page > div.columnWrapper.
- Parsed styles are stored cssText-normalized ('color: red;'), because ProseMirror renders style through cssText; storing the same form keeps round trips stable. The inspector (P3.5) should write styles through normalizeStyle().
- Pagination (P4): skip transactions with LAYOUT_NEUTRAL_META ('hbLayoutNeutral'). They are pid and heading-id attribute changes; their step maps are empty, and changedPages() would otherwise dirty page 0.
- PageView (P3.2): PageIndexIds writes id=p{n} on the page element (P8.1: formerly a node decoration); PageView never writes `id`. Emit the same chrome order as pageChromeSpec(); add class hb-oversized and element .hb-oversized-badge for oversized pages.
- Export (P6.4): add id=p{n} per page (pageDomId), fill TOC entries, and include canvas.css's upstream-base and dl rules, or the exported HTML differs from the editor.
- The rawHtml catch-all takes a <div> that keeps an attribute after sanitizing (clipboard metadata data-pm-slice/data-hb-clipboard does not count and is not stored), plus the tags in RAW_HTML_TAGS (inside text, the embedded ones are rawInline). rawHtml renders a single root element as is only when these rules take it back (a RAW_HTML_TAGS element or such a div); anything else (<p>, a bare <div>, the importer's lifted <span>) renders in div[data-hb-raw], so JSON → HTML → JSON keeps the node (review fix RV-8). External paste (S1/P3.4) should strip foreign classes in transformPastedHTML (Word's WordSection1 / MsoNormal), or a whole pasted Word document becomes one rawHtml. A plain <span> without inline-block, and <font>/<small>/<mark>, are transparent (attributes lost). The import report should count them.
- PM mark model: two adjacent spans with identical attributes merge into one span.inline-block. Rare, but it affects hand-made TOC-like layouts.
- Link is configured openOnClick: false. The share/read-only view may pass buildEditorExtensions({ schema: { link: { openOnClick: true } } }).
- Image width/height render as HTML width/height attributes. Before storing natural sizes, add CSS so an author style setting only one dimension doesn't distort the image.
- canvas.css turns ligatures back on and uses white-space: pre-wrap instead of TipTap's break-spaces, so layout matches print/export. Keep this in the canvas lane; S1 should check that caret placement inside ligatures is fine.
- Overflow columns begin column-gap (34px in 5ePHB) right of the content box. With the page's padding, about 38px of the first overflow column is still painted, because overflow: clip clips at the padding box. Upstream is the same. Pagination settles before paint.
- Review-fix follow-ups for other lanes:
  - Backend (DocInspector): enforce the manifest's new enum / integer / min / max (drop or reset invalid values: page.columns 3, heading.level 7, toc.depth 9, page.kind 'x'). The client already writes only allowed values. rawInline.html has kind html, so it is already sanitized; icon.font accepts the new Font Awesome classes from iconFonts.
  - URL policy: isSafeHref / isSafeSrc (schema/html.ts) and the schema's html.test.ts cases mirror UrlPolicy and DocInspectorTests. A shared fixture (e.g. shared/url-policy-cases.json) read by both test suites would stop them drifting. sanitizeRawHtml still lets DOMPurify keep data: URLs in video/audio/source src, which RawHtmlSanitizer removes (it keeps data:image/* in img src only).
  - Importer (P6.2): count rawInline nodes in importReport next to rawHtml, and report empty <i> elements whose classes match no icon font (they still become empty italics and disappear). Explicit {#id} heading ids no longer need data-custom-id (the positional check handles them), but setting it would make them explicit.


## Backend: brew endpoints and document validation (P2.3, P2.4)

### Interfaces
ROUTES (group /api/brews, tag "Brews"; JSON is camelCase):
- GET /api/brews/edit/{editId}, operationId GetBrewForEdit. Signed-in authors only (owner, author, invited). 200 BrewForEdit, 401 when anonymous, 403 problem for non-authors, 404 problem for an unknown id.
- GET /api/brews/share/{shareId}, operationId GetBrewForShare. Public. 200 BrewForShare, 404, or 423 problem+json {title:'Brew locked', detail:<lock.shareMessage>, code:<lock.code>} for everyone, authors included. It runs views = views + 1 and sets last_viewed_at unless the caller is in brew_authors in any role. editId is present only for authors. authors lists handles of owner and authors only (invited users are left out).
- POST /api/brews, operationId CreateBrew. Signed-in users. Body CreateBrewRequest; gzip allowed. 201 BrewForEdit with Location /api/brews/edit/{editId}; 400 ValidationProblem; 401; 413. The caller becomes Owner. meta.authors invites users by handle.
- PUT /api/brews/{editId}, operationId SaveBrew. Authors only. Body SaveBrewRequest; gzip allowed. 200 SaveBrewResponse; 409 SaveConflict {serverVersion}; 400 ValidationProblem; 403 problem (not an author, or a non-owner changing meta.authors); 404; 413. An invited caller becomes author on this save.
- DELETE /api/brews/{editId}, operationId DeleteBrew. Authors only. 200 DeleteBrewResponse {brewDeleted}. Removes the caller. When the owner leaves, the first remaining author by position becomes owner. When no owner or author remains (invited users don't count), the brew is deleted.
- POST /api/brews/{shareId}/clone, operationId CloneBrew. Signed-in users. 201 BrewForEdit; 404; 423 when locked. The copy gets new ids, the title 'Copy of X' (at most 100 characters), published=false, views 0, and the caller as Owner.
- Validation error keys: document paths such as 'doc', 'doc.content[0].content[2].attrs.attributes.onclick' and 'doc.content[0].content[0].content[0].marks[0].attrs.href', plus 'docSchemaVersion', 'style', 'snippets', 'sourceMarkdown', 'meta.title', 'meta.description', 'meta.tags', 'meta.lang', 'meta.theme', 'meta.thumbnailUrl', 'meta.authors'.

DTOs (namespace Homebrewery.Api.Brews, file src/Homebrewery.Api/Brews/BrewContracts.cs):
- BrewMeta(Title, Description, Tags, Lang, Theme, Published, ThumbnailUrl?)
- BrewMetaInput(Title?, Description?, Tags?, Lang?, Theme?, Published?, ThumbnailUrl?, Authors?). Null keeps the value on save and uses the default on create; send "" to clear the thumbnail. Authors is the full list of handles in display order.
- BrewAuthorInfo(Handle, Role), where Role is the JSON string 'owner', 'author' or 'invited'.
- BrewLockInfo(Code, Message = editMessage, Applied, ReviewRequested?)
- BrewForEdit(EditId, ShareId, Version, DocSchemaVersion, Doc: RawJson, Style, Snippets: RawJson?, SourceMarkdown?, Meta, Authors, Role, PageCount, Views, Lock?, CreatedAt, UpdatedAt)
- BrewForShare(ShareId, EditId?, DocSchemaVersion, Doc, Style, Meta, Authors: string[], PageCount, Views, CreatedAt, UpdatedAt)
- CreateBrewRequest(Doc?, Style?, Snippets?, Meta?, SourceMarkdown?, DocSchemaVersion?). A missing doc gives one empty page.
- SaveBrewRequest(BaseVersion [required], Doc, Style?, Snippets?, Meta?, DocSchemaVersion?). Doc is required (errors.doc); a null Style is stored as "", and null Snippets clears them.
- SaveBrewResponse(Version, UpdatedAt, Title, PageCount, Authors)
- SaveConflict(ServerVersion)
- DeleteBrewResponse(BrewDeleted)
- RawJson is a record struct wrapping JSON text. It is written raw (stored jsonb) and is an unconstrained schema in OpenAPI; .Parse() returns a JsonElement.
- A blank title is stored as the document's first heading.
- Limits (BrewRules constants): title 100, description 500, tags 50 of 100 characters, thumbnail 256 characters as an absolute http(s) URL, authors 50, style 2 MB, snippets 2 MB and a JSON array, sourceMarkdown 10 MB, lang must match upstream's regex, request body 20 MB (MaxRequestBytes). EmptyDoc, DefaultLang 'en', DefaultTheme '5ePHB'.
- meta.tags / meta.authors lists longer than 4× their limit (200) are refused without being read; one error per problem ('tags must be at most 100 characters' once, only the first invalid handle). A null entry in meta.authors is errors['meta.authors'] (was a 500).
- meta.theme, when a create or save sets it to a value other than the stored one (the default on create), must be a ThemeCatalog key (case-sensitive) or the share id of a brew tagged meta:theme/meta:Theme (any owner, published or not); otherwise errors['meta.theme']. An unchanged stored value always passes, so a theme deleted or untagged later never blocks saves. BrewService now takes ThemeCatalog.
- Clone titles are cut with StoredText.Truncate (never inside a surrogate pair). When the owner leaves, the new owner gets position 0 and the others are renumbered in their old order.
- Numbers in documents and snippets are stored in canonical form (StoredText.ToNumber): written as doubles ('2.0' → 2, '1.50' → 1.5); magnitudes below 1e-15 become 0; non-finite values and magnitudes above Number.MAX_SAFE_INTEGER are dropped (a document attribute, with warning '…: not a storable number') or become null (inside arrays and snippets). PostgreSQL's jsonb prints numbers without exponents, so '1e131071' used to come back as 131,072 characters and '1e131072' failed the save with a 500.

GLOBAL API SETTINGS (Program.cs), which apply to every endpoint:
- ConfigureHttpJsonOptions: MaxDepth = DocInspector.MaxJsonDepth (160); JsonStringEnumConverter(camelCase); NumberHandling = Strict.
- Kestrel MaxRequestBodySize = 20 MB. P2.7 should not set it again.
- app.UseRequestDecompression() comes first in the pipeline, with gzip, br and deflate providers. Endpoint metadata `new RequestSizeLimit(bytes)` (Homebrewery.Api.Infrastructure.RequestSizeLimit : IRequestSizeLimitMetadata) caps the decompressed body; over the cap is 413.
- MapOpenApi runs in Development and in Testing.
- The Api csproj has GenerateDocumentationFile on with NoWarn CS1591 and CS1573. XML comments on public DTOs and records become OpenAPI descriptions. Invalid crefs will fail the build.

SERVICES (DI):
- SchemaManifest, RawHtmlSanitizer and DocInspector are singletons, registered by builder.Services.AddDocumentValidation() in Homebrewery.Api.Infrastructure.DocumentValidation.
- DocumentValidation.ManifestPathKey = 'Schema:ManifestPath'. A relative path resolves against the content root. The default is AppContext.BaseDirectory/schema-manifest.json, which the Api csproj Content link copies from shared/.
- The manifest is loaded at host start, and a missing manifest stops the host.
- BrewService is scoped. Its methods are GetForEditAsync, GetForShareAsync, CreateAsync, SaveAsync, DeleteAsync and CloneAsync. They return BrewOutcome<T>, with cases Ok, NotFound, Forbidden(Detail), Invalid(Errors), Conflict(ServerVersion) and Locked(Code, Message).
- ClaimsPrincipalExtensions.GetUserId() returns Guid?; GetRequiredUserId() returns Guid (Homebrewery.Api.Infrastructure.Identity).

CORE (Homebrewery.Core):
- AccessPolicy: RoleOf(authors, userId?), CanEdit(role) or CanEdit(brew, userId), CanManageAuthors, CountsAsView, IsActiveAuthor, RoleAfterSave, PromoteInvited(brew, userId).
- Homebrewery.Core.Documents:
  - DocInspector(SchemaManifest, RawHtmlSanitizer). Inspect(JsonElement) or Inspect(string) returns InspectResult(Errors, Warnings, SanitizedJson, PageCount, PlainText, FirstHeading, NodeCount) with .IsValid. Constants: MaxBytes 10 MB, MaxDepth 64 (doc = level 1, text nodes count), MaxNodes 250000, MaxStyle 4096, MaxPlainText 204800 characters, MaxHeading 100, MaxJsonDepth 160, MaxErrors 50. .Manifest. IsSafeAttributeName(name).
  - SchemaManifest: Load(path) or Parse(...); FileName; DocSchemaVersion, TopNode, GenericTypes, SafeAttributePattern, ReservedAttributes, ReservedClasses, PageMarkers, IconFonts, Nodes (NodeSpec with AllowsMark), Marks (MarkSpec). AttrSpec(Name, Type: AttrType, Kind: AttributeKind, Default).
  - UrlPolicy: IsSafeHref allows http, https, mailto, relative and #anchor. IsSafeSrc allows http, https, relative and data:image/*. SchemeOf(url).
  - CssPolicy.Check(style) returns null or a reason. The names must stand alone (scroll-behavior, url(https://x/javascript:1.png) pass); expression(, behavior: (also -ms-/_behavior) and -moz-binding count only outside quoted strings; javascript:/vbscript: count inside them too.
  - RawHtmlSanitizer(TimeSpan? timeLimit = null). Sanitize(html) or Sanitize(html, timeLimit) returns RawHtmlResult(Html, Text, Error). Error (Html empty) when the HTML is over MaxLength (1 MB), MaxTags (10,000 start/end tags), MaxAttributes (256 on one tag), MaxElements (20,000 after parsing) or MaxDepth (512 nesting levels), or the parse outlives the time limit. TimeLimit (default 3 s) is per document: DocInspector shares it across all rawHtml nodes. Tag, attribute and time limits stop AngleSharp while it parses (ShouldEmitAttribute/OnToken); depth is checked iteratively before anything recursive (sanitize, ToHtml, TextContent) runs. Deep HTML used to overflow the stack and end the process; deep nesting, many attributes and misnested formatting tags made parsing quadratic (e.g. 13 KB → 10 s and 260 MB). shape-outside, shape-margin and shape-image-threshold declarations in rawHtml styles are kept (AngleSharp drops them while parsing) when CssPolicy passes and their url()s are http(s) or relative.
  - DocInspector adds: rawHtml over the limits is errors[path] (e.g. doc.content[0].content[2].attrs.html); children must match the parent's content expression (listItem 'paragraph block*' must start with a paragraph; error at the parent's path); a mark equal to or excluded by an earlier mark of the same node is dropped (first kept; link excludes link, bold excludes bold…); link.target must be _blank or _self (else dropped) and the 'opener' token is dropped from link.rel; icon.glyph is a space-separated class list ('fa-dragon fa-2x'; invalid or reserved tokens dropped). link.class is stored as before.
  - SchemaManifest.ContentMatches(type, childTypes) (content expressions compiled to regexes; group names from the manifest's 'group'); NodeSpec.Groups; MarkSpec.ExcludesMark(type). A content expression naming an unknown type or group fails the manifest load.
  - StoredText.Clean(string), CleanOrNull, GetString(JsonElement), ToNode(JsonElement) (numbers via ToNumber), ToNumber(JsonElement), Truncate(value, max) (no split surrogate pairs), MaxNumber, MinNumber. Use these for any client string or number headed for PostgreSQL text or jsonb.

TESTS (tests/Homebrewery.Api.Tests):
- Brews/BrewTestKit.cs:
  - BrewActors is a class fixture (IClassFixture<BrewActors> plus [Collection(ApiCollection.Name)]) that takes ApiFixture. It provides Owner, Author, Invited, Other (TestUser) and Anonymous (HttpClient), ClientFor(Actor), and CreateSharedBrewAsync(ct), which makes owner, author and invited.
  - enum Actor.
  - Internal BrewApi helpers: SimpleDoc(heading, text), CreateAsync, GetForEditAsync, SaveAsync, SaveBody(baseVersion, doc?, meta?, style?), Gzip(json), EnsureStatusAsync.
  - TestJson.Options, which matches the API's enum strings.
- Documents/TestDocs.cs: Manifest, Inspector, Inspect(JsonNode), and builders Doc/Page/P/H/Text/Mark/Node/Attrs, plus PlanExample (the §3.3 document).
- SchemaManifestTests.RepositoryRoot() first reads the assembly metadata 'RepositoryRoot' (written by the test csproj at build time, so builds with --artifacts-path work), then walks up to Directory.Packages.props, since the solution is now .slnx.

### Notes for later phases
- Web client: after a successful create or clone, replace the local document with the returned doc, which is sanitized and can differ (for example rawHtml re-serialized by HtmlSanitizer, dropped attributes). Send the returned version as the next baseVersion. On 409, reload. When the conflict comes from an author list racing someone leaving, serverVersion can equal baseVersion.
- Web client: meta fields are optional. Send meta.authors only when the owner edits the list. Non-owners who send a changed list get 403. Role and enum values are camelCase strings. Numbers must be JSON numbers (strict).
- P2.7: the Kestrel 20 MB limit and request decompression are already in Program.cs. Add AddProblemDetails so malformed JSON bodies (for example a missing baseVersion) get problem+json instead of an empty 400. Brew endpoints already return problem+json for 403, 404 and 423.
- meta.theme is validated against ThemeCatalog and user themes on create and save (see Interfaces). Stored values can still dangle (a theme brew deleted, untagged or locked later), so the client must still handle bundle 404/422/423.
- P2.6 vault and user lists: brews.search_text now holds DocInspector.PlainText (one line per text block, at most 200 KB). Keep using projections so search_vector and search_text are never loaded. brews.page_count is set on every save.
- P2.8 import: POST /api/brews with doc plus sourceMarkdown (at most 10 MB). The importer's rawHtml goes through HtmlSanitizer again on the server. Documents must match the manifest's children and marks rules, or the create fails with document-path errors.
- Schema changes: when the web schema changes, regenerate shared/schema-manifest.json (npm --prefix web run schema); the API copies it at build time. If the client adds a new attribute kind, the API refuses to start until DocInspector handles it (deliberate). SchemaManifestTests pins the SAFE_ATTR pattern.
- DocInspector drops attribute values of the wrong JSON type rather than rejecting them, so a bad attribute doesn't fail an autosave. The client then falls back to the attribute default. Warnings are available in InspectResult.Warnings, if someone wants to log or return them.
- User CSS (brew.style) is not checked for BadCss, only capped at 2 MB. The client must keep scoping it (CSSOM), as the plan intends.
- P8: the aspnet runtime image logs 'libgssapi_krb5.so.2: cannot open shared object file' when Npgsql probes for Kerberos. It is harmless. Silence it with GssEncryptionMode=Disable in the production connection string, or install libgssapi-krb5-2.
- Admin lock tooling (later): setting Brew.Lock through a tracked entity plus SaveChanges works, as the tests do. ExecuteUpdate on the owned JSON lock was not tried. Locks block share and clone for everyone, while the editor shows lock.message (the edit message) and saving still works.
- Tests: brew integration tests use the BrewActors class fixture, which creates 4 users per test class (about 1 s). Make every brew fresh per test (CreateSharedBrewAsync). The race tests hold a row lock with Npgsql and poll pg_stat_activity on a separate connection, because pg_stat_activity is snapshotted per transaction.


## Backend: themes, vault, user lists (P2.5, P2.6)

### Interfaces
ROUTES (all public; a signed-in cookie adds the caller's own data; JSON is camelCase):
- GET /api/themes, operationId ListThemes, tag Themes. 200 ThemeList {static: ThemeCatalogEntry[], user: UserThemeInfo[]}.
  - static entries are exactly the themes.json entries: {key, name, renderer:'V3', baseTheme|null, baseSnippets|null, path, style, scopedStyle, preview|null, texture|null, hasSnippets}.
  - UserThemeInfo = {shareId, name (title, or shareId when blank), author (owner handle)|null, baseTheme (the theme brew's own theme), thumbnailUrl|null, published, mine, updatedAt}.
  - user lists published, unlocked brews tagged 'meta:theme' or 'meta:Theme', plus the caller's own themes as owner or author (published or not, locked or not). Order: mine first, then by title. Max 500.
- GET /api/themes/{theme}/bundle, operationId GetThemeBundle. {theme} is a static key (case-sensitive, looked up first) or a user theme's share id.
  - 200 ThemeBundle {theme, name, author|null, styles, snippets}, all root first.
  - styles: ThemeStyle[] = {kind:'url', href:'/themes/V3/<key>/style.scoped.css'} | {kind:'css', css:<raw user-theme CSS>, shareId}.
  - snippets: ThemeSnippetRef[] = 'V3_<key>' | {name:<theme title>, snippets:<stored JSON array>}.
  - User themes without CSS or snippets add nothing. The theme's name comes from catalog.name (e.g. '5e DMG') or the user theme's title. author is the requested user theme's owner handle.
  - Static themes walk baseTheme; baseSnippets is ignored, as upstream does. Unpublished user themes can be bundled, like share links.
  - Errors: 404 problem 'Theme not found' when the requested id is not a static key or brew. 422 problem 'Invalid theme chain' with detail and extension chain: string[] (ids walked, ending with the one that broke it) for a cycle, a chain over 8 themes, a missing parent, or a brew not tagged meta:theme. 423 problem 'Theme locked' {detail: shareMessage, code} when any theme brew in the chain is locked.
  - This matches web/src/editor/canvas/themeLoader.ts parseBundle and MAX_THEME_CHAIN=8.
- GET /api/vault, operationId SearchVault, tag Vault.
  - Query: q, page, pageSize, sort ('relevance'|'updated'|'created'|'views'|'title'), dir ('asc'|'desc'), author (handle).
  - 200 VaultPage {items: BrewSummary[], total, page, pageSize, sort, dir}; sort and dir are the values actually applied.
  - 400 ValidationProblem with errors.sort, errors.dir or errors.q (q over 256 characters). A non-integer page or pageSize is a plain 400 from framework binding.
  - Only published, unlocked brews; editId and role are always null.
  - Defaults: relevance with q, updated without; asc for title, desc otherwise. pageSize is clamped to 1–60 (default 20), page to 1–10000.
- GET /api/users/{handle}/brews, operationId ListUserBrews, tag Users. The handle is normalized (trim, lower-case).
  - 200 UserBrewList {handle, own, items: BrewSummary[] (≤1000, updatedAt desc; in the own list, brews the user is only invited to come after the others, so invitations cannot push their own brews past the cap), total}; 404 problem 'User not found'.
  - own=false: published, unlocked brews where the user is owner or author.
  - own=true (the caller is that user): every brew they are an author of, in any role including invited, with editId, role and locked.
- BrewSummary = {shareId, editId|null, title, description, tags, authors (owner+author handles in order), theme, lang, pageCount, views, published, thumbnailUrl|null, createdAt, updatedAt, lastViewedAt|null, role ('owner'|'author'|'invited')|null, locked}.

C# (namespace Homebrewery.Api.Themes):
- ThemeCatalog (singleton): Themes, Source, TryGet(key, out entry), Contains, ChainOf(key) (root first), Load(path), Parse(json, source), FromThemeSources(themesDir); MaxChain = 8, Renderer = 'V3'.
- ThemeCatalogEntry record; SnippetGroup ('V3_<key>') is [JsonIgnore].
- ThemeCatalogSetup.AddThemes(IServiceCollection) registers ThemeCatalog, the scoped ThemeService, a startup check, and an OpenAPI document transformer. Config keys: CatalogPathKey = 'Themes:CatalogPath', SourcePathKey = 'Themes:SourcePath'. ResolveCatalogPath(config, env).
- ThemeService: ListAsync(Guid? userId, ct) → ThemeList; GetBundleAsync(theme, ct) → ThemeOutcome (Ok, NotFound, BrokenChain(Detail, Chain), Locked(Code, Message)).
- Contracts: ThemeList, UserThemeInfo, ThemeBundle, ThemeStyle (ThemeStyleUrl, ThemeStyleCss), ThemeSnippetRef (ForGroup, ForUserTheme).
- Endpoints.ThemeEndpoints.MapThemeEndpoints(api).

C# (namespace Homebrewery.Api.Brews):
- BrewListService (scoped): VaultAsync(VaultQuery, ct) → BrewOutcome<VaultPage> (Ok | Invalid); UserBrewsAsync(handle, Guid? callerId, ct) → BrewOutcome<UserBrewList> (Ok | NotFound).
- Constants: SearchConfig = 'simple', DefaultPageSize 20, MaxPageSize 60, MaxPage 10000, MaxQueryLength 256, MaxUserBrews 1000, Sorts, Directions.
- Contracts: VaultQuery (the [AsParameters] record), VaultPage, UserBrewList, BrewSummary.
- Endpoints.BrewListEndpoints.MapBrewListEndpoints(api).

Core: Homebrewery.Core.BrewTags: Theme = 'meta:theme', ThemeVariants = ['meta:theme', 'meta:Theme'], IsTheme(tags).

Program.cs: added AddScoped<BrewListService>() and AddThemes() after AddScoped<BrewService>(), and api.MapBrewListEndpoints() and api.MapThemeEndpoints() after MapBrewEndpoints() (before the /api 404 fallback).

TESTS:
- tests/Homebrewery.Api.Tests/Fixtures/themes.json is copied to the output folder. HomebreweryApiFactory.ThemeCatalogFixture holds its path, and the factory sets Themes:CatalogPath to it, which hosts from WithWebHostBuilder inherit.
- Brews/TestBrews.cs:
  - Token() gives a unique search word.
  - CreateAsync(client, ct, title, description, body, published, tags, theme, style, snippets, authors).
  - factory.UpdateAsync(shareId, s => s.SetProperty(...), ct).
  - factory.LockAsync(shareId, ct).

### Notes for later phases
- Web (P3.3/P3.7): themeLoader.ts already parses this bundle format. The static catalog entries in /api/themes match /themes/themes.json exactly, so the metadata dialog can use one list for both. Group user themes by `mine`. The theme stored in meta.theme is the user theme's shareId.
- Web (P7.3): BrewSummary has what the ported brewItem needs (thumbnail, tags, authors, views, pageCount, createdAt, updatedAt, lastViewedAt), plus editId, role and locked for the user's own list. The user page gets everything in one call (≤1000), so upstream's client-side sort and filter can be ported as is. Vault query values are sort=title|created|updated|views|relevance with dir; upstream's 'createdAt' and 'updatedAt' are rejected with a 400.
- Regenerate the web OpenAPI client after this change: new operationIds are ListThemes, GetThemeBundle, SearchVault and ListUserBrews. The derived style schema names are ThemeStyleThemeStyleUrl and ThemeStyleThemeStyleCss; use components['schemas']['ThemeStyle'] rather than the variant names.
- P2.7 (ProblemDetails): a non-numeric page or pageSize on /api/vault currently returns an empty 400 from minimal-API binding. It becomes problem+json once AddProblemDetails is registered.
- P2.7 (ShareShell) and any future work that reads user themes should use BrewTags.IsTheme and BrewTags.ThemeVariants, not the tag strings directly.
- If a theme's settings.json changes, ThemeCatalogTests.The_fixture_matches_what_the_theme_sources_produce fails. Refresh the fixture by copying src/Homebrewery.Api/wwwroot/themes/themes.json (from a web build) to tests/Homebrewery.Api.Tests/Fixtures/themes.json.
- Admin (P7.4) may want locked-brew visibility in lists: the vault and public user lists already exclude locked brews, and only the author's own list shows them with locked=true.
- No new packages were needed (Microsoft.OpenApi 2.12 types come through Microsoft.AspNetCore.OpenApi).


## Canvas: PageView, EditorCanvas, cssScope, paste, column navigation (S1, P3.2, P3.3)

### Interfaces
NODEVIEWS (web/src/editor/nodeviews/index.ts)
- editorNodeViews: AnyExtension[] = [PageWithView, TableWithView]. Pass them to buildEditorExtensions({ extensions }); EditorCanvas already does.
- PageWithView = Page.extend({ addNodeView }). TableWithView = HbTable.extend({ addNodeView }), which replaces TipTap's TableView: no div.tableWrapper, no min-width, colgroup kept in sync.
- class PageView(node, view?):
  - Properties: dom, contentDOM (div.columnWrapper), pageNode.
  - update() patches attrs and chrome in place.
  - stopEvent(e) is true only for targets inside the chrome.
  - ignoreMutation lets through only flow mutations.
- class HbTableView(node, view?).
- Constants and helpers: CHROME_ATTR='data-hb-chrome' (on every chrome element), OBJECT_ID_ATTR='data-object-id' (on page-object elements, = PageObject.id; for P5.3), OVERSIZED_CLASS='hb-oversized', OVERSIZED_BADGE_CLASS='hb-oversized-badge', OVERSIZED_BADGE_TEXT/TITLE, sameAttrs(a,b).
- Chrome elements are contenteditable=false. Object images have draggable=false. The badge comes after .columnWrapper. PageView never writes the page `id`; PageIndexIds owns p{n}.
- Pagination sets the oversized state with tr.setNodeAttribute(pagePos, 'oversized', true|false).

EDITOR CANVAS (web/src/editor/canvas/EditorCanvas.tsx)
- `<EditorCanvas content theme userCss? userCssDelayMs?=150 lang?='en' zoom?=1 spread?='single'|'facing'|'flow' startOnRight?=true pageShadows?=true editable?=true extensions? themeSource? gate? onReady?(editor, handle) onStatusChange?(CanvasStatus) onRepaginate?({from, reason}) className? ref? />`
- Always included: editorNodeViews, CanvasState, ExternalPaste, ColumnNavigation. Your `extensions` come after these and replace any extension with the same name.
- Memoize `extensions`: a new array re-creates the editor from `content`.
- The editor uses shouldRerenderOnTransaction: false and immediatelyRender: true.
- Root element: div[data-canvas-status=loading|ready|error][data-canvas-theme]. It is a scroll container that fills its parent (height: 100%).
- DOM: viewport › sizer › div.hb-canvas[lang][data-spread][data-recto][data-zoom] › div.pages.ProseMirror › div.page.
- The viewport has contain: layout paint (review fix RV-2; none in print): it is the containing block for position: fixed inside the canvas, as upstream's iframe was, so brew CSS can't cover the app. Popovers or toolbars rendered inside the viewport with position: fixed are confined to it too: portal them outside.
- EditorCanvasHandle: editor, canvas, viewport, isReady(), repaginate(from=0), print(). print() waits for lazy images, then calls window.print.

CANVAS STATE (web/src/editor/canvas/canvasState.ts)
- CanvasState extension, name 'hbCanvas'. editor.storage.hbCanvas = { ready, theme, zoom, repaginations }.
- isCanvasReady(editor) (true for an editor without a canvas), canvasZoom(editor), setCanvasReady, setCanvasZoom, requestRepagination(editor, from=0) (addToHistory: false).
- REPAGINATE_META is re-exported from '../pagination/state' (value 'hbRepaginate'). The canvas lane now depends on that export: keep it.
- RepaginateReason = 'theme'|'css'|'fonts'|'manual'.
- Paginator wiring:
  - `const gate = createCanvasGate()` (useMemo in a component).
  - `extensions = [Pagination.configure({ isReady: gate.isReady })]`.
  - `<EditorCanvas gate={gate} extensions={extensions} …/>`
  - gate.isReady() is false until the canvas attaches its editor and the theme, CSS and fonts are ready.
- EditorCanvas dispatches REPAGINATE(0) itself after every theme or CSS apply and after `document.fonts` `loadingdone`. P4.5 does not need its own fonts trigger; a second one would be harmless.

THEME HOOK (useCanvasTheme.ts)
- useCanvasTheme(opts) → CanvasStatus.
- CanvasStatus:
  - {state:'loading', theme}
  - {state:'ready', theme, chain, failed, failedImports, fontsLoaded}
  - {state:'error', theme, message}
- Also exported: RepaginateEvent {from, reason} and useDebouncedValue.
- Review fixes (RV-3, RV-4, RV-10): only a chain for the current theme is applied (a CSS edit after a failed theme switch keeps the error). CSS with @imports is applied at once without them (theme links too) and again once they are inlined, failed or timed out; only then is the canvas ready. A run is aborted when superseded or on unmount and never records its result after that. Unmount calls disposeThemeSlot(slot).

ZOOM (useCanvasZoom.ts)
- useCanvasZoom(zoom, spread, onApplied?) → { viewportRef, sizerRef, canvasRef }.
- Other exports: CanvasSpread, clampZoom (0.1–5), spreadMinWidth.
- Layout is never scaled. Objects code (P5.3) should divide pointer deltas by canvasZoom(editor).
- A zoom change keeps the viewport's centre point in place relative to the first page (review fix RV-16: the canvas width, and so the page centring, changes with the zoom).

CSS SCOPE (cssScope.ts)
- Exports:
  - scopeCss(css, baseURL, scope|{scope, report}) → CSSStyleSheet. This is themeLoader's ScopeCss hook.
  - scopeCssText(css, baseURL?, scope?) → string.
  - scopeSelector, scopeSelectorList, splitSelectorList, constrainSelector / constrainSelectorList (add the subject constraint :where(scope, scope *) before any pseudo-element).
  - extractCssImports(css) → CssImport[] {url, conditions, statement}, stripCssImports(css), absolutizeCssUrls(css, base).
  - inlineCssImports(css, {baseUrl, fetch?, maxDepth?=3, cache?, signal?, timeoutMs?=IMPORT_TIMEOUT_MS (10 s)}) → {css, failed}. An import that doesn't answer in time is cancelled and failed (retried on the next call). signal only stops waiting: the call resolves at once, and the fetch keeps going (up to the timeout) into the cache for the next call.
  - CANVAS_SCOPE, ScopeReport.
- The import lane's canvas/probe.ts imports extractCssImports and scopeCssText: keep these stable.
- Scoping rules since review fix RV-1: every nested style rule (CSS nesting, also in @media/@supports/… inside a style rule) gets the subject constraint, because `:not(&)` / `:has(&)` get no implicit `& ` prefix and matched the app document. A top-level selector that reaches a sibling of the canvas (`:root ~ x`, `body + x`, also as an @scope start) gets it too; nested @scope starts as well. A rule whose rewritten selector the browser rejects is dropped (ScopeReport.droppedRules), never left unscoped. scopedRules now counts nested rules.

PASTE (pasteCleanup.ts)
- ExternalPaste extension (name 'hbExternalPaste') sets transformPastedHTML to transformPastedHtml(html).
- Also exported: cleanExternalHtml(html, parser?), isEditorClipboardHtml(html, parser?), CLIPBOARD_ATTR, externalPasteKey.
- This editor's clipboard is marked (review fix RV-5): ExternalPaste's clipboardSerializer puts data-hb-clipboard="1" on the top-level elements it serializes. isEditorClipboardHtml parses the HTML and is true only when the element with data-pm-slice (or, for table parts, the element inside its -N wrappers) has the marker; data-pm-slice alone comes from every ProseMirror-based app. The schema reserves the attribute.
- External HTML loses every class, style, id, dir, role, aria-* and data-* attribute. svg, math, video, audio, canvas and map are removed (they would keep no attribute and become empty boxes).

COLUMN NAVIGATION (columnNavigation.ts)
- ColumnNavigation extension (name 'hbColumnNavigation', priority 1000), columnNavigationKey, verticalTarget(view, dir, goalX) → {pos, goalX} | {node: Selection} | null.
- P4.7 (seam editing) handles ArrowLeft/Right and Backspace/Delete; this extension only handles ArrowUp/ArrowDown.

PRINT (print.ts)
- loadLazyImages(root, timeoutMs?), printCanvas(canvas, win?).

DEV PAGE /dev/canvas
- Query params:
  - theme=<key>
  - zoom=0.5|0.75|1|1.5|2
  - spread=single|facing|flow
  - doc=s1|chrome|blank
  - css=<text>
  - view=legacy (S1 page 1 rendered with marked-hbfm in an upstream-like iframe; data-testid=legacy-frame)
- The frame carries data-theme-status. Test ids: theme-select, zoom-select, spread-select, doc-select, css-input, leak-probe, repaginate-count, canvas-status.
- Window globals: window.__editor, and window.__hbCanvas = { editor, handle, repaginations, statuses, scopeCssText, transformPastedHtml }.
- web/src/dev/canvas/devDocs.ts exports s1Doc, chromeDoc, blankDoc, devDocs, filler(), S1_TEST_IDS, s1Page1Markdown().

E2E
- web/e2e/canvas/helpers.ts: openCanvas, paragraphRange, caret, setCaret (waits for the DOM selection), press/settle, coordsAt, columnBoundary, lineOf, wordBox, centerInViewport.
- Port 5301.

FILES I DID NOT TOUCH
- canvas.css, themeLoader.ts, the schema, editorExtensions.ts. (The review-fix pass later changed themeLoader.ts and the schema; see the P3.1 section.)

### Notes for later phases
- P5.6 / P0.4 (tables): the header-row difference is the only visible S1 diff. Proposed fix: a decoration adds class hb-header-row to leading all-th rows, and scopeThemes.ts (build) plus cssScope.ts (runtime) rewrite theme selectors. `thead X` would become `:is(thead, tr.hb-header-row) X`, and `tbody tr:nth-child(odd)` would become `tbody tr:nth-child(odd of :not(.hb-header-row))` (supported in Chrome 111+ and Firefox 113+). Export should still move header rows into <thead>.
- Firefox IME (S1 c) needs a manual check on /dev/canvas: Japanese and Korean input, including at the column boundary.
- Firefox has two caret stops at every soft line wrap in pre-wrap text: end of the line, then start of the next line, at the same offset. This is general ProseMirror plus Firefox behaviour, not specific to columns. P4.7 seam editing should keep it in mind; its ArrowRight 'one press = one character' rule will see this at wraps.
- ProseMirror re-syncs the DOM selection 20 ms after the editor gets focus. A synthetic drag that starts within that window can lose its anchor. Chromium also collapses synthetic drags that start within about 1 px of a glyph midpoint, even on a bare contenteditable. Keep this in mind when writing drag e2e tests (focus first, start at a word edge).
- Pagination (P4): use createCanvasGate() and Pagination.configure({ isReady: gate.isReady }). canvasState imports REPAGINATE from pagination/state.ts, so don't move or rename it. EditorCanvas already dispatches REPAGINATE(0) on theme and CSS changes and on fonts loadingdone. Inserting or removing a page changes the p{n} ids of every later page; they are written on the elements (P8.1), and ProseMirror re-uses the later PageViews (PageView.test.ts tests both).
- Static export (P6.4) and the import probe need Open Sans too. It is now served from web/src/editor/canvas/fonts via EditorCanvas.module.css @font-face; Blank-theme text inherits it, as upstream.
- Share and export HTML is pasted as external HTML (no data-pm-slice), so theme classes are stripped. If pasting from a share page should keep classes, add a marker (e.g. data-hb-export) to exported HTML and treat it like editor clipboard HTML in isEditorClipboardHtml.
- themeLoader limitation: every slot's theme sheets apply to every .hb-canvas in the document. Two EditorCanvas instances with different themes on one page will mix styles (e.g. a preview and the editor).
- cssScope drops `@scope { … }` blocks that have no start selector and reports them in ScopeReport.droppedRules. Nested CSS rules stay relative to their parent, with the subject constraint (see CSS SCOPE). A leading `&` at the top level is not handled specially (it means :root there, so the prefixed selector matches nothing). The inner rules of a top-level @scope are not constrained: its scoped root confines them.
- Pagination lane: pagination/measure.ts and dev/pagination/harness.ts find the flow with `:scope > .columnWrapper`. Chrome can no longer carry that class (RV-9), but `:scope > div.columnWrapper` (as page.ts, PageView and columnNavigation now use) is the robust form.
- The screenshot baselines are win32-only (e2e/canvas/baseline). CI on Linux skips that test until someone runs `HB_UPDATE_BASELINE=1 E2E_PORT=… npx playwright test e2e/canvas/screenshot.spec.ts -g baseline` there. The legacy-vs-canvas comparison runs everywhere, with a 0.6% threshold.
- The import lane created web/src/editor/canvas/probe.ts inside my path. It depends on my cssScope exports. I did not edit it.
- I deleted web/src/editor/nodeviews/.gitkeep because the directory now has files.
- Other lanes' failures seen at the end: src/editor/pagination/step.test.ts fuzz test times out at 5000 ms, and e2e/pagination/measure.spec.ts:161 has a no-useless-assignment lint error.


## Pagination core (S2, P4.1-P4.4)

### Interfaces
PAGINATION (web/src/editor/pagination/index.ts; relative imports inside the folder).

Using it in an editor:
- `buildEditorExtensions({ extensions: [Pagination.configure({ isReady: () => themeAndFontsReady })] })`, with `shouldRerenderOnTransaction: false`.
- `Pagination` is a TipTap Extension named 'hbPagination' that wraps `paginationPlugin(opts)`. It also replaces TipTap's `updateAttributes` command for nodes (fragments.ts `updateAttributes`): one AttrStep (`tr.setNodeAttribute`) per changed, declared attribute instead of setNodeMarkup; marks still use TipTap's command. Reason: setNodeMarkup's undo step replaces the whole node, and once pagination re-joins or re-splits that node, history can't map it and the undo is silently dropped (review finding PG-2). Convention for every lane (inspector, align, classes): change node attributes with `updateAttributes` or `tr.setNodeAttribute`, never `setNodeMarkup`.
- Split blocks share their formatting: the plugin's appendTransaction (`shareFragmentAttrs`) writes an attribute a transaction changed on one fragment (align, classes, style, attributes, and so on) to every fragment of the block. At the page seams the transaction touched, a continuation whose attributes still differ from its head's takes the head's (joining a paragraph into a split head gives the whole block that paragraph's attributes). Per-fragment attributes that are not shared: continuation, id, start, customId. The appended transaction carries the `FRAGMENT_ATTRS = 'hbFragmentAttrs'` meta and joins the author's undo event. `fragmentChain(doc, pos)` returns the positions of every fragment of a block (head first).

`PaginationOptions` (all optional):
- `budgetMs`: default 8.
- `isReady(): boolean`: the fonts/theme gate; pagination waits (checked each frame) while false.
- `maxStepsPerSettle`: number or `(doc) => number`; default `defaultMaxSteps(doc) = 200 + 30 × pages`.
- `layout(view) => PageLayout`: default `domLayout`.
- `requestFrame`, `cancelFrame`, `now`: for tests.
- `onSettle({ steps, ms, stats })`.
- `logger`: default console.

State, metas and helpers:
- `paginationKey`: PluginKey<PaginationState>.
- `PaginationState = { dirtyFrom: number | null, dirtyTo, blocked, rechecked, stats: PaginationStats }`. The stats are settles, steps, settleSteps, lastSettleSteps, maxSettleSteps, guardHits, errors, pushes, inserts, pulls.
- `isSettled(state)`: for autosave. True when settled, when there is no plugin, or while the editor is hidden (blocked). While hidden, retries back off (250 ms, doubling, 5 tries) and then wait for the next change or REPAGINATE.
- `paginationState(state)`.
- `PAGINATE = 'hbPaginate'`: meta on every pagination transaction (with addToHistory false). Payload `PaginateMeta { dirtyFrom, dirtyTo, rechecked?, action }`. Autosave's dirty flag should ignore these.
- `REPAGINATE = 'hbRepaginate'`: meta whose value is a page index (check to the end) or `{ from, to? }`. Fractions are floored and indexes clamped; any other payload (null, NaN, strings, `{ to }` alone) is ignored with a `logger.warn` and never throws. For P4.5 triggers use `repaginate(view, from = 0, to?)`, which also floors and clamps (non-finite arguments: no-op).
- Image trigger (built): a capture-phase `load`/`error` listener on `view.dom` re-checks the page of an image that a measurement saw unloaded (`pendingImages` in measure.ts), batched per microtask as `repaginate(view, from, to)`. Loads of other images are ignored. A boundary move re-renders a paragraph and so creates a new `<img>`, and in Firefox that element has no size until it loads again.
- `settleNow(view): boolean`: synchronous settle for print/export; ignores the budget and the IME/ready gates.
- `changedPages(tr): [first, last]`: one pass over the steps (linear; a replace-all has thousands).
- Transactions with `LAYOUT_NEUTRAL_META` (heading ids, pids) are ignored.
- Dirty range after a user edit: from the page before the first changed page to the last changed page. The pass continues while boundaries move, and stops at the first unchanged page after dirtyTo.
- Nothing runs while `view.composing` is true.

Step and layout:
- `paginatePage(state, progress, layout): StepResult { tr, action: 'push'|'insert'|'pull'|'oversized'|'settled'|'blocked'|'done', page, progress }`.
- `PageLayout<M> { measure(page): M | null; isHidden?(): boolean; chooseCut(page, m): CutChoice; pullTarget(page, m, next): number | null }`. When measure returns null: if `isHidden()` is true or missing, the step is 'blocked' (the pass waits); otherwise that one page is skipped ('settled') and later pages still paginate.
- `domLayout(view)`: isHidden = view.dom is detached or has no client rects.
- Step order: overflow (push/insert), then pull, then a heading at the bottom of the page whose next block is on the next auto page is pushed on (keep-with-next, action 'push'), then settled. When settled, `renumberContinuations(tr, i)` resets the `start` of an ordered list continuing on the next page to head.start + head.childCount (minus 1 when the head's last item continues). If the start changed, the next page is checked too. After a pull onto a page kept only for its objects, the page before it is checked again.

Boundary (pure ProseMirror; works on any Transform):
- `PageRef { node, index, pos, contentStart, contentEnd }`.
- `pageAt(doc, i)`, `pageIndexAt(doc, pos)`, `endOfFirstBlock(p)`, `isAutoPage(node)`, `isPlaceholderPage(node)`, `carriesPageData(node)`, `mapToken(mapping, pos)`.
- `autoPageAttrs(srcAttrs)`: copies SECTION_ATTRS; kind 'auto'; pid, id, markers, objects and attributes reset.
- `continuationAttrs(node, splitIndex)`: continuation true, id null, orderedList start += splitIndex.
- `normalizeCut(doc, pos)`.
- `splitToPage(tr, cut, pageAttrs)`: may add an empty continuation filler paragraph when a list item continues with a nested list; clears a stale continuation flag on a whole block after a cut.
- `insertAutoPageAt(tr, i, cut)`.
- `moveBoundary(tr, i, cut): 'split'|'merged'|'kept'`: join plus continuation re-join (fillers dropped), then split. Pages with objects or markers (`carriesPageData`) are kept with one empty paragraph; content arriving later replaces it.
- `rejoinContinuations(tr, seam)`, `renumberContinuations(tr, i): boolean`.

Measure and cut (DOM, client px, zoom-aware):
- `measurePage(view, page): PageMeasure | null`. PageMeasure = { box, scale, eps, columns, gap, columnWidth, rtl, overflow, first: { index, pos, el, rect, startsInside } | null, rowTop, lastColumn, lastBottom, lastMarginBottom, columnFree[], freeSpace }. Null also while an image in the page's flow (before the first overflow) has not loaded and has no width and height attributes, for at most 3 s per image. The measurement starts loading such an image if it is `loading=lazy`, and its load re-checks the page.
- Blocks are measured with `blockRects(el)`: the block's own fragments plus those of its floated descendants. A float that doesn't fit goes to the overflow column on its own, while its paragraph stays inside the box.
- Right-to-left pages (`direction: rtl` on the wrapper): `Geometry.rtl`. Overflow columns are to the left of the box, and `columnOf(rect, g)` counts from the right. It now takes the rect, not its left edge.
- `pageGeometry`, `contentBox`, `scaleOf`, `EPS = 0.5` (CSS px, scaled with zoom).
- `firstUnitHeight(view, next)`, `pullTarget(view, m, next)`. Pull estimates treat a block holding a float or an image taller than 1.5 lines as unsplittable, and stop at a block whose image has no size yet. A trailing heading is not pulled back when it is the whole next page and another auto page follows it. It is there because keep-with-next was broken, see below.
- `chooseCut(view, page, m): CutChoice { pos: number | null, oversized, rule: 'line'|'item'|'nested'|'group'|'block'|'keepWithNext'|'oversized'|'none' }`. A float outside the box moves on from its anchor, so a paragraph holding only the float moves whole. Keep-with-next is broken when the heading(s) start the page and the unit fits a fresh page: the heading stays and the unit moves on, with no oversized flag. A unit taller than a column still stays with its heading and the page is flagged.
- `firstPosOutside(view, from, to, geometry)`: coordsAtPos binary search. `keepWithNext(page, cut)`.

For PageView (P3.2): pagination sets `page.attrs.oversized`; render class hb-oversized and the badge. Don't re-create the page DOM for attribute-only updates if you can avoid it (pagination changes oversized and pages often). Pagination only needs `view.nodeDOM(page.pos)` to be the div.page with a direct child div.columnWrapper holding the blocks. It reads block DOM through `view.nodeDOM(pos)`, so it works with NodeViews.

Dev harness: `/dev/pagination?theme=5ePHB|Blank&doc=sample|fill|long30|mixed20&zoom=0.5|1|2&paginate=0|1`. `data-theme-status="ready"` is set once the theme and fonts are ready. `window.__hbPagination` is the test API (web/src/dev/pagination/harness.ts `HarnessApi`, mirrored in web/e2e/pagination/harness.ts). It provides settled, load, setPaginate, measure, cut, describe, pages, texts, overflowing, domTruth, flowText, select (focuses synchronously), blockPos, endOfPage, posOf, grow, insertBlock, frameWatch (ResizeObserver check right before paint), fuzz, setZoom, repaginate, settleNow. `overflowing()`, which frameWatch and the fuzz also use, reads the DOM directly (`domTruth(i)`: every rendered descendant of the wrapper, floats included, against its content box, RTL-aware), not measurePage. So the oracle can see measurePage's blind spots. The fuzz report also lists `textChanged`: the flow text (`flowText()`, fragments of a block joined) before a settle vs after it. To swap in EditorCanvas later, keep the extension list and API. Playwright specs: `E2E_PORT=5302 npx playwright test e2e/pagination`. On a loaded machine, run Firefox with `--workers=1`: parallel Firefox workers time out while loading the theme.

### Notes for later phases
- Canvas lane / canvas.css (high priority): Firefox 155 hangs, then the tab crashes, when laying out a list item taller than about one column. Minimal repro: .page {column-count:2; column-fill:auto; height fixed; overflow:clip} > .wrap {height:100%; columns:inherit; column-span:all} > ul > li {break-inside:avoid} with about 3,000 characters in the li. Removing the wrapper's column-span, or making .page single-column with the wrapper as the multi-column box, avoids it. So do li {break-inside:auto} or .columnWrapper {column-fill:balance}, but those change the layout. Upstream CSS has the same hang. Consider a Firefox-only override (for example `@supports (-moz-appearance:none) { .hb-canvas .page li { break-inside: auto } }`), or restructure so .page isn't a multicol that the wrapper spans.
- canvas.css: hide the marker of a continued list item (`li.hb-continued { list-style-type: none }` or `::marker { content: none }`). With a split inside an item, the item keeps its number and needs no second marker. Also hide the empty filler paragraph a continued list item starts with when it continues with a nested list (`li.hb-continued > p.hb-continued:first-child` holding only ProseMirror's trailing break).
- P4.5 triggers: call `repaginate(view, 0)` after document.fonts.ready and on each loadingdone, on theme or user CSS changes (debounced) and on Journal odd/even page changes. The image-load trigger is built (plugin.ts). The isReady gate is checked every frame, so flipping it true is enough to start, but an explicit repaginate after readiness is cleaner (the harness does this).
- Images (canvas / image NodeView lane, plan §6.6): store natural width/height on insert and import. A sized image never makes a page wait. The editor could also render images eagerly. Pagination switches an unloaded, unsized `loading=lazy` image to eager when it measures its page. Until the image loads (at most 3 s), that page is skipped, so isSettled can be true while it waits. The load then re-checks the page, and autosave should save again after that settle.
- P4.7 seam commands: clear `continuation` on a fragment when its head paragraph is deleted; otherwise the next boundary move merges the fragment into the preceding paragraph. Enter at the start of a continuation: TipTap's splitBlock keeps the attributes on the first half, so the empty first half would keep continuation=true. Handle this in the continuation commands. Both fuzzes (step.test.ts, the harness fuzz) model the head-delete rule in their block delete, so that canonical() and flowText of the edited document stay truthful oracles. Without it, the stale fragment's merge is already in the oracle's input.
- Undo of block-type changes (setBlockType: Mod-Alt-0…6, setParagraph, toggleHeading) is still lost once pagination splits or re-joins that block. There is no attribute-step equivalent, and ReplaceAroundStep inverses can't map through a join or split of their node (PG-2, not fixed). Options: implement type changes on split blocks as a replace of the whole fragment chain (that drops the text's earlier undo steps), or accept the limitation.
- Keep-with-next fallback: a heading that starts a page, followed by a unit that fits a fresh page but not below the heading, stays alone on its page. That's typographically poor but it doesn't loop. An author-facing hint (P4.8) could suggest a column break.
- Unit-test oracle: `seamProblems(doc)` (testing.ts) reports fragment attribute mismatches, wrong continued list numbers and stranded headings at page seams, which canonical() can't see. step.test.ts's expectSettledLayout uses it.
- Autosave (P3.8): wait for isSettled(state) and ignore transactions with the 'hbPaginate' meta. Pagination and undo can give auto pages new pids (undo deletes across page boundaries), so don't key anything durable on auto-page pids.
- Harness finding for all editor lanes: TipTap's `editor.commands.focus()` focuses one animation frame later. A key pressed before that goes to the page body, and under load a keystroke was lost. Use `view.focus()` in tests and harnesses before sending keys.
- Performance headroom: in Firefox a step costs about 3–4 ms, versus about 1 ms in Chromium, so a 31-page cascade takes 11–18 frames (about 170–300 ms). If P8.1 needs faster long-section settles, measuring visible pages first and batching measure-only steps (not dispatching meta-only transactions) are the next steps.
- Line-model fake layout (src/editor/pagination/testing.ts: lineLayout, canonical) is available for unit tests of section commands (P4.6), for example checking that pagination never changes canonical(doc) (auto pages joined, continuations re-joined).


## Backend: share shell, guards, rate limits, import proxy, admin, OpenAPI (P2.7, P2.8)

### Interfaces
ROUTES (JSON camelCase; errors are problem+json; OpenAPI operationIds in parentheses):

- GET /api/notifications/active (ListActiveNotifications). Public. Returns 200 NotificationInfo[] = {id, dismissKey, title, body (plain text), startsAt, stopsAt, createdAt}, oldest start first.

- POST /api/brews/{editId}/lock/review (RequestLockReview). Any author role (owner, author or invited). Returns 200 BrewLockInfo {code, message (= editMessage), applied, reviewRequested}. Asking again keeps the first request time. Errors: 401, 403 for non-authors (admins included), 404, 409 'Brew not locked'.

- GET /api/import/homebrewery/{shareId} (ImportFromHomebrewery). Signed-in users only; rate limited per user.
  - 200: text/plain; charset=utf-8 with the upstream brew text, including its ```metadata and ```css blocks.
  - 400: ValidationProblem with errors.shareId (id must match ^[A-Za-z0-9_-]{10,14}$).
  - 401, 404 'Brew not found' (not on upstream), 413 'Brew too large' (over 2 MB), 429.
  - 502 'Download from the Homebrewery failed'. It has the extension upstreamStatus: int when upstream answered an HTTP error; a locked upstream brew answers with its lock code.

- GET /share/{shareId}. Returns index.html with HTML-encoded preview tags:
  - name=description; og:site_name 'The Homebrewery'; og:type article; og:title '{title or Untitled Brew} - {owner handle}'; og:description (default 'No description.'); og:url.
  - og:image and twitter:image only when the brew has a thumbnail. twitter:card is summary_large_image with a thumbnail, summary without; twitter:title and twitter:description are also set.
  - <title> becomes '{title} - The Homebrewery'. Existing og:/twitter:/description meta tags in the template are removed.
  - Unknown and locked brews get the plain index. No views are counted. 404 when there is no index. Not in the OpenAPI document.

ADMIN ROUTES. All under /api/admin, behind the Admin policy: 401 anonymous, 403 for non-admins.
- GET /stats (AdminGetStats): AdminStats {brews, publishedBrews, users, lockedBrews, pendingReviews}.
- GET /users?q= (AdminFindUsers): AdminUserInfo[] {id, handle, email, emailConfirmed, roles[], brewCount, lockoutEnd}. q is a case-insensitive substring of handle or email, or an exact id. Exact matches first, then by handle; at most 50. 400 errors.q when q is empty or over 256 characters.
- GET /brews/{id} (AdminGetBrew). id is the internal GUID, a share id or an edit id (share id wins). Returns AdminBrewInfo {id, shareId, editId, title, description, tags, lang, theme, published, thumbnailUrl, pageCount, views, version, docSchemaVersion, authors: BrewAuthorInfo[] (invited included), lock: AdminLockInfo|null, createdAt, updatedAt, lastViewedAt}. 404 otherwise.
- PUT /brews/{shareId}/lock (AdminLockBrew). Body LockRequest {code: 100-999, editMessage, shareMessage} (both messages required, at most 1000 characters). Returns 200 AdminBrewInfo. Replaces any existing lock and clears reviewRequested. 400 / 404.
- DELETE /brews/{shareId}/lock (AdminUnlockBrew): 200 AdminBrewInfo; idempotent; 404.
- DELETE /brews/{shareId}/lock/review (AdminDismissLockReview): 200 AdminBrewInfo (still locked); 404; 409 when not locked.
- GET /locks (AdminListLocks): LockedBrewInfo[] {shareId, editId, title, authors: string[] (owner and authors), lock: AdminLockInfo {code, editMessage, shareMessage, applied, reviewRequested}}, most recently locked first, at most 1000.
- GET /locks/review-queue (AdminLockReviewQueue): LockedBrewInfo[] with reviewRequested set, oldest request first.
- Notifications CRUD:
  - GET /notifications (AdminListNotifications)
  - GET /notifications/{id:guid} (AdminGetNotification)
  - POST /notifications (AdminCreateNotification): 201 with Location /api/admin/notifications/{id}
  - PUT /notifications/{id:guid} (AdminUpdateNotification)
  - DELETE /notifications/{id:guid} (AdminDeleteNotification): 204 or 404
  - Body NotificationInput {dismissKey (required, at most 100), title (required, at most 200), body (at most 10000), startsAt (default now), stopsAt (required, after startsAt)}. Errors: 400 with errors.{dismissKey|title|body|stopsAt}; 409 'Dismiss key taken'.
- REMOVED: GET /api/admin/ping and the AdminPing record.

GLOBAL BEHAVIOUR:
- Writes need an Origin header. Every POST/PUT/PATCH/DELETE needs Origin (or Referer when Origin is absent) equal to the request's scheme://host:port, otherwise 403 problem 'Cross-origin request blocked'.
  - Browser fetch sends Origin automatically.
  - Playwright APIRequestContext, curl and scripts must set it, e.g. extraHTTPHeaders {Origin: baseURL}.
  - The test factory's clients already send Origin http://localhost.
- Rate limits: fixed window. Configure with RateLimits:{Auth|Import|Writes}:{PermitLimit|Window}.
  - Defaults (appsettings.json): Auth 20/min per IP on the whole /api/auth group; Import 10/min per user; Writes 120/min per IP on every POST/PUT/PATCH/DELETE.
  - Development: 1000 / 100 / 10000.
  - A rejection is 429 problem+json {title 'Too many requests'} with a Retry-After header.
  - Pipeline order: UseAuthentication, then UseRateLimiter, then UseAuthorization.
- Errors are problem+json:
  - UseExceptionHandler gives a 500 problem (Development adds detail and an 'exception' extension). ExceptionHandlerOptions.StatusCodeSelector maps BadHttpRequestException to its own status, so request-binding errors are 400 (413 for too-large bodies) in Development too, where minimal APIs throw them (RouteHandlerOptions.ThrowOnBadRequest).
  - Under /api, empty-body 4xx/5xx become problem+json, so 401 and 403 now have bodies.
- Forwarded headers: ASPNETCORE_FORWARDEDHEADERS_ENABLED=true (already set in the compose files) now applies X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host. Optional ForwardedHeaders:KnownNetworks (CIDR) and ForwardedHeaders:KnownProxies restrict which proxies are trusted.
- Spa:DevServerUrls: a list (array, or one string split on , ; or whitespace). Candidates are tried in order, starting with the last one that answered, requested with Host: localhost. Development default: ["http://localhost:5173", "http://web:5173"]. If none answers, wwwroot/index.html is used.

C# (src/Homebrewery.Api):
- Homebrewery.Api.Infrastructure:
  - SameOriginWriteGuard (middleware; static IsSameOrigin(HttpRequest)).
  - RateLimits: constants Auth='auth', Import='import', SectionName='RateLimits'; AddRateLimits(IServiceCollection); Configure(RateLimiterOptions, RateLimitSettings); IsWrite(method). RateLimitSettings and WindowLimit hold the settings.
  - ForwardedHeadersSetup.AddProxyForwardedHeaders().
  - ConfigurationLists.Read(config, key).
  - SpaIndex (singleton): GetAsync(ct); DevServerUrlsKey='Spa:DevServerUrls'; DevServerClient='SpaDevServer'.
  - ShareShell: RenderAsync, SiteName, internal Inject/Preview.
  - ServiceOutcome<T> with cases Ok, NotFound(Title), Invalid(Errors), Forbidden(Detail), Conflict(Title, Detail); ServiceOutcomes.ToProblem().
  - ApiDocument: Path='/openapi/v1.json'; AddApiDocument() replaces AddOpenApi(). It sets info.title 'Homebrewery API', clears servers, and collapses nullable refs to any-JSON schemas.
- Homebrewery.Api.Import:
  - UpstreamImportClient (typed HttpClient): static Upstream Uri, MaxBytes = 2 MB, IsValidShareId, DownloadUri, DownloadAsync returning ImportOutcome (Ok(Text) | InvalidId | NotFound | TooLarge | Failed(Reason, UpstreamStatus?)).
  - UpstreamImportSetup.AddUpstreamImport(): SocketsHttpHandler with no redirects, decompression, no cookies; 20 s timeout.
- Homebrewery.Api.Notifications: NotificationService (scoped; MaxDismissKey, MaxTitle, MaxBody, NotFoundTitle), NotificationInfo, NotificationInput.
- Homebrewery.Api.Admin: AdminService (scoped) with GetStatsAsync, FindUsersAsync, FindBrewAsync, ListLocksAsync, ReviewQueueAsync, LockAsync, UnlockAsync, DismissReviewAsync, RequestReviewAsync; constants MinLockCode=100, MaxLockCode=999, MaxLockMessage=1000. Contracts: AdminStats, AdminUserInfo, AdminLockInfo, AdminBrewInfo, LockedBrewInfo, LockRequest.
- Lock writes are single SQL UPDATEs on the jsonb lock column with camelCase keys. They change neither version nor updated_at.
- Endpoints: ImportEndpoints.MapImportEndpoints(api); NotificationEndpoints.MapNotificationEndpoints(api) and MapAdminNotificationEndpoints(adminGroup); AdminEndpoints.MapAdminEndpoints (the group also declares ProducesProblem 401/403); BrewEndpoints adds RequestLockReviewAsync.
- DI: TimeProvider.System is registered with TryAddSingleton.

TESTS (tests/Homebrewery.Api.Tests):
- Infrastructure/FakeHttpHandler: Respond delegate, Requests (RecordedRequest(Method, Uri, Host, Headers)), Reset(), static Text(body, mediaType, status).
- To fake an HttpClient in a derived host: WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddHttpClient<T>().ConfigurePrimaryHttpMessageHandler(() => fake))).
- HomebreweryApiFactory.GenerousPermitLimit = 1_000_000. The shared host sets all three RateLimits PermitLimits to it: TestServer has no remote IP, so every test client shares one partition. Lower the limits on a derived host to test limiting.
- Admin/AdminApiTests.Accounts and Notifications/NotificationTests.Admin are class fixtures that each provide an admin client.

OPENAPI FILES:
- shared/openapi.json: pretty-printed, LF line endings (descriptions CRLF→LF), no servers.
- web/src/api/schema.d.ts: openapi-typescript 7.13 output; exports paths, components, operations; lint- and tsc-clean.
- web/package.json script: "api:types": "openapi-typescript ../shared/openapi.json -o src/api/schema.d.ts".
- To regenerate after any endpoint or DTO change (Git Bash):
  - HB_UPDATE_OPENAPI=1 dotnet test --project tests/Homebrewery.Api.Tests --filter-class Homebrewery.Api.Tests.OpenApiExportTests
  - then npm --prefix web run api:types
- OpenApiExportTests fails when either file is stale.

### Notes for later phases
- E2E (web): Playwright APIRequestContext calls that write (register, login, create brew) must send an Origin header equal to baseURL, or SameOriginWriteGuard returns 403. Browser-page fetches are fine.
- E2E on a Vite port other than 5173: /share/* goes through that Vite's proxy to the API, which fetches index.html from Spa:DevServerUrls (localhost:5173, then web:5173). For e2e that opens /share pages, start the API with Spa__DevServerUrls=http://localhost:<E2E_PORT>; otherwise it falls back to wwwroot/index.html or returns 404.
- Development rate limits are relaxed (auth 1000/min, writes 10000/min, import 100/min), so e2e runs against a Development API won't hit 429. Production defaults are 20/120/10 per minute.
- web/eslint.config.js (web owner): consider ignoring src/api/schema.d.ts as generated code. It is lint-clean today, but a future DTO shape could trigger typescript-eslint rules.
- compose (docker-compose.yml owner): no change is required. Optionally set Spa__DevServerUrls=http://web:5173 on the api service to skip the failed localhost:5173 attempt; the working candidate is remembered, so the cost is small.
- P7.4 admin UI: use the routes in interfacesForOthers. Lock codes are validated as 100-999 (upstream's tool defaults to 455). Unlock is idempotent. Relocking clears the review request. The queue lists brews until an admin unlocks or dismisses the request.
- P7.1 share page: a 423 from /api/brews/share/{id} carries detail = shareMessage and code. The editor's BrewForEdit.lock.reviewRequested shows whether a review was requested; POST /api/brews/{editId}/lock/review requests one.
- P6 import page: GET /api/import/homebrewery/{shareId} accepts only 10-14 character ids (plan regex, ASCII \w). Upstream also has 7-9 character legacy ids and longer Google Drive ids, which are rejected with 400. On 502, use upstreamStatus to explain (e.g. a locked upstream brew answers with its lock code).
- Any new endpoint must have WithName, WithTags and WithSummary, or OpenApiExportTests fails. Then regenerate shared/openapi.json and schema.d.ts with the two commands in interfacesForOthers.
- README / CLAUDE.md owners may want to document the HB_UPDATE_OPENAPI regeneration flow, the RateLimits:* settings and Spa:DevServerUrls.
- P8.3: CSP and other security headers are still to do. The ShareShell HTML response carries Cache-Control: no-cache, and the import endpoint sends X-Content-Type-Options: nosniff.
- Process note: early on I stopped my own API instance with `taskkill /F /IM Homebrewery.Api.exe`; it terminated one PID (the instance I had just started on port 5099). Later cleanups killed by listening PID only. If another agent saw its API on 5080 stop at about the same time, this may have been the cause.

## Import: hbfmToDoc, sanitizer, report, probe, S3 fidelity harness (S3, P6.2)

### Interfaces
IMPORT (web/src/editor/import/index.ts; needs a browser DOM: the probe lays the pages out in a hidden iframe):
- `hbfmToDoc(raw: string, options?: HbfmToDocOptions): Promise<HbfmImportResult>`.
  - `HbfmToDocOptions { theme?: string; probe?: (theme, css, lang) => Promise<Probe>; themeOptions?: LoadThemeChainOptions; fontsTimeoutMs?: number /* 10000 */; imagesTimeoutMs?: number /* 10000, waited at the same time as the fonts */; variables?: 'expand' | 'keep' /* 'expand' */ }`.
  - `HbfmImportResult { doc: JSONContent; style: string; meta: BrewMetadata; report: ImportReportData; html: string }`.
    - doc: one manual page per source page (`\page` split); markers, footer, page number and objects are already page attributes.
    - style: the ```css block plus any `<style>` tags from the text, unscoped. Save it as the brew style; EditorCanvas scopes it (userCss).
    - meta: `title, description, renderer, theme, lang, snippets (\snippet text), tags, bleedSize, safetySpace, trimSize, columns, columnGutter, license, legalAuthors`.
    - html: the lifted page HTML that went into generateJSON (debugging and tests only).
  - Theme = options.theme ?? meta.theme ?? DEFAULT_IMPORT_THEME ('5ePHB'); report.theme holds the theme that was used.
  - Throws `ImportError` (code 'legacy-renderer') for `renderer: legacy`. Other failures (theme not found, stylesheets, fonts timeout, bad metadata YAML) do not throw; they go to report.warnings.
- `ImportReportData` (importReport.ts; plain JSON, ready for P6.3):
  `{ pages; theme; clippedPages: {page, estimatedPages, paginatedPages?}[]; variables: { mode: 'expand'|'keep'; definitions: {name, page, form: 'block'|'inline'}[]; unresolved: {page, call}[] }; paginated: { pages; grown: {page, pages}[] } | null; rawHtml: { count; samples: string[] (≤20, 80 chars) }; commentsDropped; styleTagsLifted; unknownClasses: {name, count}[] | null (null = no stylesheet loaded); sanitizer: { elements: Record<tag, n>; attributes: Record<attr, n> }; transparentElements: Record<'font'|'span (without inline-block)'|'em[class|style|id]'|…, n>; lifted: { markers; footers; pageNumbers; objects }; positionedInFlow: {page, tag, classes, reason}[]; lost: string[]; warnings: string[] }`. Pages are 1-based everywhere.
  - `variables.unresolved` lists only `$[…]` calls left as text: the unresolved ones in 'expand' mode, and every call in 'keep' mode. Plain `[text]` is ordinary markdown and is not listed.
  - `sanitizer` lists only real removals. DOMPurify's own `<remove>`/`<body>` scaffolding is not counted, and neither are heading ids (DOM-clobbering protection drops ids like "title"; the HeadingIds plugin regenerates them).
- Pagination hook (plan §7 "how many pages they grew into"): `recordPaginatedPages(report, doc: JSONContent | PMNode): ImportReportData` returns a new report with `paginated` filled in and `clippedPages[].paginatedPages` set. Call it once pagination has settled (isSettled) and before the user edits. `sectionPageCounts(doc): number[]` gives pages per manual page. `ImportReport#setPaginatedPages(page, n)` still exists for the builder.
- Sanitizer (sanitize.ts; private DOMPurify instance, allow-list):
  - `sanitizeImportHtml(html): string`.
  - `sanitizeImportHtmlDetailed(html): { html, removed: SanitizeRemovals }`.
  - `realRemovals(DOMPurify.removed): SanitizeRemovals`.
  - `IMPORT_HTML_TAGS`, `IMPORT_HTML_ATTRS`.
  - Throws where DOMPurify can't run (no DOM), so an import never skips sanitizing.
- HBFM renderer (hbfm/renderer.ts): `createHbfmRenderer({ variables?: 'expand'|'keep' }): HbfmRenderer { marked, render(text, pageIndex = 0): string, pageLineTags(line): InjectedTags | null, variables: BrewVariables }`.
  - It is a port of marked-hbfm 1.0.1 on a private `Marked` instance, without marked-variables.
  - Its output is byte-identical to marked-hbfm on every fixture without variables (renderer.test.ts). Upstream's tests/markdown suites also pass against it (upstreamSuite.test.ts).
  - Use one renderer per document: page 0 resets heading slugs, and later pages see earlier variables.
  - Also exported: `processStyleTags`, `BrewVariables({ expand })`, `evaluateMath(expr)` (safe subset of expr-eval; throws on anything else; at most 1000 characters).
- Brew text (brewText.ts):
  - `splitTextStyleAndMetadata({ text, tags? }): SplitBrew` (`text` without the blocks, CRLF→LF; `style`; metadata fields; `metadataError`).
  - `yamlSnippetsToText`, `brewSnippetsToJSON`.
  - YAML is parsed with js-yaml `load` (default schema, no code execution).
- Pages (pages.ts): `PAGE_SPLIT`, `splitPages`, `stripPageLine`, `pageLine`, `pageShellFromTags`, `buildPageElement(doc, shell, innerHtml, extraAttrs)`. The `\page {…}` id is ignored, as upstream.
- Lifting (lift.ts): `analyzePage(pageEl, win, index)` then `applyLift(pageEl, analysis)`. Analyse every page first, because lifting changes `:has()` matches.
  - `measureClipping(wrapper, win)` counts in-flow content only. Overflow columns to the right, or monolithic `.wide` blocks and images past the bottom, count as clipped.
  - `containingBlock(el, win)`.
- `UPSTREAM_BASE_CSS`, `PROBE_LAYOUT_CSS`, `OPEN_SANS_CSS` (upstreamBase.ts). OPEN_SANS_CSS holds @font-face rules for documents without EditorCanvas.module.css, and uses the files in canvas/fonts.
- Probe (web/src/editor/canvas/probe.ts, import lane):
  - `mountProbe(themeKey, userCss?, { document?, chain?, themeOptions?, lang?, width? = 1100 }): Promise<Probe>`: a sandboxed (no scripts), same-origin, off-screen iframe with Open Sans, the upstream base, the theme chain and the scoped user CSS.
  - `mountInlineProbe({ document?, lang? }): Probe` for jsdom.
  - `Probe { root (div.pages), canvas, document, window, chain, failedStyles, fontsReady(timeoutMs?), imagesReady?(timeoutMs?), stylesheetClasses(), dispose() }`. imagesReady (optional; mountProbe waits for load/error of every non-lazy img under root, false on timeout; mountInlineProbe resolves true at once) is also exported as `waitForImages(root, timeoutMs = 10000)`.
  - `probeUserCss(css, baseURL)`.

For P5.1 snippets: page-producing snippets (cover pages, license pages) should go through `hbfmToDoc(snippetText, { theme })`, because covers need lifting (markers, objects, footers). Insert `doc.content` as manual pages. For block snippets, `hbfmToDoc` plus the first page's `content` is also the simplest path. The lighter path (`createHbfmRenderer().render` → `sanitizeImportHtml` → `markMultilineDefinitionLists` → insertContent) skips lifting and the rawHtml conversion below. Do not render with marked-hbfm outside dev code.

For P6.1: the import page calls `hbfmToDoc(text)` for pasted text, an uploaded .txt, or the text from GET /api/import/homebrewery/{shareId}. It saves `doc`, `style`, and the meta fields (title, description, lang, theme, tags). The raw text goes into brews.source_markdown. `hbfmToDoc` needs a document: it mounts, then disposes, a hidden iframe, and waits for the theme and fonts.

DEV / HARNESS
- `/dev/import?fixture=<name>[&theme=][&view=canvas|plain][&variables=expand|keep][&experiment=trailing-break|trailing-break-separator]`. Experiments are CSS measurements only, not editor CSS.
  - The default view is EditorCanvas, read-only: NodeViews, canvas.css, scoped CSS, fonts, no pagination.
  - `view=plain` is a bare TipTap editor.
  - `window.__hbImport` holds the result; `window.__hbImportApi = { hbfmToDoc, recordPaginatedPages, sectionPageCounts }` is available on any /dev/import URL.
  - `data-render-status="ready"` is set when the page is ready.
- `/dev/legacy-render?fixture=<name>`: upstream's preview reproduced with marked-hbfm (dev only), safeHTML and the `\column` hack, in an iframe.
- Fixtures: web/e2e/fixtures/*.hbfm.txt plus fixtures.json (309: welcome, 149 V3 snippets, 159 tests/markdown cases). Regenerate them with `npx tsx scripts/fidelity-fixtures.ts`; seeded, so the output is stable.
- Fidelity: one command from web/: `npx tsx scripts/fidelity-run.ts [--browsers chromium,firefox] [--variants keep,trailing-break,plain] [--workers n] [--filter <re>] [--port 5303] [--report-only]`.
  - It writes e2e/fixtures/fidelity-report.md, with the hand-written e2e/fixtures/fidelity-findings.md included.
  - Raw results go to test-results/fidelity-runs/<run>.
  - The checked-in report was made with `--browsers chromium,firefox --variants keep,trailing-break`. Chromium: 11 min; Firefox: 22 min at default workers.
  - Result: Chromium 302/309 (97.7%), Firefox 301/309 (97.4%), with the trailing-break proposal 304/309.
- Specs: e2e/import/hbfmToDoc.spec.ts (lifting with real theme CSS, clipping) and e2e/import/fidelity.spec.ts (smoke subset unless FIDELITY=all). Port 5303.

DECISIONS
- Variables (P0 security finding; plan §1): imports never load marked-hbfm, marked-variables or expr-eval. noUpstreamVariables.test.ts mocks all three to throw on import.
  - Default 'expand': a port of marked-variables with a hand-written evaluator (math.ts: numbers, strings, + - * / ^, ?:, round/floor/ceil/abs, the Homebrewery functions).
  - The evaluator has no property access, assignment or function definitions. `fac` is capped at 170, and expressions are capped at 1000 characters.
  - Variable state is per import (null-prototype maps), so `__proto__` is only a name.
  - Fidelity impact, measured on Chromium over the 44 fixtures that use variables:
    - 'expand': all 44 pixel-identical to upstream (0.00%).
    - 'keep': all 44 differ (mean 0.16%, max 0.62%). The text is wrong, but they still pass because they are one-liners, so the total is 302/309 either way.
  - 'keep' (text as written) stays available as an option, and the report lists definitions in both modes.
- The report lists only real sanitizer removals (see above). The previous report's `remove×N, body×N` on every fixture was DOMPurify scaffolding.
- A positioned inline element (containing block = page) that is alone on its line becomes a rawHtml block. Example: the front cover's `{{logo ![](…)}}`, which upstream renders as a bare span outside any `<p>`. It renders in the same place without the empty ProseMirror line: front cover 4.64% → 1.42%. Richer positioned blocks (e.g. `.artist`) stay themeBlocks in the flow. Both are listed in report.positionedInFlow.
- Clipping is measured on in-flow content only. The earlier scrollWidth-style check flagged 5 fixtures that fit (class tables with decoration frames, the wide stat block, OGL section 15). No fixture clips upstream now, so the "clipped upstream (expected)" status in the report is implemented but unused by the current fixtures.
- The probe and both harness frames now load Open Sans, as the editor does, so Blank-theme text lays out as it will in the editor.
- Natural image sizes (plan §6.6; objects-lane carry-over): hbfmToDoc waits for the probe's images (with the fonts), reads `naturalImageSizes(probe.root)` (import/imageSizes.ts: Map src → {width, height} of loaded images) before lifting, and `applyNaturalSizes(doc, sizes)` writes them into image nodes that have neither width nor height (an author's width/height attribute is kept; failed, lazy and timed-out images get none). ImageWithView's natural-size plugin then has nothing to record for them. A timeout adds the report warning 'Some images did not finish loading; …'. Page objects have no size fields and are not sized.

### Notes for later phases
- web/package.json owner (I could not run npm install):
  - Add explicit dependencies for the marked extensions that hbfm/renderer.ts imports. They currently resolve only as transitive dependencies of marked-hbfm: marked-alignment-paragraphs ^1.0.0, marked-definition-lists ^1.0.1, marked-diagrams-markdeep ^1.0.1, marked-emoji ^2.0.3, marked-extended-tables ^2.0.1, marked-gfm-heading-id ^4.1.4, marked-nonbreaking-spaces ^1.0.1, marked-smartypants-lite ^1.0.3, marked-subsuper-text ^1.0.4.
  - Then move marked-hbfm to devDependencies. Only dev pages (/dev/legacy-render, /dev/canvas view=legacy), tests and scripts/fidelity-fixtures.ts import it, so expr-eval leaves the production dependency tree. math.test.ts uses expr-eval as a test oracle.
  - Optional: add the script `"fidelity": "tsx scripts/fidelity-run.ts"`.
- Canvas lane (canvas.css): two ProseMirror artefacts cost fidelity. The exact HTML and measurements are in e2e/fixtures/fidelity-findings.md.
  - (a) Empty `<dt></dt>` (from `::Text`) gets `<br class="ProseMirror-trailingBreak">`. Proposal: `.hb-canvas .page :is(dt, dd) > br.ProseMirror-trailingBreak { display: none }`. GNU FDL 17.99% → 0%, ORC notice 2.92% → 0%.
  - (b) A paragraph holding only a float (`<p><a><img style="float:right"></a></p>`) gets `img.ProseMirror-separator` plus a trailing break, i.e. a 16px line upstream doesn't have. Proposal: `.hb-canvas .page p:has(> :not(br)) :is(img.ProseMirror-separator, br.ProseMirror-trailingBreak) { display: none }`. Firefox welcome 2.07% → 1.18%. Check caret placement after a trailing inline image first.
- P5.6 and canvas (tables): 5 class-table fixtures fail only because header rows are in `<tbody>`. See findings item 1 for the input HTML, the theme lines (5ePHB style.less:149-167, Blank :111) and the expected result.
- P6.3 (report UI): show clippedPages (with paginatedPages after recordPaginatedPages), variables.definitions / unresolved (mode), rawHtml.count and samples, commentsDropped, unknownClasses, transparentElements, sanitizer, positionedInFlow, lost and warnings. Call recordPaginatedPages(report, editor.state.doc) once isSettled() is true after the first settle.
- CI: e2e/import/fidelity.spec.ts runs a 12-fixture smoke subset in the fidelity job. It asserts the harness only, not the diffs. The full run is local: `scripts/fidelity-run.ts` runs it as sets of 50 fixtures (`--shard`), one short Playwright run each (`--set=<n>` for one set per command).
- Flaky under load, not mine: src/dev/registry.test.tsx uses findByRole's 1 s default and timed out once in a loaded full `npm test`; it passes alone. My dev routes now load their pages lazily (Lazy*Page.tsx), which lightens the eager registry.
- An upstream `{{pageNumber 1}}` (a fixed number, not `auto`) becomes a text page object, not page.pageNumber (welcome). Only `{{pageNumber,auto}}` sets pageNumber: true.
- Legacy-renderer brews are rejected with ImportError('legacy-renderer'). P6.1 should explain that the brew must be switched to V3 upstream first.
- Imported (and snippet-inserted) images now carry width/height. Any editor that renders them must use ImageWithView (EditorCanvas does, through editorNodeViews): the schema's plain renderHTML emits both as HTML size hints, so an author width (e.g. `{width:325px}`) with the natural height distorts the image. The eager-image overrides of /dev/import and /dev/snippets (web/src/dev/snippets/SnippetsDevPage.tsx, snippets lane; a two-line change made here) now extend ImageWithView instead of HbImage. Objects lane: `ImageWithView.extend({...})` must override addProseMirrorPlugins with `return this.parent?.() ?? []`, because extend() copies the parent's function, which already calls this.parent, and the keyed natural-size plugin would be added twice (RangeError 'Adding different instances of a keyed plugin').
- Export (P6.4): the same applies to exported HTML (see the objects lane's note on img[data-hb-natural]).



## Phase-2 review: Firefox multicol fix and canvas.css changes

### Interfaces
canvas.css (web/src/editor/canvas/canvas.css):
- Page structure: `.hb-canvas .page { display: flex; flex-direction: column }` and `.hb-canvas .page > .columnWrapper { flex: none; min-height: 0; height: 100%; max-height: 100%; column-fill: auto }`.
  - .page is no longer a multi-column box. Its column-* values still compute, and .columnWrapper still inherits them, so pagination's read of the wrapper's computed column-count is unchanged.
  - Absolutely positioned chrome with no horizontal offset now has its static position at the content-box start instead of following text-align. Only empty marker spans rely on this.
  - Not !important: brew CSS can still hide a page. A brew that sets .page back to display: block re-creates the Firefox hang risk.
- Continued list items: `.hb-canvas .page li.hb-continued::marker { content: none }`. The item stays display: list-item, so the counter continues.
- Filler paragraph: `li.hb-continued > p.hb-continued:first-child:not(:only-child):has(> br.ProseMirror-trailingBreak:only-child) { display: flow-root; height: 0; margin-top: 0; overflow: clip }`. The following `p + *` margin stays inside the item.

EditorCanvas:
- New prop `repaginateDelayMs?: number` (default 300, plan §4.7): the debounce of the REPAGINATE(0) that a theme or user CSS change triggers. It is dispatched once styles and fonts are applied, and no sooner than repaginateDelayMs after the last theme/CSS change. The first load is immediate.
- `userCssDelayMs` keeps its default of 150 (visual apply).
- The 'css' and 'theme' RepaginateEvents now arrive up to 300 ms after the change. Tests must poll for them.

useCanvasTheme (web/src/editor/canvas/useCanvasTheme.ts):
- `options.userCss` is now the raw edited value. The hook debounces it itself.
- New options `userCssDelayMs?` and `repaginateDelayMs?`.
- New exports: USER_CSS_DELAY_MS = 150, REPAGINATE_DELAY_MS = 300. `useDebouncedValue` is still exported.

/dev/canvas:
- New docs `?doc=tall` (tall li / nested li / blockquote / ordered li, one per page; use it for a manual Firefox check) and `?doc=continued` (a continued ordered item, a continued item with the filler, a continued item with text, a whole item).
- web/src/dev/canvas/devDocs.ts exports tallDoc, continuedDoc and LIST_TEST_IDS.
- The e2e helper openCanvas accepts doc: 'tall' | 'continued'.

New spec web/e2e/canvas/multicol.spec.ts:
- Checks the structure, tall content, and layout equality against upstream's structure (the `.page { display: block }` injection; Chromium tolerance 0, Firefox 0.5 px). It attaches layout-*.json per case so later canvas.css changes can be diffed.
- Also covers continued list items and the pagination output.
- Uses the pagination lane's e2e/pagination/harness.ts helpers read-only.

### Notes for later phases
- Pagination lane (bug found, not fixed, outside my paths): a cut that falls inside the paragraph of a NESTED list item throws `TransformError: Invalid content for node listItem`, logs '[pagination] step failed; pagination stopped until the next change', and sets stats.errors to 1. Repro (/dev/pagination, 5ePHB, paginate off, then setPaginate(true)): doc(page([p(filler(3000)), ul(liOf(p('Short item.'), ul(liOf(p(filler(9000, 2)))))), p('After the list.')])); chooseCut gives rule 'nested' at pos 3072. A cut between nested items (a nested list of 40 short items) works. Probably splitFilled/continuationAttrs at depth > 2.
- Export (P6.4), share view and print: copy canvas.css's .page flex rule and the wrapper's `flex: none; min-height: 0` into exported CSS. Otherwise Firefox hangs (then crashes the tab) viewing or printing exported HTML that has a list item or blockquote taller than a column. Upstream's preview has the same hang. Copy the continued-list marker/filler rules too.
- Blank theme has its own Firefox-only rule (style.less:686-693, `@supports (-moz-user-select: none)`) that sets blockquote and table to break-inside: auto in Firefox. So tall blockquotes and tables split in Firefox but move whole in Chromium. This is not new, but pagination results can differ between browsers for them.
- The continued-list filler rule relies on ProseMirror rendering an empty paragraph as a lone br.ProseMirror-trailingBreak, and on pagination's splitFilled producing li.hb-continued > p.hb-continued:first-child followed by a nested block. If a paragraph NodeView or the filler shape changes, update the selector (multicol.spec 'continued list items' will fail).
- P4.7 seam editing: the filler paragraph is invisible (height 0, overflow clip) but still exists. Arrow keys and clicks skip it visually; typing into it (if a selection lands there) makes it a visible paragraph.
- Repagination debounce: the 'css'/'theme' REPAGINATE now arrives up to 300 ms after the change (repaginateDelayMs). Tests that read onRepaginate/repaginations right after a restyle must poll.
- docs/implementation-notes.md needs updates (outside my paths):
  - canvas.css list: the page flex structure and why, plus the continued-list rules.
  - EditorCanvas: the repaginateDelayMs prop.
  - useCanvasTheme: the options change and the USER_CSS_DELAY_MS/REPAGINATE_DELAY_MS exports.
  - /dev/canvas: the tall and continued docs.
  - Pagination notes: the Firefox hang item is resolved (cut.spec skip removed), and the continued-marker/filler item is done.
- Test environment: parallel agents' Vite HMR (e.g. the import lane editing src/editor/import/hbfm/variables.ts) breaks dev-route loading in Firefox mid-run. CPU load pushes the Firefox 30-page perf test over 500 ms and can split undo groups (s2 undo/redo). Use --workers=2 or rerun failures alone before blaming code.
- Leftover processes: a headless Playwright Firefox (PID 27000, started 22:33, before my runs) is still running from another agent. My killed repro browsers were cleaned up.
- Lint: web/e2e/import/zz-debug.spec.ts (import lane's temporary debug spec) has 3 eslint errors and breaks `npm run lint` project-wide.


## Phase-2 review: backend fixes (BS-1..5, BE-1..13)

### Interfaces
Backend interface changes (also in docs/implementation-notes.md, backend sections):
- RawHtmlSanitizer(TimeSpan? timeLimit = null); Sanitize(html) and Sanitize(html, timeLimit) return RawHtmlResult(Html, Text, Error). When Error is set, Html is "". Constants: MaxLength 1 MB, MaxTags 10,000, MaxAttributes 256, MaxDepth 512, MaxElements 20,000, DefaultTimeLimit 3 s. TimeLimit is per document and shared across rawHtml nodes by DocInspector.
- DocInspector now gives these errors: rawHtml over the limits at errors['…attrs.html'] (message e.g. 'must not nest elements more than 512 levels deep'); a child sequence that does not match the content expression, at the parent's path ("'listItem' content must match 'paragraph block*'"). It drops, with a warning: a mark equal to or excluded by an earlier mark; link.target other than _blank/_self; the 'opener' token in link.rel; numbers it cannot store ('…: not a storable number'). icon.glyph is kept as a space-separated class list.
- StoredText.ToNumber(JsonElement), StoredText.Truncate(value, max), MaxNumber = 9007199254740991, MinNumber = 1e-15. ToNode now makes numbers canonical: '2.0' → 2; non-finite or too-large values → null.
- SchemaManifest.ContentMatches(type, childTypes); NodeSpec.Groups (from the manifest's 'group'); MarkSpec.ExcludesMark(type). A content expression that names an unknown type or group now fails the manifest load.
- CssPolicy.Check: property names must stand alone; expression(/behavior:/-moz-binding count only outside CSS strings; javascript:/vbscript: count everywhere.
- BrewService(AppDbContext, DocInspector, ThemeCatalog). A meta.theme set to a new value must be a catalog key or the share id of a theme-tagged brew, else 400 errors['meta.theme'].
- BrewRules: meta.tags/meta.authors lists longer than 200 are refused unread; one error per problem; a null author gives 400.
- GET /api/users/{handle}/brews (own list): brews the user is only invited to come after the others. The OpenAPI description changed; shared/openapi.json and web/src/api/schema.d.ts are regenerated.
- POST /api/auth/register with a taken email now returns 200 with an empty body (same as a new account); the account is not changed.
- In every environment, request-binding errors (BadHttpRequestException) return their own status (400/413) as problem+json.
- Tests: SchemaManifestTests.RepositoryRoot() works with --artifacts-path (the test csproj writes AssemblyMetadata 'RepositoryRoot').

### Notes for later phases
- Web (schema owner), BS-4: the client should also normalize link rel/target when rendering (web/src/editor/schema/marks.ts createHbLink: drop 'opener', allow only _blank/_self targets), because pasted HTML (fromHtml) still keeps rel='opener' locally until the next save round-trip. Optionally give link.target/rel manifest kinds later; the server currently special-cases them by owner type and attribute name in DocInspector.
- Web (schema owner), BE-3: icon.glyph is handled on the server as a space-separated class list, special-cased by owner 'icon' and attribute 'glyph'. If the manifest gets a 'classList' kind, SchemaManifest.ParseKind and DocInspector must learn it at the same time, because the API refuses unknown kinds.
- Web (editor/import owners), BS-1: the server now refuses rawHtml over 1 MB, 10,000 tags, 256 attributes on one tag, 20,000 elements or 512 nesting levels, and rawHtml whose parse takes longer than 3 s per document. A save with such rawHtml gets a 400 at errors['…attrs.html'], and autosave then fails until the node is fixed. The client (web/src/editor/schema/html.ts sanitizeRawHtml and the importer's lift.ts) should apply the same limits and show the error.
- Web (editor/import owners), BE-4: documents whose listItem does not start with a paragraph are now rejected with a 400 at the listItem's path. ProseMirror's DOMParser and the editor never produce these, but hand-built import JSON might.
- Web (account UI owner), BS-5: register with a taken email now returns 200. A register-then-auto-login flow will get 401 on the login in that case; the UI should say something like 'if you already have an account, sign in or reset your password' rather than showing a generic failure.
- Backend (P8), BS-5: to fully close account enumeration, add an IEmailSender, require confirmed emails, and answer register with a uniform 'check your email'.
- Backend: the rawHtml time limit (RawHtmlSanitizer.DefaultTimeLimit, 3 s per document) is wall-clock time, so a heavily loaded server could in theory refuse legitimate but very large rawHtml. The deterministic caps (tags, attributes, depth, elements, length) cover the known attack inputs; the timer is a backstop for misnested-formatting input, which AngleSharp clones without any per-element hook.
- Backend: BadHttpRequestException in Development is still logged by the exception handler at Error level. Only the status code changed.
- Process: I built with --artifacts-path to a private temp folder while iterating, then ran the final in-tree dotnet build and test once, as the task asked. No git commands were run. No packages were added.


## Phase-2 review: schema and canvas fixes (RV-1..16)

### Interfaces
schema (web/src/editor/schema):
- New node rawInline (inline atom, attr html, manifest kind html) for svg/math/video/audio/canvas/map/object/picture inside paragraph/heading/definitionTerm/definitionDesc. Multi-root HTML renders in span[data-hb-raw]. Exports RAW_INLINE_TAGS, RawInline, RawInlineAttrs; NodeName includes 'rawInline'.
- ICON_FONTS adds 'fa', 'fa-solid', 'fa-regular', 'fa-brands', 'fa-classic'. The font is the first icon-font class in class order.
- RESERVED_ATTRS adds 'data-hb-clipboard'.
- attrs.ts exports isAuthorClass(c).
- normalizeMarkers/normalizePageObjects drop reserved classes. The page's flow is ':scope > div.columnWrapper'.
- rawHtml renders a single root as is only when the rawHtml rules parse it back; otherwise it wraps it in div[data-hb-raw]. The div catch-all decides after sanitizing and never stores data-pm-slice or data-hb-clipboard.
- html.ts: isSafeHref(url), isSafeSrc(url), urlScheme(url), MAX_URL_LENGTH. isSafeUrl is deprecated. Images and page objects accept data:image/*. Links accept only http, https, mailto, relative and #.
- rawHtmlToElement(html, doc, { wrapper?: 'div'|'span', keepRoot?: (el) => boolean }).
- slug.ts isGeneratedHeadingId(el, id).
- plugins: headingIdUpdates(doc, keeps?) → {pos, id, customId?: false}[]; assignHeadingIds(tr, keeps?); pagesNeedingIds(doc, keeps?); assignPageIds(tr, generate?, keeps?); survivors(transactions, before: () => Map<pos, id>) → Survives. Heading slugs reserve p1..pN.
- manifest: AttributeManifest gains enum?/integer?/min?/max? (type AttributeConstraints). MANIFEST_VERSION stays 1.

canvas (web/src/editor/canvas):
- cssScope: constrainSelector and constrainSelectorList; IMPORT_TIMEOUT_MS. inlineCssImports gains timeoutMs (default 10 s); signal only stops waiting. Nested rules get :where(.hb-canvas, .hb-canvas *). ScopeReport.scopedRules counts nested rules.
- themeLoader.disposeThemeSlot(slot, doc?).
- pasteCleanup: CLIPBOARD_ATTR; isEditorClipboardHtml(html, parser?) parses the DOM.
- EditorCanvas .viewport has contain: layout paint. Anything using position: fixed inside the viewport is confined to it, so portal popovers outside.

### Notes for later phases
- Backend (P2.4 follow-up): DocInspector/SchemaManifest.cs should read the new optional enum/integer/min/max fields and drop or reset invalid values (page.columns 3, heading.level 7, toc.depth 9, page.kind 'x', colspan 0). The client never writes such values.
- A shared fixture (e.g. shared/url-policy-cases.json) read by schema/html.test.ts and a UrlPolicy/DocInspector xUnit test would keep the client and server URL policies from drifting; the client cases now copy DocInspectorTests.cs.
- Importer (P6.2): count rawInline nodes in importReport alongside rawHtml; report empty <i> elements whose classes match no icon font (they still vanish as empty italics); optionally mark {#id} heading ids with data-custom-id.
- Pagination lane: pagination/measure.ts and dev/pagination/harness.ts still find the flow with ':scope > .columnWrapper'; ':scope > div.columnWrapper' is the robust form (page.ts, PageView and columnNavigation now use it).
- P5.3 and later UI: EditorCanvas's viewport has contain: layout paint, so position: fixed popovers or toolbars rendered inside it are confined to the viewport. Render them through a portal outside it.
- Heading ids reserve p1..pN only up to the current page count, so a heading titled 'P7' changes its id once the brew reaches 7 pages. This is rare; acceptable per plan §3.4 uniqueness.
- Clipboard marker data-hb-clipboard='1' is static. A page that deliberately forges it can skip paste cleanup, but server sanitizing and canvas containment still apply. If share/export HTML should keep classes on paste, add a similar marker (e.g. data-hb-export).
- Playwright: under heavy concurrent load the default worker count makes Firefox canvas tests (including pre-existing ones) time out. Running with --workers=4 was reliable here.


## Phase-2 review: pagination fixes (PG-1..14)

### Interfaces
Pagination (web/src/editor/pagination/index.ts):
- The Pagination extension now also overrides TipTap's `updateAttributes` for nodes: one AttrStep per changed, declared attribute; marks still use TipTap's command. Convention for every lane (inspector, align, classes): change node attributes with updateAttributes or tr.setNodeAttribute, never setNodeMarkup, or their undo can be lost after a boundary move.
- New exports: `fragmentChain(doc, pos)` (positions of all fragments of a split block, head first), `shareFragmentAttrs`, the meta `FRAGMENT_ATTRS = 'hbFragmentAttrs'`, `updateAttributes`, `renumberContinuations(tr, i)` and `blockRects`.
- The plugin has an appendTransaction: attributes changed on one fragment go to every fragment. At touched seams, continuations take their head's attributes, except continuation, id, start and customId. It joins the author's undo event.
- `PageLayout.isHidden?()` is new. When measure returns null: blocked if isHidden() is true or missing, otherwise that page is skipped.
- `Geometry`/`PageMeasure` gained `rtl`. `columnOf` now takes a rect `{left, right}` instead of a left edge.
- `measurePage` also returns null while an unsized, unloaded image in the page's flow is loading (at most 3 s); it switches lazy images to eager.
- The scheduler re-checks a page on load or error of an image that a measurement saw unloaded (the P4.5 image trigger is built).
- REPAGINATE payloads and `repaginate()` arguments are floored, clamped or ignored, and never throw.
- `changedPages` is linear in the number of steps.
- testing.ts: new `seamProblems(doc)` oracle; the line-model layout mirrors the keep-with-next fallback and the heading pull rule.
- Dev harness `window.__hbPagination`: `overflowing()` is now DOM truth; new `domTruth(i)` and `flowText()`; the fuzz report has `textChanged`. The e2e mirror types are updated, and there is a new e2e builder `imageParagraph(attrs)`.

### Notes for later phases
- No packages need installing.
- P4.7 seam commands: clear `continuation` on a fragment when its head is deleted, and handle Enter at the start of a continuation. Both fuzzes currently model the head-delete rule in their block delete (step.test.ts deleteBlock and the harness randomEdit); keep them in line with the real command.
- Undo of block-type changes on split blocks is still lost (PG-2 residual). Decide in P4.7 or P5: either replace the fragment chain for type changes (which drops the text's earlier undo steps), or accept and document the limitation.
- Image NodeView / import (§6.6): render editor images eagerly or with their stored natural width and height. Unsized images make their page wait up to 3 s and cost extra re-checks, especially in Firefox, where a moved paragraph's <img> has no size until it loads again.
- Autosave (P3.8): a page waiting for an image load is skipped as settled, so isSettled can be true for a moment. The load then re-checks the page; save again after that settle.
- Keep-with-next fallback leaves a chapter heading alone on its page when the next block only fits on a fresh page. P4.8 could offer a hint such as a column break.
- Run Firefox e2e with --workers=1 on a loaded machine: parallel Firefox workers time out while loading the theme.


## Phase-2 final verification notes

### Interfaces
No interface changes. Current verified state: backend 631/631, vitest 898/898, lint and typecheck clean, schema manifest, openapi.json and schema.d.ts fresh. The e2e suite has 238 tests (Chromium: all pass; Firefox: passes except load-sensitive timing tests). src/Homebrewery.Api/wwwroot now holds a fresh `npm run build` output. Docker image homebrewery-wysiwyg:dev exists locally. The compose db is running; api, web and caddy are stopped.

### Notes for later phases
- E2E, s2.spec.ts:132 ('a 30-page section settles in under 500 ms'): in Firefox every edit cascades through all 61 steps (89 for the delete). It takes about 150-340 ms on an idle machine but 500-950 ms with 11 or even 4 parallel workers, so it fails in every full parallel run. Options: run perf-budget tests in a serial project or tag, scale the budget when workers > 1, or measure steps or frames instead of wall time.
- E2E, e2e/import/hbfmToDoc.spec.ts: the helper waits up to 60 s for data-render-status=ready, but the test uses the default 30 s timeout, so under load the test times out first (seen for :70 welcome and :119). Consider test.setTimeout(90_000) or a describe-level timeout, as fidelity.spec.ts already does.
- E2E, measure.spec.ts:281 (zoom 50/100/200 %) timed out in page.goto once under load in Firefox; implementation-notes already recommends --workers=1 for Firefox on a loaded machine.
- Compose dev stack: the first cold load of /dev/canvas triggers Vite re-optimization (a 504, then 'optimized dependencies changed. reloading', twice) because the TipTap packages and dompurify are discovered only when the lazy dev routes load. Adding @tiptap/* (react, core, pm/*, extensions), clsx, nanoid and dompurify to optimizeDeps.include in web/vite.config.ts (or optimizeDeps.entries covering src/dev/**) would avoid the reloads.
- Production image: the runtime logs 'Cannot load library libgssapi_krb5.so.2' when Npgsql first connects (harmless; queries work). Install libgssapi-krb5-2 in the runtime stage, or add 'Gss Encryption Mode=Disable' to the production connection string, to silence it. The image also warns that Data Protection keys are not persisted (already noted for P8).
- The HMR websocket through Caddy accepted a bogus ?token=x with 101; check whether Vite 8's websocket token check is expected to reject that (a dev-only security hardening question).
- .gitignore shows as a whole-file rewrite in plain git diff because of line endings (core.autocrlf); ignoring line endings it is 23 insertions and 1 deletion. Consider a .gitattributes rule if the churn matters.


## Frontend foundation: API client, error policy, UI kit, UI store (phase 3, plan §5 and §9)

### Interfaces
API (web/src/api; import from '@/api'; the barrel also loads the TanStack `Register` augmentation that types `meta` as ApiRequestMeta):
- Client: `api: ApiClient` (openapi-fetch `Client<paths>` from schema.d.ts; baseUrl = location.origin, credentials 'include', global fetch looked up per call); `createApiClient({ baseUrl?, fetch? })`; `defaultBaseUrl()`; `unwrap(pending, { method?, url? })` → data or throws ApiError (network failure → ApiError.network; AbortError rethrown unchanged; 204 → undefined). `CallOptions { signal?, client? }` is the last parameter of every call function.
- `ApiError` (extends Error): kind 'http'|'network', status (0 = network), title (problem title or a default per status), detail, type, instance, errors (field → string[]), extensions (all non-standard members), code (423 lock code), serverVersion (409: plain SaveConflict body or problem extension), retryAfter (s), method, url, body; `hasFieldErrors`, `fieldError(field)`; `ApiError.fromResponse(response, body, request?)`, `ApiError.network(cause, request?)`. Also `isApiError`, `isAbortError`, `parseRetryAfter`, `defaultErrorTitle`, `DEFAULT_ERROR_TITLES`.
- Error policy (errorPolicy.ts): `classifyApiError(e)` → 'signIn' (401) | 'errorPage' (403, 404, 410, 423) | 'caller' (409; 400/422 with field errors) | 'toast' (everything else, network and non-ApiError errors included). `applyErrorPolicy(e, { source: 'query'|'mutation', meta?, key?, retry?, notify, onSignIn? })`; `errorPageData(e)` → { status, title, message, code } for P7 error pages (render it from `query.error`); `describeApiError(e)`; `isTransientError` (network, 408, 429, 5xx except 501); `shouldRetryQuery` (transient, at most 2 retries, Retry-After ≤ 10 s) and `retryDelay`; `errorToastId(key)`; `ERROR_TOAST_DURATION_MS` 8000. meta on any useQuery/useMutation: `{ errorPolicy?: 'auto'|'manual', errorTitle?: string }`.
- Events (events.ts): `onSignInRequired(listener) → unsubscribe`, `requestSignIn(error|null)`. The app's sign-in prompt (not built yet) subscribes; a "Sign in to save" button can call requestSignIn().
- gzip (gzip.ts): `encodeJsonBody(value, { gzip?: 'auto'|'always'|'never', minBytes?, level? })` → { body, headers, gzipped, jsonBytes, sentBytes }; `jsonBodyOptions(value, opts)` → openapi-fetch { bodySerializer, headers }; `GZIP_MIN_BYTES` 8 KiB. 'auto' gzips bodies of 8 KiB or more and sends Content-Encoding: gzip (fflate gzipSync, level 6). Used by createBrew and saveBrew.
- Keys (keys.ts): `queryKeys.{account.{all,me()}, brews.{all,edit(id),share(id)}, themes.{all,list(),bundle(t)}, vault.{all,search(params)}, users.{all,brews(handle)}, notifications.{all,active()}, admin.{all,stats(),users(q),brews,brew(id),locks(),reviewQueue(),notifications,notificationList(),notification(id)}}`; `mutationKeys` (register, login, logout, setHandle, createBrew, saveBrew(editId), deleteBrew, cloneBrew, requestLockReview, importUpstream, admin.{lock,unlock,dismissReview,createNotification,updateNotification,deleteNotification}); `normalizeVaultParams`, `normalizeHandle`.
- Types (types.ts, `export type *`): AccountInfo, RegisterRequest, LoginRequest, SetHandleRequest, AuthorRole, BrewAuthorInfo, BrewMeta, BrewMetaInput, BrewLockInfo, BrewForEdit, BrewForShare, BrewSummary, CreateBrewRequest, SaveBrewRequest, SaveBrewResponse, SaveConflict, DeleteBrewResponse, ThemeList, ThemeCatalogEntry, UserThemeInfo, ThemeBundle, ThemeBundleStyle, ThemeBundleSnippetRef, VaultPage, VaultSearchParams, VaultSort, VaultDir, UserBrewList, NotificationInfo, NotificationInput, AdminStats, AdminUserInfo, AdminBrewInfo, AdminLockInfo, LockedBrewInfo, LockRequest, ProblemDetails, ValidationProblemDetails, Schemas.
- Hook option types: `QueryOverrides<T>` (useQuery options minus key/fn/select, spread last) and `MutationOverrides<TData, TVars>` (callbacks run after the hook's own; meta is merged); `mergeMutationOptions(base, overrides)`.
- Account: `fetchMe()` → AccountInfo|null; `register(body)`; `login({ email, password, remember = true, twoFactorCode? })` (?useCookies=true, or ?useSessionCookies=true when remember is false); `loginFailure(e)` → 'invalid'|'lockedOut'|'notAllowed'|'requiresTwoFactor'|null; `logout()`; `setHandle(handle)` → AccountInfo. `accountQueries.me()`; hooks `useMe`, `useRegister`, `useLogin` (meta manual: its 401 belongs to the form; refetches me and user-dependent queries), `useLogout` (me = null, drops inactive brews/admin caches, refetches the rest), `useSetHandle` (sets me). Both refreshes leave loaded editor brews and loaded share views alone (every share fetch counts a view; the share page asks again itself when an author signs in). `changePassword({ oldPassword, newPassword })` (POST /api/auth/manage/info; 400 ValidationProblem keyed by Identity codes: PasswordMismatch, OldPasswordRequired, Password*), `useChangePassword(email)` (changes it, then signs in again with the new password (remember: true) so this session survives Identity's security-stamp check, up to 30 min later; a failed re-sign-in is ignored), type `ChangePasswordVariables`, `mutationKeys.changePassword`.
- Brews: `fetchBrewForEdit(editId)`, `fetchBrewForShare(shareId)`, `createBrew(body, { gzip? })`, `saveBrew(editId, body, { gzip?, keepalive? })`, `deleteBrew(editId)`, `cloneBrew(shareId)`, `requestLockReview(editId)`. `brewQueries.edit(id)` (staleTime Infinity, gcTime 0, no focus/reconnect refetch: a load-once source) and `.share(id)` (staleTime Infinity and gcTime 0: every fetch counts a view, so once per visit, and the next visit shows the brew as it is then). Hooks: `useBrewForEdit(id?)`, `useBrewForShare(id?)`, `useCreateBrew()` (seeds the edit cache with the returned, sanitized brew), `useSaveBrew(editId)` (variables `{ body: SaveBrewRequest, options?: { gzip?, keepalive? } }`; success patches the cached BrewForEdit: version, updatedAt, pageCount, authors, doc/style/snippets as sent, meta with the stored title), `useDeleteBrew()` (variables editId), `useCloneBrew()` (variables shareId), `useRequestLockReview()` (variables editId; patches lock). Types `BodyCallOptions`, `SaveCallOptions`, `SaveBrewVariables`.
- Themes: `fetchThemes()`, `fetchThemeBundle(theme)`, `themeQueries.{list,bundle}`, `useThemes()`, `useThemeBundle(theme?)` (staleTime 5 min).
- Lists: `searchVault(params)`, `fetchUserBrews(handle)`, `listQueries.{vault,userBrews}`, `useVaultSearch(params)` (keepPreviousData), `useUserBrews(handle?)`.
- Notifications: `fetchActiveNotifications()`, `notificationQueries.active()` (meta manual: silent on failure), `useActiveNotifications()`.
- Import: `fetchUpstreamBrew(shareId)` → text; `useUpstreamImport()` (mutation, variables shareId); `parseUpstreamShareId(input)` (a bare id or a …/share|download|source|print/<id> URL → id, else null); `UPSTREAM_SHARE_ID`.
- Admin: `fetchAdminStats`, `findAdminUsers(q)`, `fetchAdminBrew(id)`, `fetchAdminLocks`, `fetchAdminReviewQueue`, `lockBrew(shareId, LockRequest)`, `unlockBrew(shareId)`, `dismissLockReview(shareId)`, `fetchAdminNotifications`, `fetchAdminNotification(id)`, `createNotification(input)`, `updateNotification(id, input)`, `deleteNotification(id)`; `adminQueries.*`; hooks `useAdminStats`, `useAdminUsers(q)` (disabled while q is blank), `useAdminBrew(id?)` (meta manual, no retry: a 404 is a lookup result), `useAdminLocks`, `useAdminReviewQueue`, `useAdminNotifications`, `useAdminNotification(id?)`, `useAdminLockBrew` (variables { shareId, lock }), `useAdminUnlockBrew` and `useAdminDismissReview` (variables shareId), `useAdminCreateNotification`, `useAdminUpdateNotification` (variables { id, input }), `useAdminDeleteNotification` (variables id). Lock changes invalidate the admin brew lookups, locks, stats and that brew's share query.
- Test helpers (web/src/api/testing.ts; Vitest only, not in the barrel): `mockApi(handler)` → { requests, last(), restore() } (stubs the global fetch; a RecordedRequest has method, url, path, headers, credentials, body (gunzipped), rawBody, json); `jsonResponse`, `problemResponse(status, problem)`, `textResponse`, `emptyResponse`.

QUERY CLIENT (web/src/app/queryClient.ts): `createQueryClient({ notify? = toast, onSignIn? = requestSignIn, dismiss? = dismissToast })`. QueryCache and MutationCache onError run applyErrorPolicy (toast id `api:<queryHash>` or `api:mutation:<id>`; Retry refetches the query or re-executes the mutation); a 401 also sets `me` to null. onSuccess dismisses that request's error toast. Defaults: queries staleTime 30 s, no focus refetch, retry shouldRetryQuery with retryDelay; mutations never retry.

UI STORE (web/src/app/uiStore.ts): `uiStore` (zustand vanilla + persist, localStorage key 'hb-ui', version 1), `useUiStore(selector)` (selectors must return stable values; use zustand's useShallow for objects), `createUiStore({ storage?, name?, compactMedia? })` for tests (compactMedia: `{ matches, addEventListener?('change') }`, default `compactMediaQuery()` = matchMedia(COMPACT_MEDIA_QUERY '(max-width: 720px)'), null in jsdom). Compact screens: the side panels start closed and open one at a time, and the open/closed state stored is the wide-screen preference (what is opened on a phone is not stored); crossing the breakpoint closes them or brings the preference back. State: zoom (factor, 0.1–3), spread 'single'|'facing'|'flow', startOnRight, pageShadows, panels { outline, inspector, style: { open, size } }, inspectorTab (string, default 'node'). Actions: setZoom, zoomIn, zoomOut (ZOOM_LEVELS), setSpread, setStartOnRight, setPageShadows, setPanelOpen, togglePanel, setPanelSize (clamped to PANEL_LIMITS: outline 160–480, inspector 240–560, style 240–900), setInspectorTab, resetUi. Also DEFAULT_UI_STATE, MIN_ZOOM, MAX_ZOOM, ZOOM_LEVELS, SPREADS, PANEL_IDS, PANEL_LIMITS, UI_STORAGE_KEY, UI_STORAGE_VERSION, LEGACY_TOOLBAR_KEY, clampZoom, clampPanelSize, stepZoom, sanitizeUiState, fromLegacyToolbarState, safeLocalStorage. Every storage access is wrapped in try/catch (blocked storage, quota, corrupt JSON → defaults in memory); stored values are validated field by field; when 'hb-ui' is absent, upstream's HB_renderer_toolbarState (zoomLevel %, spread, startOnRight, pageShadows) is imported once. The EditorCanvas props zoom, spread, startOnRight and pageShadows take these values directly.

UI KIT (web/src/ui; import from '@/ui'; CSS modules only; tokens `--hbui-*` on the `.root` class of theme.module.css; light by default, dark via prefers-color-scheme or data-color-scheme):
- `UiRoot({ colorScheme?: 'system'|'light'|'dark', surface? = true, ...div })` carries the tokens (and the base font, text colour and background when surface). `UiColorSchemeContext`, `uiThemeStyles` (classes root, surface, layer, toastLayer).
- `Portal({ children, kind?: 'layer'|'toast', layerRef? })` renders into a new layer div inside one shared `[data-hb-portal-root]` at the end of <body>; the layer carries the tokens and the nearest UiRoot's scheme. All floating UI uses it, so nothing is confined by the canvas viewport's `contain: layout paint`.
- `Button({ variant?: 'primary'|'secondary'|'ghost'|'danger', size?: 'sm'|'md', icon?, iconEnd?, loading?, pressed?, fullWidth?, ...button })` (type=button; loading = aria-busy and clicks ignored, still focusable; pressed → aria-pressed; aria-disabled also blocks clicks). `IconButton({ icon, label, shortcut?, tooltip?: Placement|false = 'top', ...ButtonProps })` (label = aria-label and tooltip text; default variant ghost; pass aria-keyshortcuts yourself). `Icon({ name, size? = 16, label? })` (decorative unless labelled); `ICONS`, `ICON_NAMES`, `IconName`, `IconDef` in web/src/ui/iconPaths.ts: marks, paragraph, heading, heading1-3, bullet/ordered lists, quote, align ×4, pageBreak, columnBreak, columns, table, image, insert, plus, minus, braces, outline, undo, redo, zoomIn, zoomOut, zoomFit, spreadSingle/Facing/Flow, panelLeft/Right, eye, eyeOff, print, saved, saving, unsaved, saveError, trash, copy, download, settings, close, check, search, vault, user, lock, unlock, menu, more, dragHandle, info, warning, error, success, chevronUp/Down/Left/Right. `Spinner({ size?, label? = 'Loading', decorative? })`. `VisuallyHidden({ focusable?, ...span })`.
- `Tooltip({ content, shortcut?, children (one focusable element), placement? = 'top', delay? = 500, describe? = true, disabled? })`: shows on hover (not touch) or keyboard focus (:focus-visible); Escape hides it first; the pointer can move onto it; describe adds aria-describedby pointing to a hidden copy of the text.
- `Dialog({ open, onOpenChange, title, description?, children?, footer?, initialFocusRef?, returnFocusRef?, returnFocus? = true, closeOnEscape?, closeOnOverlayClick?, showCloseButton?, size?: 'sm'|'md'|'lg', role?: 'dialog'|'alertdialog', className?, data-testid? })`: role dialog, aria-modal, aria-labelledby/-describedby; initial focus = initialFocusRef → [data-autofocus] → first tabbable of the body → of the footer; Tab wraps; everything outside is `inert` except the toaster and layers opened from the dialog; page scroll is locked; focus returns on close. Unmounted while closed. `ConfirmDialog({ open, onOpenChange, title, message?, confirmLabel?, cancelLabel?, tone?: 'default'|'danger', onConfirm: () => void|Promise, onCancel?, children? })`: an alertdialog; Cancel is focused for danger; a returned promise keeps it open and busy, closes it on resolve, keeps it open on reject.
- `Popover({ open, onOpenChange(open, reason?), anchorRef, children, placement? = 'bottom-start', offset?, matchAnchorWidth?, role?, aria-label?, aria-labelledby?, id?, initialFocus?: 'first'|'panel'|'none'|ref, returnFocus?, trapFocus?, className?, data-testid? })`: non-modal; closes on Escape (focus back to the anchor), an outside press, or focus leaving; Tab past its end continues after the anchor, Shift+Tab at its start returns to the anchor. Flips and shifts to stay in the viewport.
- `Menu({ items: MenuEntry[], trigger: (props: MenuTriggerProps) => ReactElement, label?, placement?, open?, onOpenChange?, className?, data-testid? })` and `MenuButton({ label, items, icon?, iconOnly?, placement?, menuLabel?, open?, onOpenChange?, menuClassName?, ...ButtonProps })`. MenuEntry = MenuActionItem { id, label, icon?, shortcut?, disabled?, closeOnSelect?, onSelect } | MenuCheckboxItem { type: 'checkbox', checked, onCheckedChange } | MenuRadioItem { type: 'radio', checked, onSelect } | MenuSeparator { type: 'separator' } | MenuGroup { type: 'group', id, label, items }. Keyboard as in the APG menu button: ArrowDown/Enter/Space open on the first item, ArrowUp on the last; Up/Down wrap, Home/End jump, typeahead (repeat a letter to cycle), Enter/Space activate, Escape/Tab close and focus the trigger; disabled items are skipped.
- Toasts: `toast({ id?, title, description?, tone?: 'info'|'success'|'warning'|'error', action?: { label, onAction }, duration?: number|null })` → id (the same id replaces a toast and announces it again; default 5 s, errors 8 s, null (sticky) when there is an action; at most 5); `dismissToast(id)`, `clearToasts()`, `useToasts()`, `toastStore`. `<Toaster label? hotkey? = 'F8' />`: polite and assertive live regions that exist before any toast (errors are assertive), a named region above modals that is never made inert, timers paused while hovered or focused, F8 focuses it, and focus stays in a sensible place when a focused toast closes. It is mounted once in web/src/app/App.tsx (see the notes).
- `Tabs({ items: TabItem[] { id, label, content, disabled? }, value?, defaultValue?, onValueChange?, label, orientation?, activation?: 'automatic'|'manual', keepMounted?, className?, data-testid? })`.
- Fields: `TextField` and `TextArea` ({ label, hint?, error?, hideLabel?, className?, inputClassName?, ...input|textarea }): label, hint and error are wired through aria-describedby; error sets aria-invalid; required shows an aria-hidden asterisk. `Select({ label, options: SelectOption[] { value, label, disabled? }, placeholder?, hint?, error?, ... })` (native select). `Checkbox` and `Switch` ({ label, hint?, ...input }; Switch has role="switch").
- `Toolbar({ label, orientation?, ...div })` (role toolbar, one tab stop, Left/Right or Up/Down, Home/End; text inputs keep their arrow keys; disabled items are skipped; the tab stop survives items being added, removed or disabled), `ToolbarGroup({ label })`, `ToolbarSeparator({ orientation? })`.
- `SplitPanel({ direction?: 'row'|'column', ...div })`, `SplitMain(div)`, `Drawer({ side: 'left'|'right'|'bottom', open, onOpenChange?, title, size, onSizeChange?, minSize?, maxSize?, resizeLabel?, closeLabel?, actions?, children?, id?, returnFocusRef?, className?, data-testid? })` (an `aside` landmark named by its h2 title, with a close button, and a resize handle when onSizeChange is given), `ResizeHandle({ side, size, min, max, onSizeChange, controls, label, step? = 16 })` (role separator with aria-valuenow/min/max; arrows ±16 px, Shift ×4, Home/End; pointer drag with pointer capture). Under 720 px a left or right Drawer is a sheet over the main area (absolute, full height, at most the split's width, popover shadow) instead of taking its width.
- Helpers exported for other lanes' floating UI: `computePosition`, `useFloating(open, anchor (element or ref), floatingRef, { placement, offset, padding, matchAnchorWidth })`, `useDismiss(open, { floatingRef, anchorRef, onDismiss, escape, outsidePress, focusOut })`, `registerEscape(fn)` (the latest registration wins), `pushModalLayer(layer)`, `getPortalRoot()`, `getFocusables`, `getTabbables`, `focusElement`, `focusFirst`, `trapTab`, `createTypeahead`, `findTypeaheadMatch`, `isTypeaheadKey`, `rovingItems`, `syncRovingTabIndex`, `moveRovingFocus`; types Placement, DismissReason, PositionInput, PositionResult, FloatingOptions, DismissOptions.

DEV PAGE /dev/ui-kit (web/src/dev/ui-kit): every primitive, wired to the real uiStore (zoom, spread, panels, inspector tab, page shadows). Test ids: scheme-select, last-action, toolbar, block-type, zoom-menu, spread-menu, marks, zoom, spread, insert-menu, menu-wide, menu-align, open-dialog, dialog, dialog-notify, open-confirm, loading-button, tooltip-trigger, popover-trigger, popover, toast-info, toast-error, toast-short, tabs, drawer-outline, drawer-inspector, drawer-style, ui-state, skip-link, section-<id>; the Toaster adds toast-live-polite and toast-live-assertive.

E2E: web/e2e/ui-kit/ui-kit.spec.ts (port 5320), 15 tests in Chromium and Firefox: axe (light, forced dark, system dark, and with the menu, popover, tooltip, dialog, alertdialog and toasts open: no serious violations; no violations at all on the idle page), menu keyboard and pointer, dialog focus trap, focus return, inert background and nested Escape, toasts over a modal, ConfirmDialog, toast announcements, Retry and F8, toolbar roving focus, tabs, tooltip, popover placement (below and flipped) and Tab flow, drawers (keyboard and pointer resize, close → toggle, persistence), zoom persistence and corrupt storage. Stable over --repeat-each=3 with 6 workers.

### Notes for later phases
- App shell owner (web/src/app/App.tsx, AppShell.tsx): I added one line to App.tsx: `<Toaster />` after the RouterProvider (plus its import), so policy toasts show on every route (dev pages included; /dev/ui-kit has no Toaster of its own). It sits outside any UiRoot, so it follows the system colour scheme; if the shell wraps the app in `<UiRoot>`, move the Toaster inside it. Still to do by the shell/account lane: wrap the chrome in `<UiRoot>`, and subscribe to `onSignInRequired` to open the sign-in dialog (nothing listens yet, so today a 401 only clears `me`).
- Editor/autosave lane (P3.8): use `saveBrew` or `useSaveBrew(editId)` with `meta: { errorPolicy: 'manual' }` when the save status UI reports errors itself; a 409 has `error.serverVersion`; `options.keepalive` for pagehide saves only works under 64 KiB (use `gzip: 'always'` to shrink the body, or skip keepalive). Keep saves from overlapping (the hook does not queue them). Don't re-initialise the editor from `useBrewForEdit` data after the first load: saves patch the cache (version, the doc as sent, meta) and login refreshes skip a loaded edit brew, but the document belongs to the editor.
- Pages (P7): render `errorPageData(query.error)` for 403/404/410/423 page loads (the policy shows no toast for them); a 401 already raises the sign-in event. `useBrewForShare` keeps its first result (each fetch counts a view).
- Forms: 400s with field errors and 409s are not toasted; read `error.fieldError('meta.title')` or `error.errors`. For login's 401 use `loginFailure(error)`. Register with a taken email returns 200 (BS-5): a useLogin 401 right after useRegister may mean the account already existed.
- Toolbar and inspector lanes: IconButton needs a label; use `pressed` for toggles and pass `aria-keyshortcuts` ("Control+B") next to the display `shortcut` ("Ctrl+B"). Menus are data-driven (no submenus yet). Floating UI anchored in the canvas must go through Portal/useFloating, because the canvas viewport confines position: fixed.
- Tokens: use `var(--hbui-…)` in chrome CSS modules. A `surface` UiRoot sets font, text colour and background, which the canvas would inherit where themes don't set them: keep the canvas outside a surface UiRoot, or use `surface={false}` around it. UiRoot never sets `color-scheme`.
- jsdom has no `inert`, layout or pointer capture: the component tests cover logic, and e2e/ui-kit covers layout, inert and positioning. The portal root persists across Vitest tests (it is empty after each unmount); testing-library appends its containers after it, so user-event's Tab order there differs from the app's (write Tab-order tests with that in mind, or in Playwright).
- No packages were added. fflate compresses synchronously (tens of ms for multi-MB documents); if autosave of very large brews stutters, CompressionStream('gzip') is a dependency-free asynchronous alternative.


## Backend follow-ups: manifest constraints, shared URL policy, hardening (phase 3, RV-14, RV-15, plan §8/P8)

### Interfaces
Manifest constraints (RV-15; src/Homebrewery.Core/Documents/SchemaManifest.cs, DocInspector.cs):
- SchemaManifest reads the optional attribute fields `enum`, `integer`, `min` and `max` (web/src/editor/schema/manifest.ts `AttributeConstraints`). A malformed one fails the manifest load with an InvalidDataException naming the path: enum that is not a non-empty array of strings/numbers/booleans/null, integer that is not a boolean, min/max that are not finite numbers, min > max. MANIFEST_VERSION stays 1.
- AttrSpec gains `Enum` (IReadOnlyList<JsonNode?>?; JSON null is a C# null; numbers are stored as doubles), `Integer`, `Min`, `Max` (double?), `HasConstraints` and `Violation(JsonNode?)`, which returns null or the reason ('must be one of 1, 2, null', 'must be a whole number', 'must be at least 1', 'must be at most N'). Numbers compare by value (2.0 is 2), strings ordinally (case-sensitive: 'Left' is not 'left'). The enum applies to null too; integer/min/max apply only to numbers.
- DocInspector drops a value that breaks them (after its kind checks, on the stored form) with the warning '<path>: <reason>', e.g. 'doc.content[0].attrs.columns: must be one of 1, 2, null'. The save still succeeds, as for wrong-typed values; the client falls back to the attribute default. Constrained today: page.kind/columns, paragraph.align, heading.level, toc.depth, tableCell/tableHeader align/colspan/rowspan, orderedList.start, image.width/height.

Shared URL policy (RV-14):
- shared/url-policy-cases.json: { maxLength, cases: [{ url | parts: [{ text, repeat? }], href, src, why, clientGap? }] }, 66 cases. `href` = allowed as link.href; `src` = allowed as image.src and page object src. `parts` builds long URLs. `clientGap` marks a case the client still gets wrong.
- Server: tests/Homebrewery.Api.Tests/Documents/UrlPolicyTests.cs runs every case against UrlPolicy.IsSafeHref/IsSafeSrc and through DocInspector (link mark, image, page object). Every case must pass on the server, clientGap ones included.
- Client: web/src/editor/schema/urlPolicy.shared.test.ts runs every case against html.ts isSafeHref/isSafeSrc (isSafeUrl is deprecated and not covered). clientGap cases run with it.fails: they stay green while the client disagrees and turn red once html.ts is fixed; then delete the clientGap field from the case.
- UrlPolicy (server) changes: the characters skipped while reading a scheme are now exactly the client's IGNORED_URL_CHARS (C0 controls, DEL and JavaScript's \s). U+FEFF is now ignored (before, it was kept, so U+FEFF followed by 'javascript:' passed as a relative URL). U+0085 is no longer ignored (before, 'java' + U+0085 + 'script:' was refused, while the client and browsers treat it as relative). Schemes of any length are read (before, only 64 significant characters, so a 100-letter scheme passed as relative). data:image/ matching is ASCII-only. New public `UrlPolicy.IsIgnored(char)`; SchemeOf, IsSafeHref and IsSafeSrc keep their signatures.

Hardening (plan §8, P8.4):
- Data Protection: `builder.Services.AddPersistentDataProtection()` (Homebrewery.Api.Infrastructure.DataProtectionSetup). Config `DataProtection:KeysPath` (relative paths resolve against the content root) puts the key ring in that directory (FileSystemXmlRepository). When it is set, startup protects and unprotects a value and fails with 'Data Protection keys cannot be created or read in …' if the directory is unusable. Unset: ASP.NET Core's default location (the dev container's /root/.aspnet, already the aspnet-keys volume). The application name is fixed to 'Homebrewery' (DataProtectionSetup.ApplicationName), so keys don't depend on the install path; this signs out existing dev sessions once. Also KeysPathKey and KeysDirectory(config, env).
- Dockerfile runtime stage: ENV DataProtection__KeysPath=/var/lib/homebrewery/keys; the directory is created owned by $APP_UID with mode 700, so a new named volume mounted there starts out writable (checked with a throwaway build on the aspnet:10.0 base image).
- Cookies: `builder.Services.AddAuthCookieSecurity()` (Homebrewery.Api.Infrastructure.Identity.AuthCookies and AuthCookieSettings). Config `Auth:CookieSecurePolicy` = SameAsRequest (default) | Always, applied to every cookie scheme (application, external, two-factor). SameAsRequest marks the cookie Secure whenever the request is HTTPS after forwarded headers, i.e. behind Caddy with X-Forwarded-Proto: https when ASPNETCORE_FORWARDEDHEADERS_ENABLED=true. Always marks it Secure even over http. None or an unknown value stops the host (ValidateOnStart). HttpOnly and SameSite=Lax are unchanged.
- Npgsql: `HomebreweryConnectionStrings.WithDefaults(cs)` (Homebrewery.Data) adds Gss Encryption Mode=Disable unless the string sets a GSS encryption mode itself ('Gss Encryption Mode', 'GssEncryptionMode' or 'GssEncMode', any case or spacing). Null, blank and unparsable strings pass through unchanged. UseHomebreweryNpgsql applies it, so every AppDbContext (host, tests, tools) gets it. This silences 'Cannot load library libgssapi_krb5.so.2' without installing libgssapi in the image.
- /healthz: `AddAppHealthChecks()` / `MapAppHealthChecks()` (Homebrewery.Api.Infrastructure.HealthEndpoints; Path '/healthz'). DatabaseHealthCheck (Name 'database', Timeout 5 s, tag 'ready') runs SELECT 1 on AppDbContext. Response: 200 {"status":"ok","checks":{"database":"ok"}}; any failing check gives 503 with "unhealthy" statuses. No exception text or descriptions are returned. `checks` is new (before, the body had only status).

New endpoint (a gap from §9 and upstream admin parity):
- GET /api/admin/users/{handle}/brews (AdminListUserBrews, tag Admin): 200 UserBrewList with own=true: every brew of that account in any role (unpublished, locked, invitations last), with edit ids and roles, exactly what the account sees on its own /api/users/{handle}/brews. 404 problem 'User not found'; 401/403 like the other admin routes. Upstream's admin author lookup (/admin/user/list/:author) listed these. BrewListService.UserBrewsAsync gained an optional `asOwner` parameter. shared/openapi.json and web/src/api/schema.d.ts are regenerated (additive: one path, one operation). There is no client hook yet; the admin lane would add e.g. `adminQueries.userBrews(handle)` in web/src/api/admin.ts.

Tests (xUnit): Documents/AttributeConstraintTests.cs (every constrained attribute of the real manifest: all allowed values kept, generated violations dropped with the exact warning; a constrained attribute on a node type the test cannot place fails with 'add it'), Documents/UrlPolicyTests.cs, Brews/BrewAttributeConstraintTests.cs (end-to-end save), Security/AuthCookieTests.cs, Security/DataProtectionTests.cs, HealthzTests.cs, ConnectionStringTests.cs, and a new case in Admin/AdminApiTests.cs. DocInspectorTests.Numbers_are_written_canonically now uses orderedList.start for the tiny-number case, because toc.depth 0 is dropped by its enum.

### Notes for later phases
- Web (schema owner), RV-14 client gaps, all in web/src/editor/schema/html.ts (the three clientGap cases in shared/url-policy-cases.json):
  1. urlScheme() does `url.slice(0, 256)` before removing IGNORED_URL_CHARS. With 256 or more leading spaces or controls before 'javascript:alert(1)', the scheme reads as null, so isSafeHref and isSafeSrc return true. Browsers strip leading C0 controls and spaces of any length and would run it; the server refuses the save. Fix: remove ignored characters first (or skip them while scanning), and don't cut before that.
  2. The same cut makes a scheme longer than 256 characters read as relative (client true/true, server false/false). Not dangerous, but a disagreement.
  3. isSafeSrc() tests /^data:image\//i on `url.slice(0, 64)` before removing ignored characters, so 'data:' + 70 spaces + 'image/png…' is refused by the client but stored by the server. The client is stricter here.
  After the fix, delete the `clientGap` fields: their it.fails tests turn red until then.
- Web (schema owner): the client could apply the same enum/integer/min/max when it reads stored JSON. The server now drops such values, and the client never writes them.
- compose (docker-compose.yml / compose.prod.yml owner): add a named volume for the production image's key ring, e.g. in compose.prod.yml under `app:` → `volumes: ["app-keys:/var/lib/homebrewery/keys"]`, plus top-level `volumes: { app-keys: {} }`. Without it the keys live in the container layer: they survive restarts but not re-creation (`up --build`), which signs everyone out. The dev `api` service needs nothing (its default location /root/.aspnet is the aspnet-keys volume). Keys are unencrypted at rest on Linux (ASP.NET Core logs a warning); treat the volume like the database. Microsoft.AspNetCore.DataProtection.EntityFrameworkCore (keys in PostgreSQL, no volume) is in the local NuGet cache but not a dependency; adding it is a lead decision.
- Deploy behind TLS: keep ASPNETCORE_FORWARDEDHEADERS_ENABLED=true (compose already sets it) so cookies get Secure. If the proxy cannot send X-Forwarded-Proto, set Auth__CookieSecurePolicy=Always; plain-http access other than localhost then loses sign-in.
- The compose healthchecks (dev api: curl /healthz; prod app: the bash /dev/tcp status line) now also fail when the database does not answer SELECT 1 within 5 s.
- Gaps between the §9 pages and the API, not implemented (no endpoints invented):
  - Email flows: /api/auth/forgotPassword, resetPassword, confirmEmail, resendConfirmationEmail and changing the email through /api/auth/manage/info need an IEmailSender. None is registered, so those mails are dropped. /account can change the password (POST /api/auth/manage/info with oldPassword and newPassword) but cannot reset it or change the email. This needs an SMTP (or similar) sender and its config, which is also what BS-5 needs for a uniform 'check your email' answer to register.
  - Handle lookup for the metadata dialog's author and invite field (P3.7): there is no light 'does handle X exist' endpoint. Today an unknown handle shows up only as a 400 errors['meta.authors'] on save (autosave stops until it is fixed), or as a 404 from GET /api/users/{handle}/brews, which loads up to 1000 summaries. If P3.7 wants inline validation, add GET /api/users/{handle} → {handle} | 404 (handles are already public).
  - Account page parity: upstream shows 'last login', which Identity does not record (drop it, or add a column). The brew count is UserBrewList.total from /api/users/{handle}/brews.
  - Import (P6.1): upstream share ids of 7-9 characters (older brews) and Google Drive ids are refused with 400 by the plan's ^[\w-]{10,14}$ rule; the import page should explain that. Widening the rule is a plan decision.
  - Admin (P7.4): there are no endpoints to delete a brew, change its owner, or lock and unlock an account (AdminUserInfo shows lockoutEnd). Upstream's cleanup tools (junk and lost Google brews, script cleaning) have no equivalent and are not needed, because DocInspector sanitizes on save.
  - P8.3: CSP and other security headers are still to do.
- Process: I built and tested with --artifacts-path C:/Users/ranky/AppData/Local/Temp/hb-artifacts-backend while iterating, then ran the final in-tree `dotnet test --solution Homebrewery.slnx` once. Outside src/, tests/ and Dockerfile I changed only files I own (shared/url-policy-cases.json, web/src/editor/schema/urlPolicy.shared.test.ts, the regenerated shared/openapi.json and web/src/api/schema.d.ts) and this section. No packages were added and no git commands were run.


## Autosave, conflict dialog, IndexedDB drafts, local snapshots (P3.8, plan §9)

### Interfaces
Import from '@/editor/save' (web/src/editor/save/index.ts). Test helpers: web/src/editor/save/testing.ts (Vitest only).

HOOK: `useAutosave(options): UseAutosaveResult`
- Options (UseAutosaveOptions):
  - `editor: Editor | null`.
  - `editId: string | null`. null = a new brew: the first save POSTs.
  - `baseVersion: number | null` (BrewForEdit.version).
  - `getStyle(): string`, `getSnippets(): unknown`, `getMeta(): BrewMetaInput | null`. Called at save time. Write them as closures over the current render's state; the hook refreshes them in a layout effect on every render. getMeta must send `authors` only when the owner edited the list (a changed list from a non-owner is a 403).
  - `watch?: unknown[]`: the values behind the getters, like effect dependencies. When one changes, style, snippets and meta are compared with what was last saved or loaded, and a difference counts as a change. Alternatively call `markDirty()`.
  - `baseline?: BrewBaseline | null` ({ doc, style?, snippets?, meta? }; BrewForEdit fits): enables the "Restore unsaved changes" offer.
  - `lastSavedAt?` (BrewForEdit.updatedAt).
  - `userKey?` (e.g. me?.id): when it changes, a save that failed with 401 is retried. While it is null, the page being shown again (visibilitychange → visible) does not retry a 'signedOut' save (APP-9); 'offline' still retries.
  - `signedOut?` (review fix APP-9): true when the page knows nobody is signed in (EditorApp: `me.isSuccess && me.data === null`). A new brew (no editId) is then not sent at all (no 401 POST): status 'signedOut', the changes stay in the 'new' draft, saveNow/flush/retry send nothing, and the brew is created (run 'retry') as soon as it turns false. An existing brew still saves (its 401 is how autosave learns the session ended).
  - `shortcut?` = true: Mod-S on window. It is skipped when the event was already defaultPrevented, so an editor keymap that handles Mod-S wins.
  - `warnOnUnload?` = true: beforeunload asks while `controller.shouldWarnOnUnload('page')` (conflict, offline, error, lost, a 401; a save in flight for STALLED_SAVE_MS). A new brew waiting for a sign-in doesn't ask once its draft is stored (it asks when drafts only live in memory). In-app navigation: `<LeaveGuard>`.
  - `enabled?` = true. Set false for read-only views: nothing is saved and no drafts are written.
  - `requestTimeoutMs?` = SAVE_TIMEOUT_MS (60 s): a save or create without an answer is aborted (AbortSignal passed to the API call) and counts as offline, with retries (SAVE-9).
  - `api?: Partial<AutosaveApi>` ({ saveBrew, createBrew, fetchBrewForEdit }; default: the '@/api' calls).
  - `drafts?` / `snapshots?`: default the shared IndexedDB stores; null turns them off.
  - `delayMs?` = 3000, `draftThrottleMs?` = 1000, `settleTimeoutMs?` = 10000, `retryDelaysMs?` = [2 s, 5 s, 15 s, 30 s, 60 s].
  - `isSettled?`: default pagination's isSettled.
  - `onCreated(brew, 'new' | 'copy')`: navigate to /edit/:editId.
  - `onSaved(response, request)`.
  - `onServerBrew(brew)`: "Load the saved version" loaded this brew; apply its style, snippets and meta.
  - `onRestore(content, 'draft' | 'snapshot')`: apply the restored style, snippets and meta; the document is already applied.
  - `logger?`.
- Result fields (AutosaveState plus actions):
  - `status: 'saved'|'dirty'|'saving'|'offline'|'conflict'|'error'|'signedOut'|'lost'`. 'lost' (SAVE-4): a save of an existing brew answered 403, 404 or 410 (removed as an author, deleted). No retries (retry() and the online/visible events skip it; saveNow still tries); only a copy keeps the work on the server.
  - `editId`, `baseVersion`: the ones autosave tracks (a create changes them).
  - `unsaved`, `lastSavedAt` (epoch ms).
  - `conflict: { serverVersion, busy: 'load'|'overwrite'|'copy'|null, actionError } | null`, `conflictOpen`.
  - `error`: the failure behind offline/signedOut/error/lost.
  - `retryAt`, `draftOffer: DraftOffer | null` (a stored Draft plus `kind: 'restore'|'conflict'`; one at a time, newest first, answering one shows the next), `draftsPersistent` (false when the draft store fell back to memory, SAVE-11), `lastTrigger`, `saveCount`, `externalEpoch`, `editor`, `controller`.
  - Actions: `saveNow(): Promise<SaveOutcome>` ('saved'|'unchanged'|'queued'|'conflict'|'failed'|'disabled'), `markDirty()`, `flush('hidden'|'unmount')`, `retry()`, `openConflict()`, `closeConflict()`, `loadSavedVersion()`, `overwriteWithMine()`, `saveAsCopy()` (in a conflict, or when 'lost': "Save as a new brew"; the status is 'saving' meanwhile and a failure keeps 'lost' with the reason), `restoreDraft()` (a 'conflict' offer goes into the editor as one undo step and opens the conflict dialog with serverVersion = the loaded version, so nothing is saved over the newer version until the author picks Load / Overwrite / Copy), `discardDraft()`, `listSnapshots()`, `restoreSnapshot(s)`.
  - `controller.shouldWarnOnUnload(scope: 'page'|'app' = 'page')` (LeaveScope): see warnOnUnload. For 'app', a draft kept only in memory still counts as kept (the page stays).
- The hook also listens for visibilitychange → hidden and pagehide (flush with keepalive), unmount (flush), online (retry), and visibility → visible (retry when offline, or signed out with a userKey). With a QueryClientProvider it patches the cached BrewForEdit after a save and seeds the edit query after a create (cache.ts: patchSavedBrew, seedCreatedBrew), as useSaveBrew and useCreateBrew do; both also invalidate `queryKeys.themes.all` when the brew is or becomes a user theme (tag `meta:theme`, THEME_TAG) and its tags or title changed, or a created brew is tagged so (APP-13). It works without a provider.
- After a request, changes typed while autosave waited (a retry after offline or 401, an overwrite in a conflict) get their debounced save once it succeeded (SAVE-3). A failure (400, 413, …) still waits for the next change.

COMPONENTS (CSS module save.module.css, UI kit only):
- `<SaveStatus autosave onSignIn? className? />` (data-testid save-status, save-status-label, save-status-live; data-status, data-tone). It shows an icon and a label. The action button depends on the status: Save (dirty), Retry (offline, error), "Sign in to save" (signedOut; default requestSignIn()), Resolve… (conflict), "Save as a new brew" (lost; saveAsCopy). A polite live region announces problems and manual (Mod-S) saves, not every autosave.
- `<ConflictDialog autosave />`: an alertdialog, data-testid conflict-dialog. It has three buttons, each with an aria-describedby hint: conflict-load, conflict-overwrite (danger), conflict-copy (primary, focused first). A failed action shows conflict-error (role alert). Escape or the close button leaves the conflict open, and Resolve… reopens it.
- `<DraftRestoreBanner autosave className? />`: a region "Unsaved changes found" (data-testid draft-offer, data-kind restore|conflict) with the buttons draft-restore ("Restore unsaved changes"; for a conflict "Restore unsaved changes…", aria-haspopup dialog, and a message saying the brew was saved again since) and draft-discard. Its live region is always mounted. Both actions move focus to the editor (a conflict restore: to its dialog). While `draftsPersistent` is false it also shows a lasting region "Unsaved changes can’t be kept on this device" (data-testid drafts-not-kept).
- `<LeaveGuard autosave />` (review fix SAVE-2): asks before an in-app navigation to another path while `shouldWarnOnUnload('app')` holds (react-router useBlocker; needs a data router, renders nothing under a plain MemoryRouter or no router). An alertdialog "Leave without saving?" (data-testid leave-guard) with a reason per status, "Stay" (leave-stay, focused first; blocker.reset), "Leave anyway" (leave-anyway, danger; blocker.proceed: the draft stays and is offered next time) and, in a conflict or when lost, "Save mine as a copy" (leave-copy: saveAsCopy, then the navigation goes on).
- `<LocalHistoryDialog open onOpenChange autosave />`: the snapshots, newest first. Restore is one undo step and closes the dialog, then a success toast offers Undo.

CONTROLLER (framework-free, autosave.ts):
- `createAutosave(options: AutosaveOptions): AutosaveController`, with getState/subscribe (for useSyncExternalStore), update, attach(editor), setSession(editId, baseVersion), start/stop and the actions above.
- `setSession` with the editId it already tracks is ignored, so the /new → /edit/:editId navigation keeps the version bookkeeping. The one exception: a baseVersion that arrives while the tracked one is still null and nothing has been saved is taken, since a page may mount the hook before the brew loads. update() does the same before the draft check. Another editId flushes the old brew with keepalive and starts over.
- Constants: AUTOSAVE_DELAY_MS, DRAFT_THROTTLE_MS, SETTLE_TIMEOUT_MS, SAVE_NOW_SETTLE_MS (1 s), RETRY_DELAYS_MS, KEEPALIVE_MAX_BYTES (60 KiB), SAVE_TIMEOUT_MS (60 s), STALLED_SAVE_MS (10 s). Types: AutosaveStatus, LeaveScope, SaveTrigger, SaveOutcome, AutosaveConflict, AutosaveState, AutosaveApi (saveBrew/createBrew options take `signal`), defaultAutosaveApi, findFirstHeading(doc).

DIRTY RULES (dirty.ts):
- `isDirtyTransaction(tr)`: docChanged, and none of the metas PAGINATE, LAYOUT_NEUTRAL_META or `SERVER_DOC_META = 'hbServerDoc'`.
- `isDirtyDispatch(tr, appended)`: appended transactions follow their root. The FRAGMENT_ATTRS sync appended to an author's edit is dirty; anything appended to pagination or a server sync is not.
- Undo and redo are dirty.

DOCUMENT REPLACEMENT (applyDoc.ts):
- `replaceDocument(editorOrView, json, { undoable, dirty })`. It replaces only the range that differs (findDiffStart/findDiffEnd, then whole pages, then everything, each checked with doc.eq), so the caret and the undo history outside that range survive.
- undoable → closeHistory, one undo step. Otherwise addToHistory false.
- dirty false → SERVER_DOC_META.
- Returns false when the documents are equal. Throws when the JSON doesn't fit the schema.
- Also exported: `replaceDocTransaction(state, node)` and `docFromJson(state, json)`.

DRAFTS (drafts.ts):
- IndexedDB database 'hb-drafts', store 'drafts'. Keys (review fix SAVE-10): a new brew's draft is 'new' (NEW_DRAFT_KEY; /new reads it directly); an existing brew's drafts are per controller session, `${editId}:${session}` (`draftKey(editId, session?)`; drafts stored before this change are keyed by the bare editId and still read). A session writes and deletes only its own key, so one tab's save never deletes another tab's draft, and a new session never writes over a draft it has not offered yet.
- Draft = { v: 1, key, editId, baseVersion, pendingVersion?, pending?, conflict?, doc, style, snippets, meta, docSchemaVersion, updatedAt }. `pendingVersion` (base + 1) and `pending` (the BrewContent that save sent) are written only while a save's outcome is unknown (in flight; a network error or timeout). An HTTP answer (409, 4xx, 5xx) clears them before the draft is written (SAVE-1). `conflict: true` = written while the brew was in conflict.
- `readDraft(store, key)`, `readDraftsFor(store, editId | null)` (every draft of a brew, newest first, by the stored editId; null → the 'new' draft), `isDraft` (storage is validated field by field), `draftDiffers(draft, baseline, schema?)`. Documents are compared through the schema, so jsonb key order and default attributes don't matter. Meta fields that are null are skipped, '' counts as null, and authors are ignored.
- `draftOfferKind(draft, baseVersion, baseline, schema?)` → 'restore' | 'conflict' | null (SAVE-1, SAVE-2): null when nothing differs; 'restore' when made on the loaded version, or when pendingVersion equals it AND the server holds exactly `pending` (draftDiffers false); everything else (conflict flag, another version, an unverifiable pendingVersion) is 'conflict'. Nothing that differs is dropped any more. `shouldOfferDraft` = kind 'restore'. On start autosave offers every differing draft of the brew and deletes the brew's drafts that hold nothing new ('new' excepted).
- `createDraftStore()`: `fallbackStore(idbStore(...))` where IndexedDB exists (SAVE-11: memory for the page's life when IndexedDB fails; `persistent()` then false), plain memory where it doesn't (jsdom; no notice). `defaultDraftStore()` (shared, so the memory fallback survives in-app navigation). DraftStore = KeyValueStore<Draft> & { persistent?() }. Snapshots use the same fallback.

SNAPSHOTS (snapshots.ts; port of versionHistory.js):
- IndexedDB database 'hb-snapshots', store 'snapshots', key `${editId}:${slot}` (snapshotKey).
- `createSnapshotHistory(store, now?)` → { load, list, update(input, { force }), collectGarbage }.
- SNAPSHOT_SLOTS 5, SNAPSHOT_SLOT_MINUTES [0, 2, 10, 60, 720, 2880], SNAPSHOT_MAX_AGE_MINUTES 28 days.
- `defaultSnapshotHistory()`.

KEY-VALUE STORE (kvStore.ts; port of customIDBStore.js): `KeyValueStore<T>`, `idbStore(db, store)` (idb-keyval, one database per store), `memoryStore(initial?)` (structured clones), `hasIndexedDb()`, `fallbackStore(primary, fallback = memoryStore())` → FallbackStore (`persistent()`): the first operation probes the primary with a read; if that throws (also synchronously), every operation uses the fallback; a later failed write switches too and keeps its value, and reads then merge the fallback with what the primary still has.

Other exports: `jsonEqual` (key-order-insensitive), `saveStatusInfo(state)` → { label, description, icon, tone }, `formatSavedAt`, `formatRelative`, `isSaveShortcut(event)`.

DEV PAGE /dev/save[?edit=<editId>] (web/src/dev/save; needs the API):
- A brew, or a new brew, in EditorCanvas with pagination (createCanvasGate). Around it: SaveStatus, "Local history", a Title field (meta), a Brew CSS textarea (style), the draft banner and the conflict dialog.
- "Create a test account" registers and signs in a random user.
- Frame data-testid dev-save with data-theme-status, data-status, data-edit-id, data-base-version, data-unsaved. It mounts LeaveGuard and passes `signedOut` like EditorApp.
- `window.__hbSave = { editor, state(), draft(key) (the newest draft of a brew, or 'new'), drafts(editId), snapshots(editId), saveNow(), idbRoundTrip() (every idbStore call once on database 'hb-e2e-kv') }` (devGlobals.ts).
- The loaded brew is fixed for the page's life. A create replaces the URL's ?edit= and keeps the editor.

E2E (port 5325):
- web/e2e/save/autosave.spec.ts (10 tests) runs anywhere. It uses an in-memory brew server routed per context (fakeServer.ts: 409 with serverVersion, gzip bodies, 401, network failures; also /api/themes and /api/notifications/active for the app pages), shared by two tabs.
- web/e2e/save/recovery.spec.ts (4 tests, runs anywhere, on the app's /edit and /new over fakeServer): a save that 409s after the editor is gone comes back as a conflict offer (SAVE-1); leaving a conflict through the navbar asks (Stay / Leave anyway) and the changes come back as a conflict, then Save mine as a copy (SAVE-2); IndexedDB blocked (init script: IDBFactory.open throws) keeps /new in memory across "Create an account" → Back with the notice, and nothing is POSTed (SAVE-11, APP-9); idbStore round trip (the carry-over: idbStore is covered in both real browsers).
- web/e2e/save/autosave-api.spec.ts (7 tests) runs against a real API and is skipped unless HB_API_URL points at a private one (not :5080/:8080).
- `node e2e/save/run-with-api.mjs [playwright args]` (from web/) starts src/Homebrewery.Api on :5425 with its own database hb_e2e_autosave (migrated on start; --artifacts-path in the temp directory), then runs `playwright test e2e/save` with HB_API_URL and E2E_PORT=5325, then stops the API. SAVE_API_PORT, E2E_PORT and HB_ARTIFACTS override.
- Helpers (e2e/save/helpers.ts): openSavePage, typeAt, editorTexts, waitForDraft (any draft of the brew), idbDrafts(page, editId) (reads IndexedDB directly on any page), killTab, seriousViolations, conflictDialog, statusLabel, docOf. recovery.spec.ts reuses the flows helpers (openEditorPage, waitForEditor, typeAt, editorTexts).

### Notes for later phases
- Shell / edit page (P7): wire it like SaveDevEditor.tsx.
  - Keep the same editor mounted from /new to /edit/:editId: pass the new editId, and the hook keeps its bookkeeping. Remounting would reload the document from the cache seeded at POST time and could 409 against the flush of the old instance.
  - Don't re-create the editor from `content` (EditorCanvas re-creates it when `extensions` changes identity). Autosave keeps its rev count, so a re-created editor holding the loaded document would be saved over the author's work.
  - Show SaveStatus in the toolbar, ConflictDialog once per page, and DraftRestoreBanner above the canvas.
  - Subscribe to onSignInRequired for "Sign in to save", and pass userKey = me?.id.
- /new (P7.2): baseline = the blank document, so a stored 'new' draft is offered. The page could load it directly instead (readDraft(defaultDraftStore(), 'new')). An anonymous user's saves get 401: the draft stays in IndexedDB, and after signing in, saveNow or a userKey change POSTs it.
- Toolbar lane (P3.4): Mod-S already saves (window listener, skipped when defaultPrevented). If the editor keymap binds Mod-S, call autosave.saveNow() there and return true. For the save status, use `<SaveStatus autosave={…} />`, or build your own with saveStatusInfo(state).
- Metadata lane (P3.7): getMeta should return the edited BrewMetaInput. Pass the meta state in `watch` so edits are saved. Include authors only when the owner changed them.
- Deviation, the server's sanitized document: a save response has no document, so after a PUT the local document is kept, with no replacement and the history intact. The server re-serializes rawHtml and drops invalid attributes, and the next load shows its version. After a create or copy, the returned document is applied outside the history (replaceDocument, SERVER_DOC_META). This happens only when it differs from what was sent and no change came in during the request.
- Deviation, drafts: `pendingVersion` (baseVersion + 1, with `pending` = what the save sent) also lets a draft be offered as a plain restore when the server has the version its in-flight save produced and that version holds exactly what was sent. A tab closed mid-save therefore keeps the changes typed after that save started; another client's version with the same number is a conflict offer (SAVE-1). Per-session keys (SAVE-10): an offered draft stays stored until the author answers it (Restore writes it into the session's own draft first, then deletes it; Discard deletes it). An offer the author ignores is offered again on the next visit (as a conflict once the brew moved on). The plan's single key per brew (drafts/{editId}) is now per session.
- Review fixes, integration (other lanes' files, minimal): EditorApp.tsx passes `signedOut: me.isSuccess && me.data === null` to useAutosave and renders `<LeaveGuard autosave />` next to ConflictDialog (saving 'server' + edit). web/e2e/flows/helpers.ts waitForDraft reads every draft (getAll) and matches the key or the stored editId, since edit drafts are keyed per session. The App pages section's "/new for anonymous visitors: … one 401 POST … beforeunload asks" no longer holds: nothing is POSTed and leaving asks nothing once the draft is stored.
- Not done (SAVE-8, needs the backend): a /new POST whose response was lost (network error, 502/503/504 after the commit, timeout) is retried as a second POST and can create a duplicate brew. The fix needs an idempotency key the server enforces: e.g. CreateBrewRequest.clientId (a UUID per new-brew session, kept in the 'new' draft) stored with a unique index on (owner, clientId), CreateAsync returning the existing brew on replay; then autosave sends it. The same lost-response problem makes a retried PUT get a 409 against its own applied save (now shown as a conflict, never a silent overwrite).
- Not done (SAVE-4 follow-up): the draft of a 'lost' brew is keyed by an editId the author can no longer open, so a draft left there (the author left without "Save as a new brew") is never offered again; LeaveGuard and beforeunload ask first. A list of local drafts (or offering them on /new) would make them reachable.
- api/brews.ts useSaveBrew (foundation lane, used only by /dev/panels) does not invalidate the theme list; the app saves through autosave (cache.ts), which does.
- Deviation, snapshots: taken after each successful save (upstream took them before sending), keyed by editId instead of shareId. "Load the saved version" first stores the author's version with force (it drops slot 5 when no slot has expired). Garbage collection runs once per controller, after the first snapshot.
- Deviation, settle: a save waits at most settleTimeoutMs (10 s) for pagination, then goes ahead unsettled rather than never saving. saveNow waits at most 1 s. flush (hidden, unmount) doesn't wait.
- "Load the saved version" is an undoable step: Undo brings the author's version back, and it then saves over the server version as a normal change.
- Keepalive: the hidden and unmount saves always gzip, and use keepalive only when the compressed body is at most 60 KiB. Otherwise they are plain fetches, which may die with the page; the draft covers that. A new brew's POST is never keepalive.
- Firefox: IndexedDB writes during test teardown can log "[autosave] recording a local snapshot failed UnknownError". Snapshots and drafts are best effort, and failures are logged but never thrown.
- E2E environment: a Chromium keepalive request sent from pagehide bypasses Playwright's routes and context.setOffline. killTab() cuts window.fetch in the page before closing it. CDP Page.crash wedged the context.
- Keepalive in Firefox: on page.close(), Firefox (Playwright build 1543) fires pagehide and visibilitychange, and autosave calls fetch(PUT, keepalive: true); I checked this by instrumenting fetch. The request never reaches the API, while Chromium's does, so 'closing the tab right after typing saves at once' is skipped in Firefox. I couldn't tell whether a real Firefox behaves the same. If it does, a closed tab's last changes live only in the draft until the brew is opened again (where they are offered). navigator.sendBeacon is no alternative: it can only POST, with no Content-Encoding.
- web/src/dev/registry.test.tsx (not mine): its findByRole uses the 1 s default. Under heavy load, the lazy /dev chunk (every dev page, this one included) once took longer and the test failed; it passes alone. Consider a longer timeout there.
- Vitest: one run of useAutosave.test.tsx failed 14 of 15 tests right after an edit and passed on every rerun (82/82 twice for the whole folder). It is probably a transform picked up during another lane's concurrent edit of a shared module; watch for it.
- E2E, two tabs: call bringToFront() on the tab before typing in it. In Firefox a background tab's timers and animation frames are throttled, and tab A's autosave stayed "dirty" for over 20 s. In real use the tab being typed in is in front, and hiding a tab flushes its changes at once.
- E2E environment: the shared working tree has other agents editing modules mid-run, and Vite HMR can remount the dev page's editor from its initial content. That was the only unexplained failure seen once (Firefox, overwrite test); repeated runs pass. Run Firefox with --workers ≤ 3 on a loaded machine; the two-tab tests take 1–3 minutes each there.
- No packages were added. fake-indexeddb would let Vitest cover idbStore itself; it is covered in e2e (recovery.spec.ts "idbStore: every call round-trips", both browsers, plus every draft and snapshot flow), and the unit tests use memoryStore and fallbackStore over failing stores (kvStore.test.ts).
- Vitest route-level tests of autosave on the real pages: web/src/editor/save/appRoutes.test.tsx (over pages/routeTesting.tsx; real timers). It imports the lazy route modules in beforeAll: under a full parallel run their first import took over 30 s.


## App shell, navbar, auth pages, error pages, notices (phase 3, P7.3 parts, plan §9)

### Interfaces
ROUTES (web/src/app/routes.tsx; `routes`, `pageRoutes`, `DEV_ROUTES_ENABLED`):
- Root: a pathless route with `RootLayout` (renders `<Outlet/>` plus the sign-in dialog; no markup of its own), `errorElement` RootErrorBoundary, `hydrateFallbackElement` (a spinner while the first lazy page loads). Its children: the shell route `/` and the dev routes `/dev/*` (dev pages stay outside the shell but get the sign-in dialog).
- Shell (`AppShell`) → a pathless child with `errorElement: <RouteErrorBoundary/>` (render crashes and failed lazy imports show an error page inside the shell) → the pages. Every page is lazy: `lazy: page(() => import('@/pages/<name>'))` and the page module's DEFAULT export is the component.
- Pages: index → web/src/pages/home (a wrapper: tab title and an sr-only h1 "The Homebrewery", then the existing web/src/pages/HomePage.tsx, which the integrator replaces); `new`, `edit/:editId`, `share/:shareId`, `user/:handle`, `vault`, `import`, `admin/*` (splat: the admin module owns its sub-routes) → web/src/pages/<name>/index.tsx (trivial placeholders I created; replace them, keep the default export); `account` → pages/account/AccountPage; `login`, `register` → pages/auth/LoginPage, RegisterPage; `*` → NotFoundPage.

SHELL (web/src/app):
- `AppShell`: `<UiRoot surface={false}>` (tokens only, so canvases inherit no chrome styles; plan §5) filling the viewport (position: fixed; inset: 0; flex column): skip link ("Skip to main content"; focuses <main> without touching the hash), `<header>` with the Navbar and a route-loading bar (useNavigation), NotificationBanner, `<main id="main-content" tabIndex=-1>` = the scroll container (display: flex; flex-direction: column; min-height: 0). An editor page fills it with `flex: 1; min-height: 0` and scrolls its own viewport. @media print hides header, banner and skip link and unfixes the layout. `aria-busy` on <main> while a lazy page loads.
- Route focus (`useRouteFocus`): after a client-side navigation to a new PATH, <main> scrolls to the top (unless there is a hash) and focus moves to `[data-route-focus]`, else the first h1, else <main> — unless focus is already inside <main> (an editor or autofocus field) or in a portal layer (dialog, popover). The first load is left to the browser. Editor pages: focus the editor yourself on mount, or put `data-route-focus` on what should get focus.
- `SitePage({ title, heading?, lead?, width?: 'narrow'|'normal'|'wide', children, className?, data-testid? })`: layout for non-editor pages; paints the UI kit surface inside <main>, renders the h1 (tabIndex -1, data-route-focus) and sets the tab title via `usePageTitle`. `usePageTitle(title)` → "<title> - The Homebrewery" (`pageTitle()`, `SITE_NAME`).
- `PageLoading({ label? })`: page-sized spinner (data-testid page-loading).
- `RequireAuth({ children: ReactNode | (account) => ReactNode, role? })`: pending → PageLoading; account check failed → ErrorPage with Retry; anonymous → the "Sign in required" page with the sign-in form in place (no dialog); `role` missing → 403 page. Use it for /admin (`role={ADMIN_ROLE}`) and any page that needs an account. `ADMIN_ROLE`, `hasRole(account, role)` in web/src/app/roles.ts.
- Navbar slots: `<NavbarPortal slot="title">{brew title}</NavbarPortal>` and `<NavbarPortal slot="items">…</NavbarPortal>` (web/src/app/NavbarPortal.tsx) render a page's navbar content (brew title in the middle; page items — share, print, save status, ErrorNavItem — before the site items). Nothing renders outside the shell. Context: `NavbarSlotsContext`, `useNavbarSlot(slot)`, `NO_NAVBAR_SLOTS` (web/src/app/navbarSlotsContext.ts).
- Paths (web/src/app/paths.ts): `paths.{home, new, vault, import, account, admin, edit(id), share(id), user(handle), login(returnTo?), register(returnTo?)}` (ids and handles are encoded); `safeReturnTo(value, fallback = '/')` (same-site absolute paths only; refuses other origins, //, /\, control characters, /login and /register); `isAuthPath(pathname)`; `locationPath(location)`.
- Sign-in prompt: `SignInPrompt` (mounted once by RootLayout) is a UI kit Dialog with the login form. It opens on `onSignInRequired` (every 401 through the query client's policy; `requestSignIn()` from '@/api' opens it directly, e.g. a "Sign in to save" button) or `openSignInPrompt(reason?, error?)`; `closeSignInPrompt()`. It stays closed on /login and /register and while an inline sign-in form is mounted (`registerInlineSignIn()` returns the cleanup; the 401 page does this), and it opens 150 ms after a request (`SIGN_IN_PROMPT_DELAY_MS`) so a page whose load failed with 401 can show its inline form first. Store: web/src/app/signInPromptStore.ts (`signInPromptStore`, `useSignInPrompt()`). After signing in: toast "Signed in as <handle>."; useLogin refetches `me` and the failed queries. The description says "Your session may have ended" only for a failed request (`requestSignIn(error)`); `requestSignIn(null)` (a "Sign in" button) opens it with reason 'user'.
- `useSignOut(onSignedOut?)` → { signOut, pending }: first the before-sign-out hooks (pending saves; `pending` is true meanwhile), then POST /api/account/logout, toast "You're signed out.", `me` = null; a 401 counts as signed out (no prompt); other failures toast. On sign-out it also clears this browser's recent brews (a shared computer) and calls `notifySignedOut()`. Its callbacks are the mutation's own, so call it above anything that unmounts when `me` becomes null.
- Sign-out hand-off (web/src/app/signOutHooks.ts): `registerBeforeSignOut(hook)` → cleanup (hooks run before the logout request and are awaited; failures ignored; `runBeforeSignOut(timeoutMs = SIGN_OUT_SAVE_TIMEOUT_MS 5000)`), `onSignedOut(listener)` → cleanup (after a deliberate sign-out, not after a session expired), `notifySignedOut()`. EditorApp registers its pending save; the editor route closes the brew on onSignedOut.
- Recent brews (web/src/app/recentBrews.ts): per browser in localStorage 'hb-recent-brews' { edit: RecentBrew[], view: RecentBrew[] } (RecentBrew { id, title, ts }; ≤ 8 each, newest first, validated on read; URLs rebuilt from kind + id). EDITOR AND SHARE PAGES: call `useRecordRecentBrew('edit', brew ? { id: brew.editId, title: brew.meta.title } : null)` and `useRecordRecentBrew('view', { id: shareId, title })` (records on open and when id/title change). Also `recordRecentBrew(kind, {id, title}, now?)`, `removeRecentBrew(kind, id)`, `clearRecentBrews()`, `useRecentBrews()`, `recentBrewUrl(kind, id)`, `withRecentBrew`, `parseRecentBrews`, `RECENT_LIMIT`, `RECENT_STORAGE_KEY`. Upstream's HB_nav_recently* keys are not imported (their ids are upstream's).
- Notices (web/src/app/NotificationBanner.tsx + noticeDismissals.ts): `<NotificationBanner focusAfterLast? />` in the shell under the navbar: a region "Site notices" listing GET /api/notifications/active (plain text, pre-line), each with "Dismiss notice: <title>"; dismissed dismissKeys go to localStorage 'hb-dismissed-notices' (≤ 100, newest last); focus moves to the next notice's button, or to <main> after the last. Refetched every 15 min (`NOTICE_REFETCH_MS`); failures are silent (the query's meta is manual). Also `dismissNotice(key)`, `useDismissedNotices()`, `visibleNotices(notices, dismissed)`, `noticeDismissalsStore`.
- Small helpers: `createLocalStore({ key, parse, fallback, storage? })` + `useLocalStore(store)` (validated JSON in localStorage, stable snapshots, in-memory fallback when storage throws, cross-tab `storage` events) in localStore.ts; `formatRelativeTime(time, now?, locale?)` ("just now", "5 minutes ago", "yesterday") and `formatDateTime(time)` in relativeTime.ts (for list pages too); `siteLinks.{reportIssue, faq, bugReport(details)}` in siteLinks.ts (still upstream's community links).
- Test helpers (Vitest only): web/src/app/testing.tsx `renderRoute(element, { url?, path?, routes?, me?, client? })` → { router, queryClient, user, … } (memory router with RootLayout and a location probe `data-testid="location"` whose data-state holds the router state as JSON), `testQueryClient(notify?)` (the app's policy client without retries), fixtures `ALICE`, `ADMIN`.

NAVBAR (web/src/ported/navbar; barrel index.ts): port of legacy client/homebrew/navbar/**.
- `Navbar({ titleSlotRef?, itemsSlotRef? })`: `<nav aria-label="Main">` with the brand link (d20 mark + "The Homebrewery" → /), the title and page-item slots, then a list: New, Vault, Recent, Help, account item. A dark bar in both schemes (local custom properties); upstream's colour classes are an accent underline (`NavTone`: purple, yellow, teal, green, red, orange, blue, grey). Under 720 px the item text is visually hidden (names stay); under 400 px the items are tighter, the disclosure chevrons go, and the bar wraps rather than clipping, so the account item stays on screen at 320 px (WCAG 1.4.10). Disclosure chevrons carry the `.chevron` class (rotated while open).
- `NavDisclosure({ label, aria-label?, icon?, tone?, collapsible?, panelLabel, placement? = 'bottom-end', children: node | (close) => node, className?, triggerClassName?, panelClassName?, data-testid? })`: Nav.dropdown rebuilt as a disclosure (APG disclosure navigation): button with aria-expanded/aria-controls opening a UI kit Popover (role group, named by panelLabel). Click, Enter, Space or ArrowDown open it and focus the first entry; ArrowUp/Down, Home, End move between entries; Escape closes and refocuses the trigger; Tab past the end continues after the trigger; a press outside, following a link or a route change closes it. `close()` (for acting buttons) also refocuses the trigger. Panel test id: `<data-testid>-panel`.
- `NavLinkItem` (router NavLink: aria-current="page"; props icon, tone, collapsible, ref) and `NavButton` (icon, tone, collapsible) for page items; `navbarStyles` exposes the classes (panelList, panelLink, panelHint, panelHeading, panelNote, …) for page panels that should look the same.
- Items: `NewBrewNavItem` (panel: "New brew" → /new, "Import a brew" → /import), `VaultNavItem` (link), `RecentNavItem` (panel "Recent brews": Edited and Viewed sections with relative times and per-entry "Remove <title> from recent brews"; focus moves to the neighbouring remove button), `HelpNavItem` ("Report an issue", "FAQ"; new tab, "(opens in a new tab)" for screen readers), `AccountNavItem` (signed out: "Sign in" → /login?returnTo=<current page>; signed in: "Account: <handle>" panel with "Signed in as", My brews, Account settings, Admin (Admin role), Sign out; after sign-out focus goes to the "Sign in" link).
- `ErrorNavItem({ error, onRetry?, onDismiss?, label? = 'Oops!', data-testid? = 'nav-error' })`: the legacy error nav item: a red "Oops!" disclosure whose panel says what went wrong and offers what fits: Sign in (401 → requestSignIn()), Try again (network, 429, 5xx when onRetry is given), Reload the page (403, 409), Report the issue (GitHub issue with `errorReport(error)`), Dismiss/Not now (onDismiss). Messages: `describeSaveError(error)` → { message, actions } and `errorReport(error)` in saveErrorMessages.ts. The autosave lane can render it through `<NavbarPortal slot="items">`.

PAGES:
- /login (pages/auth/LoginPage): LoginForm; a signed-in visitor (or one who just signed in) goes to ?returnTo (safe) or /. Link to /register keeps returnTo.
- /register (pages/auth/RegisterPage): email, password (hint with Identity's default rules), confirm; client checks required and match; API errors on the fields (Identity codes Password* → password, *Email/*UserName → email; `registerErrors`); then signs in and goes to /account with router state `AccountWelcomeState { welcome: true, returnTo }` (pages/account/accountState.ts). A taken email (API 200, BS-5) → the sign-in after it fails → "If you already have an account, sign in instead" with a link.
- `LoginForm({ onSuccess?(account), autoFocus?, defaultEmail?, submitLabel?, data-testid? })` (pages/auth/LoginForm.tsx; used by /login, the 401 page and the dialog): email, password, "Keep me signed in" (remember → ?useCookies=true, else ?useSessionCookies=true), a 2FA code field when Identity answers RequiresTwoFactor; messages from `loginError()` (authErrors.ts); focus goes to the field to fix. `FormError` (role=alert; key it per attempt).
- /account (pages/account/AccountPage): RequireAuth; welcome note for new accounts (with "Continue where you were"); email, handle, brew count (useUserBrews(handle).total, silent on failure), roles; handle form: sends what was typed (the API normalises and validates) and shows the API's messages on the field (400 errors.handle, 409 detail; `handleErrorMessage`), 401/5xx left to the error policy; a role=status line confirms; links to /user/<handle> and /admin (admins); Password: "Change your password" form (current, new with the password rules, confirm; client checks required and match; `changePasswordErrors(error)` in pages/auth/authErrors.ts maps PasswordMismatch/OldPasswordRequired to the current field and the other Password* codes to the new one; role=status "Your password was changed."; useChangePassword); Sign out.
- Error pages (pages/errors; barrel index.ts): `ErrorPage({ error?, status?, title?, message?, onRetry?, details?, children? })`: 401 → the sign-in page (`SignInRequired`, pages/auth/SignInRequired.tsx, the inline form); 403 "Access denied"; 404/410 "Not found"; 423 "This brew is locked" with the lock reason (the API's detail = share message) and "Lock code <code>"; network → "Can't reach the server"; others "Something went wrong"; "Try again" only for transient failures (or when there is no error). Always "Error <status>" and links home and to the vault. `errorContent({ error?, status? })` computes it. `NotFoundPage`, `RouteErrorBoundary` (route errorElement: 404 responses, thrown ApiErrors, failed dynamic imports → "This page could not be loaded" + reload, crashes → "Something went wrong" + reload, with the stack in dev builds), `isChunkLoadError(error)`. PAGES LOADING DATA: `if (query.error) return <ErrorPage error={query.error} onRetry={() => void query.refetch()} />`.

DEV PAGE /dev/shell (web/src/dev/shell): ErrorNavItem for every outcome (network, 400, 401, 403, 404, 409, 413, 423, 500; test ids nav-error-<key>, last-action), "Request sign-in" (request-sign-in) and "Load admin stats" (load-protected, a real request: 401 anonymous → dialog; 403 for non-admins; status in protected-status), the signed-in handle (me), recent-brews buttons (add-recent-edit, add-recent-view, clear-recent) with a RecentNavItem, and ErrorPage previews (error-page-select, error-page-preview).

E2E (web/e2e/shell, port 5321):
- shell.spec.ts (API stubbed with page.route on /api/*, runs anywhere): navbar keyboard and Tab flow, panel placement and outside press, route focus, recent brews, narrow screens, notices (dismiss, focus, persistence), 404, /account anonymous, ErrorNavItem and the dialog on /dev/shell, the 423 page, axe (no violations at all) on /login, /register, /account (anonymous and signed in), 404 and /vault with a notice in light and dark, serious-only with each navbar panel open, and the home page.
- auth.spec.ts (real API; skipped when /api/account/me is unreachable through the Vite proxy): register → /account (default handle, welcome, axe) → invalid handle (API message) → taken handle (409 detail) → new handle → sign out from the navbar → sign in on the 401 page → sign out from the page → /login?returnTo=/account; wrong password and taken-email messages; /account anonymous and a real 401 on /dev/shell opening the dialog, signing in there, the retried request then 403; notices created through the admin API (needs the API started with Admin__Emails=shell-admin@e2e.test, else skipped), shown, dismissed, still hidden after reload, deleted afterwards. Password change on /account (Identity's wrong-password and rule messages on the fields, success, still signed in, old password refused, new one accepted).
- narrow.spec.ts (API stubbed): the navbar at 320 px and the editor panels at 390 px (see the App pages section).
- Run: start an API (`Admin__Emails=shell-admin@e2e.test ASPNETCORE_ENVIRONMENT=Development dotnet run --project src/Homebrewery.Api --artifacts-path <tmp> --no-launch-profile --urls http://localhost:5421`), then from web/: `HB_API_URL=http://localhost:5421 E2E_PORT=5321 npx playwright test e2e/shell`.

### Notes for later phases
- Integrator (editor pages): /new, /edit, /share and / are lazy placeholders with default exports; keep default exports or change `pageRoutes`. Put the brew title and page items in the navbar with NavbarPortal; record recent brews with useRecordRecentBrew; render ErrorPage for failed loads (401 shows the inline sign-in form; 423 the lock page). The shell's <main> is the scroll container: the editor should fill it (flex: 1; min-height: 0) and keep its own viewport scrolling. The home wrapper (web/src/pages/home/index.tsx) adds the page's sr-only h1; drop it if HomePage renders its own h1. Legacy "from blank" (discard the /new draft) is not in the New menu: /new should offer "start over" itself (P7.2).
- Autosave lane: for a 401 on save call `requestSignIn()` (or let the policy do it); `ErrorNavItem` in the items slot is the ported error item; its "Try again" needs `onRetry`.
- Admin lane (P7.4): wrap the admin page in `<RequireAuth role={ADMIN_ROLE}>`; the route is `admin/*`, so nested <Routes> in the module work.
- User page / vault lanes: `formatRelativeTime`/`formatDateTime` (web/src/app/relativeTime.ts), `SitePage width="wide"`, `paths.*`.
- Account page, not done: email change and password reset (need an IEmailSender), upstream's "last login" (Identity doesn't record it). Handles are validated only by the API (the hint shows the rules).
- web/src/pages/NotFoundPage.tsx (the original) is still used by web/src/dev/DevRoutes.tsx; the shell uses web/src/pages/errors/NotFoundPage.tsx. The dev routes' own 404 could switch to it.
- Help links and bug reports still point at upstream (reddit r/homebrewery, homebrewery.naturalcrit.com/faq, github.com/naturalcrit/homebrewery issues): change web/src/app/siteLinks.ts when the fork has its own. Not ported: NaturalCrit logo link, version/changelog item, Patreon item, share/print/metadata items (page items for the editor lanes).
- smoke.spec.ts (not mine) looks for an h1 "Homebrewery" on /: the home wrapper's sr-only h1 "The Homebrewery" satisfies it.
- Toaster: still mounted in App.tsx outside the router (dev pages need it); the shell's UiRoot uses the system scheme, like the Toaster's portal.
- E2E under load: on this shared machine Firefox axe scans took up to a minute each with 6 workers, and other agents' edits make Vite reload pages mid-test (HMR). The specs use 15 s expect timeouts and 90–120 s test timeouts. For my local runs I started Vite myself with HMR off and a private optimizer cache (a scratch config extending web/vite.config.ts with `cacheDir: <tmp>` and `server.hmr: false`) and ran Playwright with E2E_BASE_URL=http://localhost:5321; the default webServer path works the same when the tree is quiet. A web owner could add an env switch for this to vite.config.ts.
- Vitest under load: the lane's component tests import web/src/app/testing.tsx, which sets testing-library's asyncUtilTimeout to 5 s and the file's testTimeout to 20 s (App.test.tsx: 10 s / 30 s; every test there lazy-loads a page). In full-suite runs on the loaded machine, web/src/dev/registry.test.tsx (not mine) sometimes times out on its default 1 s findByRole while the /dev chunk (every harness, now including /dev/shell) loads; it passes on its own. The UI kit and editor tests showed similar load timeouts in the same runs.
- Process: I edited only my paths (web/src/app/** except uiStore.ts and queryClient.ts, web/src/pages/{auth,account,errors,home}/**, the placeholders web/src/pages/{new,edit,share,user,vault,import,admin}/index.tsx, web/src/ported/navbar/**, web/src/dev/shell/**, web/e2e/shell/**) and this section. No packages were added; no git commands that change the index or tree were run. For e2e I ran my own API on :5421 (--artifacts-path C:/Users/ranky/AppData/Local/Temp/hb-artifacts-shell) and Vite on :5321. Once, a scratch Vite config without a private cacheDir re-optimised web/node_modules/.vite at about 04:48; after that my runs used a private cache.

## Keymap, toolbar, class picker, link dialog (P3.4, plan §6.1, §6.2)

### Interfaces
KEYMAP (web/src/editor/commands/keymap.ts)
- `hbKeymapExtensions: readonly AnyExtension[]` = HbKeymap plus the superscript and subscript marks without TipTap's keys (same-name replacement; the schema and manifest are unchanged). Add them to `buildEditorExtensions({ extensions })` or EditorCanvas `extensions` (memoized), together with `Sections` (commands/sections.ts) and `Pagination`.
- `HbKeymap`: extension 'hbKeymap', priority `HB_KEYMAP_PRIORITY` = 1200. It must be above TipTap's Paragraph (1000; its Mod-Alt-0 would otherwise run first) and above Sections (1100; its Mod-Enter would otherwise run the break without closing the undo group).
- Requests, for what the keymap can't do alone:
  - `KeymapRequest` = 'save' | 'print' | 'span' | 'themeBlock' | 'link' | 'focusToolbar'.
  - `onKeymapRequest(editor, listener) → unsubscribe`. The newest listener is asked first; return false to decline.
  - `emitKeymapRequest(editor, request) → handled`.
  - Integrator wiring: `useEffect(() => onKeymapRequest(editor, (r) => r === 'save' ? (saveNow(), true) : r === 'print' ? (void handle.print(), true) : false), [editor])`.
  - Unhandled requests:
    - Mod-S is still consumed (no browser "Save page").
    - Mod-P and Alt-F10 fall through to the browser.
    - Mod-K does nothing.
    - Mod-M toggles a plain span; Shift-Mod-M wraps in a plain theme block.
- Running commands, each as exactly one undo step:
  - `runChain(editor, (chain) => chain…)`, `runCommand(editor, pmCommand)`. Both close the undo group before and after (prosemirror-history closeHistory, plus an empty transaction), so neither the typing before nor the typing after merges into the step.
  - `closeUndoGroup(editor)`, `canRun(editor, cmd)`.
  - A read-only editor runs nothing, and HbKeymap consumes the formatting keys so TipTap's own bindings can't format it.
- `editorActions` (shared by keys and toolbar):
  - marks: bold, italic, underline, strike, code, superscript, subscript
  - spacing: nbsp, widenSpacer, narrowSpacer
  - lists: bulletList, orderedList, sinkListItem, liftListItem (blocks.ts `moveListItem`: also across a page seam of a split list, see below)
  - block types: blockquote, codeBlock, paragraph, toggleHeading(e, level), setBlockKind(e, kind)
  - align(e, value | null)
  - breaks: pageBreak (sections.ts insertPageBreak), columnBreak
  - spans: applySpan(e, classes), removeSpan
  - theme blocks: wrapInThemeBlock(e, classes), unwrapThemeBlock
  - links: applyLink(e, href, text?), removeLink
  - undo, redo
- Shortcut table:
  - `HB_SHORTCUTS: Record<ShortcutId, string[]>` (ProseMirror key names; the first is shown in tooltips).
  - `shortcutLabel(key, mac?)` → "Ctrl+Shift+=" or "⇧⌘="; `ariaKeyShortcut(key, mac?)` → "Control+Shift+="; `shortcutFor(id)` → { label, aria }; `isMacPlatform()`.

THE FINAL MAP ("Mod" = Ctrl, Cmd on macOS)
- Marks:
  - Mod-B / Mod-I / Mod-U: bold / italic / underline.
  - Shift-Mod-S: strike; Mod-E: inline code (TipTap's keys, rebound for single undo steps).
  - Shift-Mod-= / Mod-=: superscript / subscript. TipTap's Mod-. and Mod-, are removed.
- Spacing:
  - Mod-.: U+00A0.
  - Shift-Mod-. widens the % spacer (inlineBox) before, selected or after the cursor by 10% (max 100). With no spacer it inserts a 10% one and leaves the cursor after it.
  - Shift-Mod-, narrows it by 10%; at 0 it is removed.
- Classes and links:
  - Mod-M: class picker for a span. The span at the cursor, or one whose range is exactly the selection, is edited; otherwise a new, nested span is added.
  - Shift-Mod-M: class picker, wrap in a theme block. A list item's paragraph wraps the whole list. A selection across pages wraps its first page's part.
  - Mod-K: link dialog.
- Lists: Mod-L / Shift-Mod-L (TipTap's Shift-Mod-8 / Shift-Mod-7 kept).
- Block types:
  - Shift-Mod-1…6: heading, toggling back to a paragraph. Mod-Alt-1…6 do the same; Mod-Alt-0 sets a paragraph.
  - Mod-Alt-C: code block; Shift-Mod-B: blockquote.
  - All block type changes go through commands/blockType.ts (history-safe, whole split paragraphs).
- Breaks:
  - Mod-Enter: sections.ts insertPageBreak. It replaces TipTap's hard break on that key (Shift-Enter is still a hard break). In a code block the break fails and the key goes on to TipTap's exitCode.
  - Shift-Mod-Enter: columnBreak. In the middle of a block it splits the block; at a block's start it goes before it, at its end after it. It goes in the innermost container that accepts it; the part after it is never a continuation.
- History: Mod-Z / Shift-Mod-Z / Mod-Y (UndoRedo's keys).
- Tab / Shift-Tab: in a list item, sink / lift it (moveListItem: also on a list pagination split, PGR-11/12). The key is consumed even when the item can't move. Elsewhere Tab is not handled: the browser moves focus (no trap), and tables keep their cell navigation, also a table inside a list item (the innermost list item or table cell decides, `inTableCellOfList`; UI-5). While the ':' icon suggestion is open, Tab accepts it (IconSuggestion's priority is 1300, above HbKeymap).
- Requests: Mod-S (request 'save'), Mod-P (request 'print'), Alt-F10 (request 'focusToolbar').
- Mod-/ does nothing (no comments).

BLOCK AND MARK COMMANDS (ProseMirror commands; tested headless)
- marks.ts:
  - `insertNbsp`, `NBSP`.
  - Spacers: `SPACER_STEP` = 10, `SPACER_MAX` = 100, `spacerWidth(style)`, `withSpacerWidth(style, pct)` (cssText-normalized), `spacerAt(state)`, `widenSpacer`, `narrowSpacer`.
  - `inRichText(state)`: the selection's textblock holds inline content and isn't code. widenSpacer (insert), applySpan and applyLink refuse a code block (content text*, no marks; UI-7); the toolbar's `inText` is this, so mark, Link and span controls are disabled there.
  - Classes: `parseClassInput`, `classProblem(name)` (reserved classes and editor classes refused; like the server's IsClassToken also whitespace including U+0085, NUL and more than 256 characters; UI-11), `cleanClassList`.
  - Spans: `spanTarget(state)` → { mark, from, to } | null, `applySpan(classes)`, `removeSpan`. Editing a span keeps its style, id and attributes and the nesting order of other spans.
  - Links: `linkTarget(state)`, `normalizeHref` (bare domain → https://), `hrefProblem` (isSafeHref policy), `applyLink(href, text?)`, `removeLink`.
- blocks.ts:
  - Read-outs: `TEXT_BLOCK_KINDS` / `TEXT_BLOCK_LABELS` / `TextBlockKind` ('paragraph' | 'heading1'…'heading6' | 'codeBlock'), `headingKind`, `kindLevel`, `kindType(schema, kind)`, `blockKindOf(state)` (kind | 'mixed' | 'other' | null), `inBlockquote`, `listKindOf`, `inListItem`, `alignOf(state)` (value | null | 'mixed' | undefined).
  - `setAlign(value)` (AttrSteps).
  - `setTextBlockKind(kind)` / `toggleTextBlockKind(kind)`: TipTap CommandProps functions; use them with `chain.command(...)`. They go over blockType.ts's `setTextblockType`, and are a no-op when nothing changes. TipTap's setNode (which lifts the block) runs only when every covered block is blocked where it stands.
  - `insertColumnBreak`.
  - Theme blocks: `themeBlockAt(state)`, `wrapInThemeBlock(classes)`, `unwrapThemeBlock`.
  - Lists: `moveListItem('sink' | 'lift')` (Tab / Shift-Tab). When pagination split the page's top-level block holding the item, the pages the move needs are joined first (JoinPagesStep + rejoinContinuations, which also drops filler paragraphs): a sink joins the page before when the item starts a continued list fragment, and the next page(s) when the item ends its page; a lift joins the block's whole chain. prosemirror-schema-list's sink/lift then runs on a copy, and its result replaces the top-level block with ONE ReplaceStep (its undo maps through pagination; the move's own ReplaceAroundSteps don't, PG-2). Joined pages with objects or markers come back after the block (blockType.ts `restorePages`). `inTableCellOfList(state)`.

UI (import from '@/editor/ui/toolbar', '@/editor/ui/classPicker', '@/editor/ui/linkDialog')
- `EditorToolbar({ editor, insertMenu?, status?, label? = 'Editing', dialogs? = true, className?, 'data-testid'? })`
  - The editor must have hbKeymapExtensions: the Link button and the Classes menu send requests.
  - It renders `EditorDialogs` unless dialogs is false.
  - It reads the editor through `useToolbarState(editor)` (useEditorState with deep equality over `toolbarStateOf(editor)`). Pagination transactions never re-render it (tested in Vitest and e2e).
  - Groups: History (undo/redo), Block (block type menu: Paragraph, Heading 1–6 and Code block as radio items, plus a Blockquote checkbox), Text (the 7 marks, Link, Classes menu), Alignment (4 toggles; pressing the active one resets to the theme default; disabled without a paragraph), Lists, Insert (insertMenu slot, page break, column break), View (zoom out/menu/in and page layout, from the UI store).
  - The status slot sits at the end.
  - Clicking a button never takes the focus from the editor. After a pick in the block menu, focus goes to the editor. Escape inside the toolbar goes back to the editor; Alt+F10 in the editor focuses the toolbar's tab stop.
  - Test ids: block-type, mark-<bold|italic|underline|strike|superscript|subscript|code|link>, classes-menu, align-<left|center|right|justify>, list-bullet, list-ordered, insert-page-break, insert-column-break, zoom-out, zoom-menu, zoom-in, spread-menu.
- `EditorDialogs({ editor })`: opens the ClassPicker (requests 'span' / 'themeBlock') and the LinkDialog ('link') from `describeDialog(editor, request)`. It applies the result as one undo step and shows a warning toast when a command can't apply. Test ids: class-picker(-input|-options|-chosen|-apply|-remove), link-dialog(-href|-text|-apply|-remove).
- `ClassPicker({ open, onOpenChange, mode: 'span' | 'themeBlock', initialClasses?, editing?, suggestions, onApply(classes), onRemove?, removeLabel?, 'data-testid'? })`
  - A modal Dialog with the chosen classes as removable chips and a combobox over a listbox of at most `MAX_SUGGESTIONS` (12) matches. The list doesn't scroll (axe scrollable-region-focusable).
  - Keys: ArrowUp/Down move (wrapping); Enter adds the active option or the typed text; Space or comma add typed text; Enter on an empty field applies; Backspace on an empty field removes the last chip; Escape closes.
  - A polite status line gives the count. Invalid classes show on the field (aria-invalid).
- `collectThemeClasses({ document?, sheets?, scopeClass? = 'hb-canvas' })` → `ThemeClass[] { name, rules, block, inline }`, most used first.
  - It reads every canvas-scoped rule of document.styleSheets and adoptedStyleSheets: theme links and the brew's CSS, including nested and grouped rules. Unreadable (cross-origin) sheets are skipped.
  - Left out: RESERVED_CLASSES and editor classes, hb-*, icon fonts with their glyph classes, fa-*, and `NON_AUTHOR_CLASSES` (page markers, pageNumber, footnote, columnSplit, blank, toc).
  - Also exported: `suggestClasses(all, query, mode, exclude)` (ranked exact, prefix, word start, substring; then the mode's element, then use count), `selectorClasses(selectorText)`, `isSuggestableClass(name)`.
- `LinkDialog({ open, onOpenChange, initialHref?, askText?, editing?, onApply(href, text?), onRemove?, 'data-testid'? })`: address (normalizeHref, validated with hrefProblem), text when nothing is selected, Remove link when editing.

DEV PAGE AND TESTS
- /dev/toolbar[?theme=5ePHB&doc=basic|long&print=1]
  - EditorCanvas (static theme source) with hbKeymapExtensions, Pagination and Sections, plus EditorToolbar with a stand-in Insert menu and a save status.
  - Mod-S and Mod-P are logged (data-testid requests, save-status); print=1 really prints.
  - window.__hbToolbar = ToolbarHarnessApi (web/src/dev/toolbar/harness.ts): requests, toolbarRenders (React Profiler), settled(), select(text, offset?, n?), json(), pages(), undoDepth(), pageTexts(), marksAt(text), blockOf(text).
- Vitest helpers (web/src/editor/ui/toolbar/testing.ts):
  - `createTestEditor(content, { pagination?, editable?, element?, extensions? })` (line-model pagination) and `settle(editor)`.
  - `keyEvent(name)` / `press(editor, 'Shift-Mod-=')` (a US-keyboard key and keyCode; runs every handleKeyDown).
  - `posOf`, `selectText`, `setCursor`, `selectNode`, `docJson`.
- E2E: web/e2e/toolbar (port 5322).
  - keymap.spec.ts (21 tests): every shortcut, each with a one-undo check.
  - toolbar.spec.ts (8 tests): axe in light and dark with the block menu, class picker and link dialog open; roving focus; keyboard block menu; pointer; breaks; zoom and spread persistence; no re-render during pagination.
  - Helpers in e2e/toolbar/helpers.ts: openToolbar, settle, select, pressUndoable, …

### Notes for later phases
- Integrator (editor page):
  - Add `...hbKeymapExtensions`, `Sections` and `Pagination.configure({ isReady: gate.isReady })` to the canvas extensions.
  - Mount `<EditorToolbar editor insertMenu={<InsertMenu …/>} status={<SaveStatus …/>} />`.
  - Answer the 'save' request with autosave's saveNow and 'print' with `handle.print()`.
  - `BlockTypeCommands` (blockType.ts) is optional for the keymap and toolbar: they call blockType.ts directly.
- Pagination-UX lane, blockType.ts (bug, not fixed, outside my paths): its `setNode` falls back to TipTap's core setNode when nothing needs changing (chains empty, not blocked).
  - TipTap's setNode then runs clearNodes, whose setNodeMarkup resets every attribute of a paragraph that already is one: align, classes, style, continuation.
  - Example: `editor.commands.setParagraph()` (and TipTap's own Mod-Alt-0) on an aligned paragraph loses its align. On a continuation fragment it breaks the fragment chain.
  - Suggested fix: return false when there is nothing to change. HbKeymap and the toolbar don't hit it: blocks.ts setTextBlockKind treats that case as a no-op.
- Lists on split blocks: TipTap's toggleList changes a list's type with setNodeMarkup, which resets `continuation` and `start` on that one fragment. Bullet ↔ numbered on a list that pagination split therefore breaks its fragment chain. A fragment-aware list toggle belongs with blockType.ts.
- Links: the link mark is inclusive (LINK_DEFAULTS.autolink), so typing at a link's end extends it.
  - applyLink with an empty selection inserts the text and removes the stored link mark, so the next typing is unlinked.
  - Any appended transaction with steps clears stored marks, so this is best effort.
- Browser and OS shortcuts. Playwright sends synthetic events, which only prove the page's handling. Chrome and Firefox let pages prevent these inside the editor, as upstream's CodeMirror keymap did: Ctrl+B (Firefox bookmarks), Ctrl+U (view source), Ctrl+I (page info), Ctrl+K and Ctrl+E (search), Ctrl+L (address bar), Ctrl+= and Ctrl+Shift+= (zoom), Ctrl+P, Ctrl+S.
- Shortcuts the browser or OS may take first; the toolbar offers every action without them:
  - macOS Cmd+M minimizes the window (Mod-M; use the Classes menu).
  - Firefox Ctrl+Shift+M may open Responsive Design Mode, and Chrome's Ctrl+Shift+M is the profile menu (Shift-Mod-M).
  - macOS Cmd+L may be kept by the browser (Mod-L; use the list buttons).
- Inspector lane (P3.5): reuse `collectThemeClasses` / `suggestClasses` / `ClassPicker` for node classes, e.g. with `mode: 'themeBlock'` for blocks.
- Vitest: the UI suites (ClassPicker, LinkDialog, EditorToolbar) set 30 s timeouts. user-event typing took over 5 s per test with the other lanes' runs in parallel.
- E2E:
  - openToolbar retries the navigation once: other agents' edits make the shared Vite server reload pages mid-load.
  - Stub the API by pathname (`url.pathname.startsWith('/api/')`). A `**/api/**` glob also catches Vite's `/src/api/*.ts` modules and blanks the app.
  - Against a freshly started Vite, the first loads can race dependency re-optimisation. Running against a warm server (`E2E_BASE_URL=http://localhost:5322` with `E2E_PORT=5322`) avoids it.
  - In Firefox, Tab out of the last focusable element moves focus to the browser UI while document.activeElement stays on the editor. Assert that Tab wasn't prevented rather than that focus moved.
- My page-break stand-in (blocks.ts insertManualPageBreak) was removed once sections.ts landed. Mod-Enter and the Page break button use `insertPageBreak`.


## Metadata dialog, outline panel, page navigation (P3.7, P3.9, plan §6.2)

### Interfaces
METADATA DIALOG (web/src/editor/ui/metadata/MetadataDialog.tsx)
- `MetadataDialog({ open, onOpenChange, brew: MetadataBrew, draft?: MetaDraft, onChange(change: MetadataChange), serverError?: unknown, onDeleted?(result: DeleteBrewResponse, editId), onLockChange?(lock: BrewLockInfo), baseUrl?, 'data-testid'? = 'metadata-dialog' })`.
  - A modal Dialog titled "Properties" (size lg, "Done" closes it).
  - Its body mounts only while open, so the local draft starts again from `draft` (default: from `brew`) on every open. Pass the editor's current meta as `draft` so unsaved edits reappear.
  - onChange fires for every accepted edit, never for text that breaks a rule. `change.meta` is the BrewMetaInput for SaveBrewRequest.meta / CreateBrewRequest.meta. Every field is sent; `authors` only when the owner changed the list; the thumbnail as '' when cleared.
  - API calls the dialog makes itself:
    - GET /api/themes through useThemes with meta errorPolicy 'manual'. On failure it shows its own hint with Retry; a pasted Share URL or ID still works.
    - DELETE /api/brews/{editId} through useDeleteBrew. A failure toasts and the confirm dialog stays open.
    - POST /api/brews/{editId}/lock/review through useRequestLockReview with meta 'manual'. A failure shows next to the button.
  - Saving is not done here (autosave lane).
- Autosave wiring (P3.8's useAutosave):
  - `const [meta, setMeta] = useState<BrewMetaInput | null>(null)`
  - `onChange={(c) => { setMeta(c.meta); setDraft(c.draft); }}`
  - `getMeta: () => meta`, `watch: [meta]`
  - Pass the last save error as `serverError` (an ApiError; its meta.* keys go to the fields).

PORTED FORM (web/src/ported/metadata)
- MetadataEditor.tsx: `MetadataEditor({ brew, draft, onChange, themes?, themesState?, onRetryThemes?, serverError?, baseUrl? = location.origin, onDelete?(): Promise, onRequestReview?(): Promise<BrewLockInfo>, lock? })`. It is the controlled form without the Dialog or the API.
- Sections:
  - Lock (only when locked): code, date, reason (= editMessage), and "Request review", or "Review requested on …".
  - Brew: title, description (with a character count), thumbnail URL with a preview (the default Homebrewery thumbnail when empty, a message when the image fails to load, hide/show toggle), tags, language, theme.
  - Authors: AuthorsField.
  - Privacy: the "Published" Switch.
  - Delete: shown only with onDelete and an editId. The wording depends on whether the caller is the only owner/author (delete for good) or not (remove me).
- AuthorsField.tsx: `AuthorsField({ authors, editable, onChange, error? })`.
  - The owner sees the owner and authors as chips linking to /user/{handle}. Authors can be removed after a ConfirmDialog. Invited authors are a TagInput: handles are trimmed and lower-cased, checked against the server's handle rule, and must not already be listed. New handles get role 'invited'.
  - Everyone else sees both lists read-only.
- metaDraft.ts:
  - Types: MetadataBrew { editId|null, shareId|null, meta: BrewMeta, authors: BrewAuthorInfo[], role: AuthorRole|null (null = unsaved /new), lock }; MetaDraft (BrewMeta fields with thumbnailUrl '' for none, plus authors: BrewAuthorInfo[]); MetaField; MetadataChange { field, draft, meta }; MetaFieldErrors.
  - Functions: metadataBrewFrom(BrewForEdit), draftFromBrew(brew), metaInputFromDraft(draft, brew), canManageAuthors(role), metaFieldErrors(error).
  - metaFieldErrors maps 'meta.title', '$.meta.published' and similar keys to fields (case-insensitive). Other meta.* messages go to `other`, which shows as an alert at the top.
  - META_FIELDS.
- validations.ts: port of validations.js with upstream's messages ('Max title length of 100 characters', 'Max description length of 500 characters.', 'Max URL length of 256 characters.', 'Must be a valid URL', 'Invalid language code.', 'Must be a valid Share URL or a 12-character ID.').
  - Additions: a thumbnail must be http(s), as the server requires. parseShareReference(value, baseUrl) takes a 12-character id or this site's /share/{id} URL.
  - Also exports inviteProblem, normalizeHandle, LANG_PATTERN, SHARE_ID_PATTERN, HANDLE_PATTERN, MAX_*, and ERROR_DELAY_MS (300). Rule messages appear 300 ms after typing stops, or on blur; fixing the text clears them at once.
- themeOptions.ts:
  - themeChoices(ThemeList, { excludeShareId }) returns static themes, then 'mine', then 'shared' user themes. The brew itself is left out.
  - Also: themeOptions(choices) (groups "Built-in themes", "My themes", "Shared themes"; images from static textures and user thumbnails), themeLabel(id, choices), findThemeByText(text, choices), THEME_GROUP_LABELS.
- languages.ts: LANG_CODES (upstream's list, sorted) and languageOptions() (the code, its own name as detail, the English name as a keyword).
- thumbnail.png: copied from legacy/client/homebrew/thumbnail.png.

TAG INPUT AND COMBOBOX (web/src/ported/tagInput)
- Combobox.tsx: `Combobox({ label, hideLabel?, hint?, error?, value, onValueChange, options: ComboboxOption[], onSelect(option), onCommit?(text), onBlur?, filter?: 'startsWith'|'includes'|'none' = 'includes', maxOptions? = 200, currentValue?, placeholder?, emptyMessage?, showToggle? = true, disabled?, id?, name?, className?, inputRef?, 'data-testid'? })`.
  - Follows the APG editable combobox with list autocomplete: focus stays in the input, with aria-activedescendant.
  - Keys: ArrowDown/Up open and move (wrapping, disabled options skipped); Alt+Down opens; Alt+Up closes; Enter picks, or commits the typed text; Escape closes only the list (registerEscape, so a surrounding dialog stays open); Tab closes.
  - Groups use role=group, named by their heading.
  - Typed text filters the options only after the user has typed. A box showing the current value lists everything.
  - The listbox is portaled and mounted only while open; aria-controls is set only then. It is positioned with useFloating and closed by useDismiss.
  - Why mounted only while open: a portal layer created before a modal Dialog's layer ends up under the dialog and is made inert. jsdom can't show this; the e2e found it.
- comboboxModel.ts: ComboboxOption { value, label, detail?, group?, keywords?, image?, tone?, disabled? }, ComboboxFilter, filterOptions(options, text, filter, max), setRef.
- TagInput.tsx: `TagInput({ label, values, onChange(values), suggestions?, validate?(raw, values, { index?, suggested }), normalize?, toneOf?, itemName? = 'item', placeholder?, hint?, error?, readOnly?, filter? = 'startsWith', className?, 'data-testid'? })`.
  - Chips: the chip text is a button that edits the value in place (Enter saves, Escape cancels without closing the dialog, blur saves a valid change). The x button removes it; focus moves to the next chip, or to the input when none are left.
  - Values already in the list are left out of the suggestions.
- normalizeTag.ts: TAG_PATTERN (upstream), MAX_TAGS 50 (server), TAG_TYPES, tagType(tag), normalizeTag(input, canonicalForms?), tagProblem(raw, tags, { pattern?: RegExp|null, max?, ignoreIndex? }). A pattern of null (used for curated suggestions) skips the pattern check.
- tagSuggestions.ts: TAG_SUGGESTIONS and TAG_CANONICAL_FORMS, upstream's curated lists as they were.

OUTLINE (web/src/editor/ui/outline)
- Outline.tsx: `Outline({ editor, tracker, label? = 'Outline', moveSelection? = true, className?, 'data-testid'? = 'outline' })`.
  - A nav landmark listing every page, with the headings of each page nested under it. The current page's link has aria-current="location" and stays in view in the list unless the pointer or focus is in the outline.
  - Links keep href="#p3" / "#heading-id"; clicks call preventDefault.
  - A page link calls tracker.goToPage(n).
  - A heading link finds the block by id in the current document, scrolls its DOM to the top (tracker.scrollToElement) and, with moveSelection, sets the selection at the start of the heading. This is a selection-only transaction: no undo step and no repagination. Focus stays in the outline.
  - Test hooks: data-page, data-page-type, data-entry, data-depth.
- OutlinePanel.tsx: `OutlinePanel({ editor, tracker, returnFocusRef?, id? = 'hb-outline-panel', className? })`. A left Drawer wired to the UI store panel 'outline' (open state and size, PANEL_LIMITS), titled "Outline", with the resize label "Resize outline" and the close label "Close outline". The panel is closed by default in the UI store.
- outlineModel.ts: buildOutline(doc) → OutlinePage[] { index, number, id 'p{n}', pos, pageType, label, entries: OutlineEntry[] { kind 'heading'|'block', id, pos, depth 1-7, text, nodeType } }.
  - Upstream's rules: a page containing frontCover, insideCover, partCover, backCover or a toc is a top-level page, labelled "Page N - Cover: <first h1>" / "Cover Page", "Interior: …" / "Interior Cover Page", "Section: …" / "Section Cover Page", "Back: …" / "Rear Cover Page", "Table of Contents"; its headings are not listed. The first type in that order wins.
  - A page type is detected from markers, page-object classes, node classes, span-mark classes and toc nodes, but not from the page's own classes.
  - Other pages list their direct blocks that have an id (headings by level, others at depth 7) and nested h2s.
  - Also exports: topLevelPageType, TOP_LEVEL_PAGE_TYPES, firstLine, shortLabel (upstream's 40-character trim; the panel shows the full first line with a CSS ellipsis instead), nodeText, sameOutline, findBlockById.
- useOutline.ts: useOutline(editor, delayMs = OUTLINE_DELAY_MS 150) and createOutlineStore(editor, delayMs).
  - Rebuilt at most every 150 ms while the document changes. The store listens only while subscribed.
  - It keeps the same snapshot (with fresh positions) when only positions moved, so typing doesn't re-render the panel.

PAGE NAVIGATION (web/src/editor/ui/pageNav)
- pageTracker.ts: createPageTracker({ viewport: () => el, root: () => el, margin? = 16 }) → PageTracker.
  - Methods: getState, subscribe, goToPage(n), goToNext(), goToPrevious(), scrollToElement(el), pageOf(el), refresh().
  - PageTrackingState { current, total, visible, atStart, atEnd }.
  - One IntersectionObserver (root = canvas viewport, thresholds every 5%) plus a MutationObserver on the pages root (pagination adds and removes pages). It observes only while subscribed.
  - Current page: the page with the largest share of itself in view, the first on a tie. The page made current by a jump stays current while it ties, so jumping to the last page at a small zoom shows that page. Observer entries timed before the jump don't undo it.
  - Next and previous move by rows, so a facing spread or a flow row counts as one step. Visible pages are those at least 30% in view (VISIBLE_RATIO).
- scrollCanvas.ts: canvasScrollTarget(viewport, target, margin) and scrollCanvasTo(viewport, target, { margin, behavior }). They compute from bounding rects, which include the canvas transform, so any zoom works. The result is clamped to the scroll range; a target off-screen horizontally is centred.
- usePageTracker.ts: usePageTracker(handle: EditorCanvasHandle | null, { margin? }) creates one tracker per canvas (useMemo, no side effects until subscribed); share it between PageNav and Outline. usePageTracking(tracker) returns the state through useSyncExternalStore.
- PageNav.tsx: `PageNav({ tracker, label? = 'Pages', className?, 'data-testid'? = 'page-nav' })`. A ToolbarGroup to put inside the editor's Toolbar.
  - Contents: Previous page, the "Current page" text box (described as "of N pages"), "/ N", Next page.
  - Previous/Next use aria-disabled at the ends, so focus stays on them.
  - In the text box: digits only; Enter or blur jumps (clamped); Escape restores; ArrowUp/Down go to the previous or next page; ArrowLeft at the start and ArrowRight at the end move to the Previous and Next buttons (the Toolbar leaves arrow keys to text inputs).
  - Test ids: page-prev, page-input, page-total, page-next.

DEV PAGE /dev/panels (web/src/dev/panels)
- Query parameters: theme, zoom, spread, doc=panels|long, paginate=1 (off by default, so the 12 hand-laid pages stay fixed), role=owner|author|invited and lock=1|review (the fixture brew), edit=<editId> (a real brew from the API; the Save button then PUTs the dialog's meta).
- It sets the TipTap root's aria-label to "Brew pages" itself (see notes).
- Test ids: toggle-outline, open-properties, save-meta, save-status, meta-field, meta-count, meta-payload, deleted, theme-select, zoom-select, spread-select, role-select.
- window.__hbPanels = { editor, handle, tracker, changes }. panelDocs.ts exports panelsDoc, longDoc, text, LONG_HEADING and PANEL_TEST_IDS.

E2E (web/e2e/panels, port 5324)
- navigation.spec.ts: labels; page and heading clicks at 50/100/200 % zoom land at the viewport top; the current page follows programmatic and wheel scrolling; prev/next/jump; facing spreads; keyboard; outline follows edits; drawer close/resize; axe (light and dark).
- metadata.spec.ts (stubbed API): every field's payload, the upstream messages, Escape order and focus return, read-only authors, lock review, delete, and axe with the dialog, both lists and the confirm dialog open, in light and dark.
- metadata-api.spec.ts (real API; skipped without HB_API_URL): registers a user, creates a meta:theme brew, and checks that it is listed under "My themes", that choosing it saves through PUT (server-validated), and that an unknown invited handle's 400 lands on the invite field.
- helpers.ts: openPanels, offsetInViewport, expectCurrentPage, viewportBox, axeViolations, STUB_THEMES.
- vite.isolated.config.mjs: the Vite config with HMR and file watching off, and its own cacheDir (node_modules/.vite-isolated-panels) so its different config hash doesn't re-optimize the shared node_modules/.vite under other dev servers. Other agents' saves were reloading or breaking the page mid-test.
  - Start it: `npx vite --config e2e/panels/vite.isolated.config.mjs --port 5324 --strictPort`.
  - Then: `E2E_PORT=5324 E2E_BASE_URL=http://localhost:5324 npx playwright test e2e/panels`.

### Notes for later phases
- Shell / edit page (P7): put `<OutlinePanel>` before `<SplitMain>` in the editor's SplitPanel. Give the outline toggle button `aria-controls="hb-outline-panel"` and pass it as `returnFocusRef`. Put `<PageNav tracker={tracker}>` in the editor Toolbar. `const tracker = usePageTracker(handle)`, where the handle comes from EditorCanvas onReady.
- Canvas / shell lane: TipTap gives the editor root role="textbox" without a name, which axe reports as aria-input-field-name (serious). /dev/panels works around it by setting aria-label="Brew pages" on editor.view.dom after onReady; ProseMirror leaves attributes it doesn't manage alone. EditorCanvas should name the root itself, for example with `editorProps: { attributes: { 'aria-label': … } }` in its useEditor options.
- Autosave lane (P3.8): see "Autosave wiring" in Interfaces.
- Backend: inline validation of invited handles needs a lookup endpoint (see the backend follow-ups section). Today an unknown handle shows only after a save, as errors['meta.authors'] on the invite field.
- Firefox e2e on a loaded machine: run `--project=firefox --workers=1` (or E2E_WORKERS=1). With several parallel workers, Firefox content processes stalled for minutes in page.goto and mid-test, with no page snapshot and GFX compositor errors in the log. The same tests passed with one worker.
- Upstream parity:
  - Renderer choice: dropped (V3 only).
  - Delete: one danger ConfirmDialog instead of two confirm() prompts.
  - Tag canonicalisation: the overwrite bug is fixed (upstream turned '5.5e' back into '5.5e').
  - Curated suggestions that contain a second colon ('system:Vampire: The Masquerade') can be added now; upstream dropped them silently.
  - Page navigation: the current page is the page most in view, not the one crossing the middle, and previous/next step by rows.
- No packages were added.
- Process note: before the isolated config had its own cacheDir, starting it (about 04:45, 05:03, 05:14 and 06:15 local time) re-optimized the shared web/node_modules/.vite dependency cache. Other lanes' Vite dev servers may have reloaded once at those times.
- Process note: my private API ran on :5424 (built with --artifacts-path to a temp folder) and was stopped by its listening PID only. The metadata-api test users are e2e-panels-*@example.com, with their brews, in the compose database.


## Snippets, Insert menu, theme-block labels, live TOC (phase 3, P5.1, P5.2, P5.4; plan §6.3–§6.5)

### Interfaces
SNIPPETS (web/src/editor/snippets; import from '@/editor/snippets'):
- Theme snippet modules: `STATIC_SNIPPET_LOADERS` ("V3_<key>" → lazy loader, from `import.meta.glob('@themes/V3/*/snippets.js')`: V3_Blank, V3_5ePHB, V3_5eDMG, V3_Journal; UnearthedArcana has none), `hasStaticSnippets(ref)`, `loadStaticSnippets(ref)` ([] for unknown and Legacy_ ids). Each module is its own chunk.
- Compiling (port of snippetbar.jsx:127-155): `compileSnippets({ refs, staticGroups, userSnippets?, brewTitle? })` → ThemeSnippetGroup[] (pure); `loadSnippetGroups({ refs, userSnippets?, brewTitle? })` (async); `mergeSnippetGroups(compiled, child)`; `mergeSnippetLists(parent, child)` (upstream's mergeCustomizer: the parent's snippets the child doesn't override come first, then the child's; entries with neither gen nor subsnippets are dropped); `staticSnippetIds(refs)`; `groupsForView(groups, 'text' | 'style')`. `refs` is the theme bundle's `snippets` (ThemeChain.snippets, root first).
- React: `useSnippetGroups(refs, userSnippets?, brewTitle?)` → `{ status: 'loading'|'ready'|'error', groups, error }`. Memoize `refs`: pass `status.chain.snippets` from EditorCanvas's ready status, or `useThemeBundle(theme).data?.snippets`.
- User snippets: `parseUserSnippets(value, defaultGroup?)` → `UserSnippet[] { group?, name, gen }`. It accepts three forms: the `\snippet name` text form, upstream's stored `[{ name, subsnippets: [{ name, gen }] }]`, and the plan's flat `[{ group?, name, gen }]`. `userSnippetGroup(brewTitle, brewSnippets, themeRefs)` → the "Brew Snippets" group, or null. It holds one submenu per user theme with snippets, then the brew's own snippets under the brew title ("New Document" when untitled). Constants `USER_SNIPPETS_GROUP`, `USER_SNIPPETS_ICON`, `UNTITLED_BREW`.
- Menu model: `snippetSections(groups)` → `SnippetSection[] { id, path, label, entries }`. There is one section per group and per submenu trail. As upstream, a snippet with subsnippets is only a submenu: its own generator is not offered. `SnippetEntry { id, name, icon, path, view, gen, native, hint, experimental, disabled }`. `filterSections(sections, query)` matches every word, ignoring case and accents, in the name or the path. Also `findSnippet(sections, path)`, `pathLabel`, `PATH_SEPARATOR` (' › ').
- Generators: `runSnippetGenerator(name, gen, context)` (throws `SnippetGeneratorError`) and `snippetContext(brew?, view?)` → `SnippetContext { brew: { shareId?, title?, theme?, lang?, renderer: 'V3' }, cursorPos, view }`. This is upstream's shape. The QR Code generator reads `.shareId` from the context itself, which upstream never set either, so its link goes to the home page there and here.
- Native snippets:
  - `NativeSnippetAction` is one of `{ kind: 'toc' }`, `{ kind: 'footer', level }`, `{ kind: 'pageNumber' }`, `{ kind: 'marker', marker: 'skipCounting'|'resetCounting' }` or `{ kind: 'pageBreak' }`.
  - `nativeActionOf(gen)` recognises two things: shim generators, which carry `__hbNativeSnippet`, and whole-snippet markdown listed in `NATIVE_MARKDOWN` (`{{pageNumber,auto}}`, `{{pageNumber $[HB_pageNumber]}}`, `{{skipCounting}}`, `{{resetCounting}}`, `\page`). This covers user snippets too.
  - Also `nativeGenerator(action, fallbackMarkdown)` and `describeNativeAction(action)`.
  - `{{pageNumber 1}}`, a fixed number, stays markdown and becomes a text page object.
- Transactions: each builds one transaction and closes the history first, so it is one undo step. They are pure ProseMirror.
  - `insertFragment(tr, fragment)`, `insertBlocksTr(state, snippetPage)`, `insertPagesTr(state, pages)` → `{ tr, count } | null`, `mergeLiftedPageAttrs(tr, snippetPage)`.
  - `nativeActionTr(state, action)` and `insertTocTr(state, attrs?)` (`INSERTED_TOC_ATTRS` = depth 6, wide, 'Contents').
  - `footerFromHeadingTr(state, level)`, `footerTextBefore(doc, pos, level)`, `pageNumberTr`, `pageMarkerTr(state, marker)`, `pageBreakTr`. The page is the head's, clamped with pageIndexAt (with everything selected (Mod-A) the head is after the last page: that page; UI-4); insertPagesTr and mergeLiftedPageAttrs do the same. The footer and page-number actions use the pagination-UX lane's `setSectionAttrs` (commands/sections.ts); `pageBreakTr` is its `insertPageBreak`, with the history closed first.
- Pipeline:
  - `snippetToDoc(markdown, { theme, lang?, probe?, themeOptions?, fontsTimeoutMs? })` → `SnippetDoc { pages, style, pageSnippet }`. It runs hbfmToDoc: the import lane's renderer (no marked-variables), sanitizer, markMultilineDefinitionLists and lifting.
  - `applySnippetDoc(editor, doc)`.
  - `insertSnippet(editor, markdown, options)` → `InsertSnippetResult { kind: 'blocks'|'pages'|'nothing', pages, style }`.
  - Also `pagesFromJson(schema, json)` and `PAGE_LINE`.
- Engine per editor: `createSnippetInserter(editor, { theme: () => string, brew?, lang?, themeOptions?, onStyle?, probe? })` → `SnippetInserter { insert(entry), insertMarkdown(md, name?), runNative(action, name?), prewarm(), busy, dispose() }`. Each call returns `SnippetOutcome { kind: 'blocks'|'pages'|'nothing'|'native', message, style }`.
  - Insertions run one at a time (a queue). `insert` never throws synchronously: a failing native action comes back as a rejected promise (the Insert menu's busy state ends either way; UI-4).
  - The layout probe iframe is kept between insertions (`createProbeCache(themeOptions?)`) and re-created when the theme, CSS or language changes.
  - The first insertion takes about 0.5 s (probe and theme), later ones about 0.1 s.
- Section helpers (transaction level, used for lifted attributes):
  - `sectionBounds(doc, index)`, `pagePos(doc, index)`.
  - `setSectionAttrs(tr, index, attrs)` writes every page of the section, in the history.
  - `addPageMarkers(tr, index, markers)` (setPageAttr: its undo survives pagination on an auto page), `isBlankPage(page)`, `hasEmptyFlow(page)`, `isReplaceablePage(page)` (empty flow, no markers, objects, id or attributes; section settings allowed).
- Style view: `generateStyleSnippet(entry, brew?)` returns the CSS. `insertStyleSnippet(css, snippet, range?)` → `{ css, cursor }` inserts it at the end in its own paragraph, or in place of a range.
- Shims:
  - `web/src/editor/snippets/shims/footer.gen.ts`: `createFooterFunc(level)` is the native footer; its fallback is `{{footnote PART 1 | SECTION NAME}}` (`FOOTER_PLACEHOLDER`).
  - `shims/tableOfContents.gen.ts`: the native toc; its fallback `{{toc,wide # Contents}}` parses into a toc node too.

INSERTION RULES (insertSnippet.ts):
- A snippet with a `\page` line becomes new MANUAL pages after the current section (the current page and its auto pages).
  - It replaces the current page instead when that page is blank (isReplaceablePage: empty flow and no objects, markers, id or attributes; UI-3) and no auto page follows it. The current page's section settings carry over where the snippet sets none. A page with cover art or markers stays; the pages go after it.
  - Blank pages at the start are dropped. Blank pages at the end are dropped too, except when nothing follows the inserted pages: then one stays and takes the cursor (a cover's trailing `\page`, as upstream).
  - Otherwise the cursor goes to the first inserted page.
- Other snippets go in at the selection:
  - A single plain paragraph merges into the current textblock (links, spacers, inline boxes).
  - Blocks replace an empty paragraph or are inserted around the selection.
  - A selection across pages collapses to its head. Where nothing fits (e.g. a table in a table cell), the blocks go after the page's top-level block.
  - What the importer lifted goes to the current page (markers, objects with fresh ids) or to its section (footer, page number).
- The cursor ends after the snippet:
  - If the snippet ends with a block container (theme block, table, toc) and nothing follows the empty paragraph it went into, that paragraph stays after it for the cursor. So a second snippet doesn't nest into the first.
  - If text follows, the cursor goes to its start. Next to atoms it is a gap cursor.
- CSS that a text snippet carries (`<style>`) goes to `onStyle`.

VITE PLUGIN (web/vite/themeSnippetShims.ts, registered in vite.config.ts; outside my paths, see notes):
- `themeSnippetShims({ themesDir, shimsDir, forbidden? })` → two plugins: a resolver (enforce pre, every mode) and a bundle guard (build only).
- The resolver redirects two generator modules to the shims; themes/ stays unchanged:
  - `themes/V3/Blank/snippets/footer.gen.js` imports marked-hbfm and calls an undefined `Markdown`.
  - `tableOfContents.gen.js` reads upstream's preview iframe.
- The guard fails `vite build` when a chunk holds code (renderedLength > 0) from `FORBIDDEN_BUNDLE_PACKAGES` = marked-hbfm, marked-variables, expr-eval. With VITE_HB_DEV_ROUTES=1 it only warns, because the dev pages use marked-hbfm.
- Also exported: `THEME_SNIPPET_SHIMS`, `resolveThemeSnippetShim`, `forbiddenBundleModules(bundle, forbidden?)`, `BundleLike`.
- Tests: vite/themeSnippetShims.test.ts (node project). It includes real vite builds of a fake theme: with the shims applied the build passes; with the original generator the guard fails it.
- Verified on the real app: `npx vite build --outDir <temp>` passes the guard (no forbidden code). With VITE_HB_DEV_ROUTES=1 the guard warns about exactly one chunk, DevRoutes: the dev pages /dev/legacy-render and /dev/canvas?view=legacy use marked-hbfm. The snippet chunks carry none of these packages.

INSERT MENU (web/src/editor/ui/insertMenu; '@/editor/ui/insertMenu'):
- `<InsertMenu editor groups loading? theme lang? brew? themeOptions? onStyle? onInserted? disabled? className? data-testid?='insert-menu' />`:
  - Shows `groupsForView(groups, 'text')` and runs the inserter. The probe is prepared when the menu opens.
  - While inserting, the button shows a busy spinner. The outcome is announced in a polite live region (`data-testid="insert-menu-status"`); a failure raises an error toast. Focus goes back to the editor afterwards.
  - Disabled while the editor is read-only.
- `<SnippetPicker groups onPick label?='Insert' dialogLabel? busy? loading? disabled? onOpen? footer? className? data-testid? />`:
  - A Button (aria-haspopup=dialog, aria-expanded, aria-controls) opens a Popover (`<testid>-popover`).
  - The popover holds a search field (role combobox, aria-autocomplete list, aria-activedescendant) and a listbox named "Snippets". The listbox has groups (role group, labelled by the section path) of options (aria-selected, aria-disabled, `data-snippet` = path).
  - Keys in the search field: ArrowUp/Down (wrap), PageUp/PageDown (8), Ctrl/Cmd+Home/End, Enter picks, Escape closes (focus to the button), Tab leaves (Popover).
  - A status line counts the matches.
- For the Style drawer: `<SnippetPicker groups={groupsForView(groups, 'style')} label="Snippets" onPick={(e) => insertIntoCodeMirror(generateStyleSnippet(e, brew))} />`.
- The toolbar lane's EditorToolbar has an `insertMenu` slot for it.

THEME BLOCKS (web/src/editor/themeBlocks, '@/editor/themeBlocks'; plan §6.4):
- Extensions:
  - `ThemeBlockWithView`: ThemeBlock + NodeView + overlay plugin + Shift-Alt-F10.
  - `TocWithView`: Toc + TocView + refresher plugin.
  - `themeBlockNodeViews` = both. They are also in `editorNodeViews` (nodeviews/index.ts, an additive change), so every EditorCanvas has them.
- `ThemeBlockNodeView(node)`:
  - `dom` = `contentDOM` = div.block.<classes> with exactly renderHTML's attributes (`renderedAttrs(node)`).
  - So the block's children are its content only. Theme selectors such as `.monster hr ~ dl` and `:first-child` see upstream's structure; domContract.test.ts compares.
  - Attribute changes patch the element in place and keep the content DOM. Classes it doesn't own (ProseMirror-selectednode, decorations) are kept.
- Label overlay, API: `themeBlockOverlayPlugin()`; class `ThemeBlockOverlay` (store + actions); `themeBlockOverlayOf(view)`; `focusThemeBlockControls(view)`; `THEME_BLOCK_CONTROLS_KEY` = 'Shift-Alt-F10' (Alt-F10 is the toolbar's).
- Label overlay, rendering: the React component is `ThemeBlockControls` in web/src/editor/nodeviews/ThemeBlockView.tsx (+ ThemeBlockView.module.css). The plugin renders it in its own React root through the UI kit's Portal: outside the canvas, never inside the block. While hidden it isn't re-rendered.
- Label overlay, when shown:
  - The selection is in a theme block (the innermost one), or the block is node-selected.
  - The editor or the controls have focus.
  - Only in editable editors.
  - Position: above the block's top-left corner, or inside it when there is no room. It is hidden while that corner is scrolled out of the canvas viewport.
- Label overlay, content:
  - The label, from `themeBlockLabel(classes)`: Stat block, Note, Descriptive, Class table, Spell list, Quote, Artist, Rune table, Index, Credits, …; otherwise the humanized first class, "Wide block" or "Block".
  - A Wide toggle.
  - A Frame toggle for frameable blocks (`canFrame`: monster, classTable, runeTable, spellList, or already framed).
  - The toggles are aria-pressed buttons in a UI kit Toolbar named "<label> block".
- Label overlay, keyboard and pointer: pointer presses keep the editor's focus. Shift+Alt+F10 focuses the first toggle, arrows move, Escape or Tab returns to the editor. `data-testid="theme-block-controls"`.
- Commands: `toggleThemeBlockClassTr(state, pos, cls, on?)` is one setNodeAttribute step with the history closed: one undo step. Also `activeThemeBlockPos(state)`, `themeBlockAt(doc, pos)`, `blockClasses(node)`.
- Labels: `THEME_BLOCK_LABELS`, `FRAMEABLE_CLASSES`, `humanizeClass`.

LIVE TOC (web/src/editor/toc, '@/editor/toc'; NodeView web/src/editor/nodeviews/TocView.ts; plan §6.5):
- `tocEntries(doc, { depth, isExcluded? })` → `TocEntry[] { level, nest, text, href, page, pos }`.
  - Headings are taken in document order.
  - A heading is skipped when it is empty, deeper than depth, on a skipCounting page, or `isExcluded` (the theme's computed `--TOC: exclude`).
  - Page numbers follow upstream's mapPages: `pageNumbering(doc)` → `{ number, shown }[]`; a reset restarts at 1, a skip holds the count. Markers are read from page.markers, or from a node's classes or a span mark anywhere on the page.
  - Nesting follows upstream's depth chain: level 0 is wrapped in h3, level 1 in h4.
  - `href` = '#<heading id>' ('#p<n>' when the heading has no id).
  - Also `collectHeadings(doc)`, `tocTree(entries)`, `tocKeyword(value)`.
- Markup: `tocInnerHtml(title, entries)`, `tocHtml({ title, wide, depth }, entries)` (static export), `tocClass(wide)`, `escapeHtml`, `entryWrapper(nest)`. The output is byte-identical to what the HBFM renderer makes of upstream's generator markdown (unit test), except that the TOC's own headings have no ids.
- Refresh:
  - API: `tocPlugin()` (key `tocPluginKey`; counts author edits and REPAGINATE restyles), `registerToc/unregisterToc(view, target)`, `scheduleTocRefresh(view)` (microtask), `refreshTocs(view)` → number of tocs changed, `isExcludedByTheme(view, heading)`, `tocTargets(view)`, `MAX_TOC_REPAGINATIONS` = 3.
  - A refresh runs after pagination settles (stats.settles changed), after document changes when there is no pagination plugin, and after REPAGINATE (theme, CSS, fonts).
  - A toc already shown with the theme's exclusions waits while pagination is busy.
  - When a toc's height changes, it calls `repaginate(view, itsPage)`, at most 3 times in a row without an author edit.
- `TocView(node, view)`:
  - div.block.toc[.wide][data-depth][contenteditable=false], with `data-toc-entries` (TOC_ENTRIES_ATTR) = the entry count.
  - It ignores its own DOM mutations and re-renders only when the markup changes.
  - A click on an entry (or Enter on a focused link) runs `navigateToTarget(view, href)`: the cursor goes to the heading, the heading scrolls to the top and the editor gets focus. The href's id is matched literally first (ids may hold '%'), then percent-decoded as a fallback (pasted or legacy hrefs); '#p<n>' is a page (UI-12).

DEV PAGE /dev/snippets[?theme=5ePHB&doc=empty|blocks|toc] (web/src/dev/snippets):
- The InsertMenu on a paginated EditorCanvas: paginatedExtensions, eager images, pages on the /dev/legacy-render pixel grid, natural height. It has one user snippet ("Tavern Note").
- The frame has data-theme-status, data-settled and data-snippets-status.
- `window.__hbSnippets: SnippetsDevApi` = { editor, ready(), settled(), entries(view), rawEntries(theme), generate(theme, group, names, seed?), runRawNative, insertMarkdown, insertEntry(path), dropCursorLine(), reset(doc?), loadMarkdown(md), setUserCss, userCss(), appendStyleSnippet, prepareScreenshot(), tocRows(), overlay(), cssApplied(), outcomes }. `generate` reseeds with window.__hbReseed when that exists.
- devDocs.ts: empty; blocks (a stat block and a note); toc (5 pages: an excluded stat-block heading and an h4, a skipCounting page, a resetCounting page).

E2E (web/e2e/snippets, port 5327; helpers.ts):
- snippetFidelity.spec.ts: the P5.1 "Done when".
  - What it compares: every snippet fixture (149) against /dev/legacy-render, page by page with pixelmatch; 2% per page and the same number of manual pages.
  - Generators run in the browser with the fixture script's seeded Math.random (an init script replaces it before lodash loads). Their output must equal the fixture text, with location.origin removed.
  - Strings that theme modules build at load time can't be replayed (the monster and class-table blocks and the watercolor masks draw random values then). Their fixture text goes through the same pipeline.
  - Native snippets run their command. Style snippets import the sample body and add the generated CSS.
  - The empty paragraph left for the cursor is removed before comparing.
  - Upstream page i is compared with the editor's i-th manual page. Auto pages are allowed only when upstream's page overflowed (upstream clipped the content; the editor paginates it).
  - `KNOWN` holds ceilings for causes outside the snippet pipeline.
  - The default run has an 11-fixture smoke (the first fixture of every theme and group). SNIPPET_FIDELITY=all runs every fixture as 25 short tests of up to 8 (at most ~22 s each in Firefox); CI's snippet-fidelity job runs that on every push, 2 shards per browser.
  - SNIPPET_FILTER=<regex> limits the fixtures (and selects the full chunks). There is one JSON per fixture in test-results/<port>/snippet-fidelity/<project>.
- themeBlocks.spec.ts, toc.spec.ts, insertMenu.spec.ts: behaviour, undo, keyboard and axe.
- Result (5ePHB, all 149 snippet fixtures, per browser):
  - Firefox: 148 are under 2% with matching page counts; 110 of them are pixel-identical. The ORC notice is the known 2.67%.
  - Chromium: 148 as well, plus the known ORC notice (2.89%).
  - Highest diff of a passing fixture: 1.42% (Chromium), 1.29% (Firefox).
  - Three fixtures overflow their page upstream; the editor puts the rest on an auto page (see below).
  - Every replayable generator produced exactly its fixture text in both browsers.
  - One Chromium run had the watercolor splatter at 2.48%: its CSS mask image had not loaded yet. Both sides now wait for CSS mask, background and border images before the screenshot (`settleCssImages`); the Images group is at 0% since.
  - Durations on this loaded machine: Chromium about 7–10 min (5 workers), Firefox about 25 min (4 workers).
- themeBlocks.spec.ts (5 tests), toc.spec.ts (5 tests) and insertMenu.spec.ts (8 tests) pass in Chromium and Firefox.

### Notes for later phases
- Changes outside my paths, all additive:
  - web/vite/themeSnippetShims.ts and its test: new files.
  - web/vite.config.ts: an import and a `...themeSnippetShims({ themesDir, shimsDir })` entry in `plugins`.
  - web/src/editor/nodeviews/index.ts: `editorNodeViews` also holds ThemeBlockWithView and TocWithView.
  - Also new, beside my paths: web/src/editor/nodeviews/ThemeBlockView.module.css.
- Shell / editor page lane:
  - Put `<InsertMenu editor groups={useSnippetGroups(chain?.snippets, brew.snippets, brew.title).groups} theme={brew.theme} brew={{ shareId, title, theme, lang }} onStyle={appendToBrewStyle} />` into EditorToolbar's `insertMenu` slot.
  - `chain` comes from EditorCanvas's ready `onStatusChange`.
  - `onStyle` receives CSS from `<style>` tags in a snippet. Appending it to the style is outside the document's undo history.
- Style drawer (inspector lane): `SnippetPicker` with `groupsForView(groups, 'style')` and `generateStyleSnippet(entry, brew)`, inserted at the CodeMirror cursor. Upstream's "Style Editor" and "Print" groups are style view.
- Keyboard map (toolbar lane): Shift+Alt+F10 focuses the theme-block toggles; the toolbar keeps Alt+F10. The shortcut list (commands/keymap.ts) could mention it.
- Page markers (pagination-UX lane):
  - Skip/Restart numbering adds the marker to the cursor's page, as upstream.
  - On an auto page the marker lives on a page that pagination may join away, and an attribute step on such a page is dropped from the history (see commands/sections.ts removeSectionBreak).
  - The page settings UI may want to make such a page a section start first.
- Schema / import owners: imported TOCs (`{{toc,wide …}}`) get the schema default depth 3. Upstream's generator had no depth limit (the theme's --TOC and the tocDepthH4… wrappers decide). The Insert menu inserts depth 6. Consider a parse default of 6.
- Export (P6.4): fill toc nodes with `tocHtml(attrs, tocEntries(doc, { depth, isExcluded }))`, with `isExcluded` reading the computed --TOC in the export probe.
- Fidelity findings:
  - Clipped upstream: three fixtures overflow their page upstream and are clipped there (AELF license, True20 OGL section 15, the Card page size sample). The editor paginates the rest onto an auto page; the spec expects that.
  - Class tables and GNU FDL: they failed in the S3 import report but are at 0% here now, so other lanes fixed the tbody header rows and the dt trailing break.
  - ORC notice: still 2.9% (empty <dt> trailing break) in Chromium; kept in KNOWN.
- Environment and process findings:
  - Two Playwright runs with the same E2E_PORT clean each other's test-results/<port> at start-up, so results written by the first run disappear. Run one at a time per port.
  - Editing a file the dev server serves (a dev page) during a run breaks lazy route loading. The page then shows "This page could not be loaded".
  - Agents share the session scratchpad directory. Use unique file names.
- Flaky, not mine: src/dev/registry.test.tsx (findByRole's 1 s default) timed out under load, as noted before; it passes alone.
- No packages were added. No git commands were run.


## Inspector and Style drawer (P3.5, P3.6, plan §6.2)

### Interfaces
COMMANDS (web/src/editor/commands/attrs.ts): validated attribute edits, each ONE transaction and ONE undo step (closeHistory; meta `INSPECTOR_META = 'hbInspector'`). Node attributes change only through AttrSteps (writeNodeAttr → tr.setNodeAttribute; on a page, objects/pageAttrStep.ts `setPageAttr`: a PageAttrStep on an auto page, so markers, objects and page attributes keep their undo through pagination's boundary moves, UI-1).
- Results: `Validation<T> = { ok: true; value } | { ok: false; error }`; `EditResult = { ok: true; changed } | { ok: false; error }` (an error dispatches nothing); `Dispatch`.
- Edit commands, all `(state, dispatch?, …) → EditResult`:
  - generic (node or span mark): `addClasses(target, text)`, `editClasses(target, list)`, `removeClass(target, name)`, `editStyle(target, input, doc?)`, `editId(target, input)`, `setAttribute(target, name, value, previousName?)`, `removeAttribute(target, name)`. `EditTarget = { kind: 'node'; pos } | { kind: 'mark'; from; to; mark }`.
  - page: `editSection(index, { columns?, pageNumber?, footer?, classes?, style? })`, `addSectionClasses(index, text)`, `editMarkers(index, markers)`, `editPageObject(index, id, { classes?, style? })`, `addPageObjectClasses(index, id, text)`. Page attributes go through setAttribute with the page's node target.
- Validators (they mirror DocInspector/CssPolicy and the schema):
  - `validateClassName`: reserved and editor classes are refused; whitespace includes U+0085 (.NET's char.IsWhiteSpace; UI-11); a leading dot is dropped; "a:b" → "use the Style field", "#x" → "use the Id field". `parseClassInput` (spaces, commas or dots separate names), `validateClassList`.
  - `validateStyle(input, doc?)` → the normalizeStyle() form or null. It refuses braces and selectors, script-capable CSS (`isUnsafeCss`, `decodeCss`: a port of CssPolicy's string-aware tokenizer, so a comment start inside a string is text; expression/behavior/-moz-binding count outside strings, javascript:/vbscript: anywhere; tested with the server's CssPolicyTests cases, UI-11), more than 4096 characters, and every declaration the browser drops (named in the error). `splitDeclarations`.
  - `validateId(input, doc, isOwn?)`: no spaces, not p1…pN for any n, unique against node, heading and span ids (`collectIds`).
  - `validateAttributeName(name, type?)`: SAFE_ATTR, lower-cased, not RESERVED_ATTRS, not the node's own attribute. `validateAttributeValue`.
  - `validateFooter` (one line, at most 500 characters), `validateColumns` (1 | 2 | null).
- Helpers:
  - `writeNodeAttr`; `setNodeAttrs(tr, pos, attrs)`: shared attributes go to every fragment of a split block, `id`/`customId` to the first (fragmentChain).
  - `markRangeAt(doc, pos, mark)`, `setMarkAttrs(tr, range, attrs)`.
  - `sectionRange(doc, index)`, `sectionSettings(doc, index)`, `writeSectionAttrs(tr, index, attrs)` (the section's first page only).
  - `genericValues(state, target)`, `targetType`, `applyEdit(state, dispatch, build)`.
  - Markers: `COVER_MARKERS`, `COUNTING_MARKERS`, `coverOf`, `withCover`, `withMarker`.
  - Limits: MAX_CLASS_LENGTH 256, MAX_STYLE_LENGTH 4096, MAX_ID_LENGTH 256, MAX_FOOTER_LENGTH 500, MAX_ATTRIBUTE_VALUE_LENGTH 4096.
- Headings: setting an id makes it the author's (customId true). Clearing it (or "Use generated id") hands it back to the HeadingIds plugin: customId false, generated slug.
- Section settings are written to the section's manual page only. The pagination lane's section sync (pagination/sections.ts, part of the Pagination extension) copies them to the auto pages outside the history. So an edit and its undo are one step each, and pagination re-checks from the page before the section's first page.

INSPECTOR (web/src/editor/ui/inspector; import from '@/editor/ui/inspector')
- `<Inspector editor classSuggestions? onSelectObject? className? data-testid? />` (memoized). Content only: tabs "Element" and "Page" (the tab persists in the UI store's `inspectorTab`: 'node' | 'page'), plus a polite live region (`inspector-announcer`) that reads refused edits aloud. In a read-only editor every field is disabled (fieldset disabled; the breadcrumbs and the objects list still work) and edits are refused; it follows editor.setEditable.
  - Element tab: breadcrumbs (`nav` "Element path", buttons with aria-current) of the inspectable ancestors (HB_ATTR_TYPES, page excluded) and of the span marks around the selection. The innermost is inspected unless a breadcrumb pins an ancestor. The pin follows the node through transactions and is dropped when the selection leaves it.
  - Element fields: Classes (chips with "Remove class X" buttons, and a combobox "Add class" with suggestions; Enter adds the typed names or the highlighted suggestion); Style (multi-line; Ctrl/Cmd+Enter or leaving the field applies; Escape reverts); Id (Enter or leaving applies; headings show "Use generated id"); Attributes (values are edited in place; Name + Value + "Add attribute"; "Remove attribute X").
  - Page tab: "Page n of N", the section it belongs to, and its #p{n} link.
    - Section: Columns select (Theme default / 1 / 2), "Page numbers" switch, Footer, Section classes, Section style.
    - This page: Cover select (none, front, inside, part, back), "Skip this page when counting", "Restart page numbers here", page Attributes.
    - Objects: the page's objects. Selecting one calls onSelectObject and shows its classes and style fields.
  - Drafts: typing changes only a draft. Fields are keyed by the inspected element (InspectorSnapshot.targetId): when positions move, a draft is kept; when another element is selected, it is dropped. An edit applies to the element as it is at commit time (resolved again from the state). If another element became the target in the meantime, the edit is refused ("The selection changed…").
- `<InspectorPanel editor returnFocusRef? id? = 'hb-inspector-panel' className? …InspectorProps />`: a right Drawer titled "Inspector", wired to the UI store panel 'inspector' (open state and width, PANEL_LIMITS). Close label "Close inspector", resize label "Resize inspector", test id inspector-panel. It shows a spinner while `editor` is null. Place it after <SplitMain>.
- Model (model.ts):
  - `resolveChain(state) → ResolvedItem[]`: { key 'n<depth>:<type>' | 'm<i>', kind, type, label, values, customId, continued, target }.
  - `resolvePage(state) → PageInfo`: { index, count, pid, kind, section { start, end, settings }, markers, attributes, objects: ObjectInfo[] }.
  - `targetIndex`, `mapPin`, `pinOf`, `typeLabel`.
  - `InspectorStore(editor)`, a useSyncExternalStore source: `subscribe`, `getSnapshot` → InspectorSnapshot { chain, targetKey, targetId, page }, `target()`, `select(key)`. The snapshot is replaced only when its content changes, so pagination transactions that only move positions re-render nothing.
- Class suggestions (classNames.ts): the toolbar lane's `collectThemeClasses`, cached per set of stylesheet objects (`themeClasses(doc?)`), ranked by its `suggestClasses` ('span' mode for span marks and page objects, 'themeBlock' otherwise), then the classes the document already uses (`documentClassNames`). Also `rankClassSuggestions`, `filterClassSuggestions` (used for a plain `classSuggestions` list), `ClassSuggester`, `MAX_CLASS_SUGGESTIONS` = 50.
- Objects (objectFocus.ts): `focusPageObject(editor, { pageIndex, id })` is the default "select".
  - With the objects lane's PageObjects extension, it runs objects/commands `selectObject` and focuses the layer's selection frame (`objectLayerOf(editor).focusFrame()`).
  - Without it, it scrolls the element into view and focuses it if it has a tabindex.
  - Either way it then dispatches `OBJECT_SELECT_EVENT = 'hb:select-object'` (a bubbling CustomEvent<PageObjectRef>) on the object element. Also `pageObjectElement(editor, ref)`.

STYLE DRAWER (web/src/editor/ui/styleDrawer; import from '@/editor/ui/styleDrawer')
- `<StyleDrawer value onChange snippets? classNames? readOnly? className? data-testid? ref? />`
  - Layout: a "Style tools" toolbar (Format button, then the snippet slot), the CodeMirror editor (textbox "Brew CSS", described by the key hint), and a status line (role status, test id style-status).
  - Controlled: pass `value` on to EditorCanvas `userCss` unchanged. The canvas debounces it (userCssDelayMs 150) and repaginates after applying it.
  - `ref` → StyleEditorHandle { view, insert, focus, getValue, format }.
  - Snippet slot: `snippets` is a ReactNode or `(api: StyleEditorApi) => ReactNode`. `StyleEditorApi = { insert(text), focus(), getValue() }`; insert replaces the selection as one undo step and focuses the editor. The snippets lane renders its Style-view menu there.
- `<StylePanel side? = 'left' returnFocusRef? id? = 'hb-style-panel' className? …StyleDrawerProps />`: a Drawer titled "Style", wired to the UI store panel 'style'. Close label "Close style drawer", resize label "Resize style drawer", test id style-panel.
- `<StyleEditor value onChange label? = 'Brew CSS' describedBy? classNames? onFormat? readOnly? … />`
  - CodeMirror 6 with css(), line numbers, folding, history, bracket matching and closing, search, autocompletion (lang-css, plus theme class names after "." in selectors: classCompletion.ts `classNameCompletion`, `inSelector`), and line wrapping.
  - It follows the UI colour scheme (`useResolvedScheme`: the nearest UiRoot, with 'system' read from prefers-color-scheme). `styleEditorTheme(dark)` uses the --hbui-* tokens; `styleHighlight` reads the --hb-css-* colours that StyleDrawer.module.css sets (AA contrast in both schemes).
  - A `value` the editor itself reported (even an older one that renders late) never overwrites newer text. Any other value replaces the text outside the undo history.
- Keys (cssKeymap.ts, ported from legacy customKeyMaps.js):
  - `cssKeymap(format)` (Prec.highest): Mod-Shift-F and Alt-Shift-F format the selection, or everything.
  - `generalKeymap`: Tab = insertTab (indents a selection), Shift-Tab outdents, Mod-Z, Mod-Shift-Z, Mod-Y, Mod-D deletes the line.
  - Escape then Tab leaves the editor (CodeMirror tab-focus mode).
- Formatting (formatCss.ts, formatView.ts):
  - `loadPrettier()` imports prettier/standalone and prettier/plugins/postcss on first use (a separate chunk). The Format button preloads it on hover and focus.
  - `formatCss(code)`: legacy options, then `collapseSingleDeclarationRules`. `CssFormatError { line, column }`, `minimalChange(before, after)`.
  - `formatView(view) → FormatOutcome` ('formatted' | 'unchanged' | 'stale' | 'error' | 'unavailable'): one undo step (isolateHistory). Nothing is applied when the text changed while Prettier ran.
  - `PRETTIER_CSS_OPTIONS`, `FORMAT_SHORTCUT`, `FORMAT_KEYSHORTCUTS`.

DEV PAGE /dev/inspector[?theme=5ePHB|5eDMG|Blank|Journal&scheme=system|light|dark] (web/src/dev/inspector)
- EditorCanvas with Pagination and PageObjects, StylePanel on the left (with demo snippets, test id style-snippets), and InspectorPanel on the right, both wired to the real UI store. route.tsx loads the page lazily (LazyInspectorDevPage), so the dev registry's eager imports don't pull in CodeMirror.
- Test ids: toggle-style, toggle-inspector, theme-select, scheme-select, canvas-status, repaginate-count. The frame carries data-theme-status.
- `window.__hbInspector = { editor, handle, style(), repaginations, selectedObjects (OBJECT_SELECT_EVENT log), selectedObject() (the objects lane's), settled(), lastCssEdit (performance.now() of the last CSS edit) }`.
- The document (devDoc.ts `inspectorDoc`, `INSPECTOR_TEST_IDS`) has two sections, a note, a stat block with a table, a list, a span and two page objects. Blocks carry data-testid attributes.

E2E (web/e2e/inspector, port 5323): inspector.spec.ts (11 tests) and style.spec.ts (6 tests), in Chromium and Firefox.
- Inspector: a theme suggestion reaches the canvas, and Ctrl+Z/Ctrl+Y in the canvas undo and redo it; refused input (inline error, announcement, unchanged document); breadcrumb pins; attributes and ids in the DOM; section columns and section style repaginate with no page overflowing and one undo step; page numbers and footer on every page of the section; markers; the objects list (objects lane selection and frame focus, object classes and style); keyboard-only operation.
- Style drawer: typed CSS restyles the canvas (the median of five edits is under 300 ms and none is over 600 ms, measured from the edit the drawer reports to the frame where the computed style changed), followed by the 'css' repagination; Prettier via keys and button (one undo step, selection only, syntax errors); the snippet slot; theme class completion; Esc then Tab.
- axe on the app chrome only (`.hb-canvas` excluded), with suggestions, errors and completion open, in light and dark.

### Notes for later phases
- Shell / editor page lane: mount `<StylePanel value={css} onChange={setCss} snippets={…} />` before `<SplitMain>` and `<InspectorPanel editor={editor} />` after it, and pass the same `css` to EditorCanvas `userCss`. Give each panel toggle aria-expanded, and aria-controls only while the panel is open (a closed drawer is unmounted). In a read-only editor the Inspector disables its fields (it follows editor.setEditable).
- Snippets lane: render the Style-view snippet menu through StyleDrawer `snippets={(api) => …}` and insert with `api.insert(text)`. That is one undo step in the CSS editor, and the canvas picks the change up like typing.
- Measured CSS apply times (edit → computed style): Chromium 110–230 ms; Firefox 80–300 ms, with outliers up to about 470 ms under heavy parallel load. 150 ms of that is EditorCanvas's userCssDelayMs. The rest is scoping, adopting the sheet and Firefox's style recalculation of all pages. If the budget must hold for every single edit under load, lower userCssDelayMs (a host prop) rather than changing the drawer.
- Class picker: the inspector reuses collectThemeClasses and suggestClasses, but not the modal ClassPicker, because inline chips suit a side panel. The picker's NON_AUTHOR_CLASSES (markers, pageNumber, footnote, …) are therefore not suggested for section classes either; markers have their own controls.
- Span marks: editing a span's attributes replaces the mark (RemoveMarkStep + AddMarkStep). With nested spans of the same type, the edited span becomes the innermost of the set (ProseMirror orders marks of one type by insertion). A span split across pages is edited per fragment (the range stays inside one textblock).
- The page `id` is not editable (PageIndexIds renders p{n}); the Page tab shows the #p{n} link instead. Page attributes belong to one page and are not copied to auto pages (autoPageAttrs resets them).
- Markers on an auto page stay only while pagination keeps that page: a pull can remove an emptied auto page that has no objects. The Cover select's hint says so.
- Package: the Style drawer imports `@lezer/highlight` (tags) directly. It resolves only through @codemirror/language's dependency; add it to web/package.json explicitly. No packages were installed.
- The e2e CSS measurement needs the dev page's `lastCssEdit`; a production host doesn't need it.
- Environment: other lanes' Vite restarts sometimes break a Firefox run at start-up ("This page could not be loaded"). Rerun before suspecting the code. Firefox runs used --workers=2 or 3.


## Pagination triggers, section commands, seam editing, layout warnings (P4.5–P4.8)

### Interfaces
ONE CALL FOR THE INTEGRATOR (web/src/editor/paginatedExtensions.ts)
- `paginatedExtensions({ gate?, isReady?, ...PaginationOptions })` → `[Pagination, Sections, SeamEditing, BlockTypeCommands]`. Use it instead of `Pagination.configure({ isReady: gate.isReady })`: `const extensions = useMemo(() => paginatedExtensions({ gate }), [gate])` and `<EditorCanvas gate={gate} extensions={extensions} />`. `isReady` is an extra condition (ANDed with the gate).
- Mount `<LayoutStatus editor={editor} />` (web/src/editor/ui/layoutStatus/LayoutStatus.tsx) once, in the editor chrome, outside the canvas and inside a UiRoot.

TRIGGERS (plan §4.7): where each lives, and its test
- User transaction → the page before the first changed page (existing). Attribute-only changes of a manual page other than `kind` (section settings, markers, objects) start at that page (plugin.ts `manualPageAttrsOnly`).
- Fonts: EditorCanvas (useCanvasTheme: `document.fonts` loadingdone → REPAGINATE(0)). Verified, not duplicated. Test: e2e/matrix/lateFont.spec.ts (a web font held back → repagination from 0, every page checked; its /dev/sections copy in triggers.spec.ts was removed with the lean test strategy, docs/testing.md).
- Image load: the scheduler's capture listener → `repaginate(view, page, page)` (existing). Tests: pagination/triggers.test.ts (jsdom), triggers.spec.ts and scheduler.spec.ts (image response held back).
- Theme or user CSS: EditorCanvas, debounced 300 ms (existing). Test: triggers.spec.ts (two CSS edits 100 ms apart → one repagination from 0, at least 300 ms later; a theme switch → from 0).
- Section settings: the section sync (below) → from the section's first page to its last page; other sections are not checked. Tests: triggers.test.ts, commands/sections.test.ts, triggers.spec.ts, sections.spec.ts ("changing a section to 1 column reflows only that section").
- A page added or removed while odd and even pages lay out differently → continue to the last page. `PaginationState.parity` is set when a transaction (pagination's or the author's) changes the page count. When a pass would stop after dirtyTo, step.ts asks `layout.parityMatters()` once; if it is true, the pass continues to the last page. `PaginationOptions.parity?: boolean | 'auto'` (default 'auto'). `domLayout.parityMatters()` (layout.ts `parityMatters(view)`) compares the flow box (content-box width and height, column count, gap, direction) of the first auto page and the page before it (pages without markers). Tests: triggers.test.ts (line model with `evenLines`), triggers.spec.ts (Journal plus brew CSS).

PAGINATION CHANGES (web/src/editor/pagination, still imported from '@/editor/pagination')
- Waiting pages (PG-5): `PaginationState.waiting: number[]` (page indexes, mapped through every change). A page whose flow holds an unsized, unloaded image is skipped with the step action `'waiting'`. `isSettled(state)` is false while any page waits, so autosave keeps waiting. The image's load re-checks the page, and a timer re-checks waiting pages after `WAITING_RECHECK_MS` (`IMAGE_WAIT_MS` 3000 + 100), when measurements stop waiting for the image. New `isPaginating(state)`: a pass is running (false while pages only wait). `measurePageStatus(view, page)` → PageMeasure | 'waiting' | null. `measurePage` is unchanged (null in both cases).
- `PageLayout` gains optional `parityMatters()` and `isVisible(index)`, and `measure` may return `'waiting'`. `PaginateMeta` gains `page` (the page the step looked at) and `parity`. `PaginationProgress.parity`. `StepAction` adds 'waiting'.
- Frame budget: a frame may run up to `MAX_STEPS_PAST_BUDGET` (12) steps past its budget while the next page to check is on screen (`layout.isVisible`; domLayout's `pageInView` checks that the page intersects the window and the editor's scroll container). Offscreen pages keep to the budget. Reason: with EditorCanvas (PageView, decorations), a push from the typed page onto the next, visible page sometimes ended a frame, and that page was painted overflowing (the s2.spec typing test failed 1 run in 4).
- An empty continuation textblock at the top of an auto page (left by an undo, or by a split at the seam) is always pulled back (step.ts `startsWithEmptyContinuation`): re-joined with its head, it adds no line.
- Section sync (pagination/sections.ts, part of the Pagination extension): after author transactions that changed page attributes or the page count, `sectionSyncPlugin()` appends a transaction that copies the section settings (SECTION_ATTRS) of each section's first page to its auto pages. It carries `addToHistory: false` and the meta `SECTION_SYNC = 'hbSectionSync'`. The first page wins: settings changed directly on an auto page are overwritten. Also exported: `syncSectionAttrs(tr)`, `sameSectionValue`, `sectionSyncKey`. Undoing a setting is one step: undo restores the first page, and the sync copies it again.
- `updateAttributes` (the Pagination extension's override): SECTION_ATTRS written to an auto page go to its section's first page.
- Orphaned fragments (P4.7 carry-over): the plugin's appendTransaction (`clearOrphanedContinuations(tr, trs, oldDoc)`) clears `continuation` on a fragment whose head node the author deleted, level by level from the deleted level down, in the author's undo event. "Deleted" means both sides of the end of the head's content were deleted. Deleting the head's text, or a delete that joins the head with the block before it, keeps the chain, as in an unsplit paragraph. The meta `KEEP_CONTINUATIONS` skips this for a transaction. Both fuzzes (step.test.ts and the harness fuzz) now delete blocks with a plain node delete; their special-casing is gone.
- Also exported: `isAuthorChange(tr)`, `addSharedFragmentAttrs(tr, trs, pages)` (shareFragmentAttrs into an existing transaction), `sectionStartIndex(doc, i)`, `sectionEndIndex(doc, i)`.
- Stale continuations (phase-3 review PGR-1, 4, 6, 10; fragments.ts `repairContinuations(tr, trs, oldDoc, pages)`, run by the same appendTransaction after the orphan clearing and the attribute sharing): on the touched pages (±1), a `continuation` flag that no chain reaches (not on an auto page's first-child spine after a same-type head; the empty filler at the start of a reached list item is fine) is repaired in the author's undo event (for an undo, on the redo stack): a node that was a reached continuation before the transaction, or whose flag the transaction set with an AttrStep (an undo), is joined with a same-type node right before it in its page, or, for a textblock, its text is merged into the textblock right before it in reading order (across a seam: JoinPagesStep first, and a page with objects or markers comes back after the block). Anything else (a paragraph Enter or a block insert split off inside a continuation) loses the flag. A textblock that moved deeper than the one before it (wrapped by a path that isn't chain-aware) is cleared, not merged. The meta KEEP_CONTINUATIONS skips this too.
- Attribute sharing (`followHead`) now goes on past the touched pages while a seam changed, so a head's new attributes reach every fragment of a block split over three or more pages.
- Pages that carry data (PGR-5, PGR-8; boundary.ts `carriesPageData(page)`: objects or markers): `isPlaceholderPage` and `moveBoundary` treat markers like objects, so a page with a cover or page-numbering marker is kept (one empty paragraph) when all its text flows back; the marker is no longer lost outside the history. pageData.ts (same appendTransaction, not for undo or redo): `restoreJoinedPages` brings back (restorePageAt) a page with objects or markers that a range delete, typing or paste over a cross-page selection joined away, when part of its flow survived; `dropEmptiedPlaceholders` deletes an auto page kept only for its data once the author removed the last marker or object (no stray empty paragraph pulled back). objects/commands.ts `goesWithLastObject` keeps a page that still has markers.
- `mapToken(mapping, pos)` (boundary.ts): where the token at `pos` is after a mapping (or a slice of one), or null when it was deleted. Use it instead of MapResult.deletedAfter, which is also set at a mere insertion point, and note that `Mapping.maps` / `appendMapping` ignore a slice's from/to.
- `isPaginationPaused(view)` (plugin.ts): the scheduler waits (IME composition, or `isReady()` false) although `isPaginating(state)` may be true.
- Page-structure steps (pagination/pageSteps.ts), registered with the JSON ids 'hbPageBreak' and 'hbJoinPages':
  - `PageBreakStep(pos, attrs)` makes a page with `attrs` start at `pos`. At an existing page boundary, the page that starts there takes the attributes. Inside a page, it splits the page there through every level; the second parts are not continuations. When the auto page right after the split has the same pid (the page an undo is re-creating, whose boundary pagination moved), it folds into the new page (joined, fragments re-joined, a placeholder's paragraph dropped), so the page starts at `pos` instead of existing twice; that inverse is a plain ReplaceStep.
  - `JoinPagesStep(pos, depth = 1, pid = null)` joins the pages at boundary `pos`, plus `depth - 1` block levels. With a pid (a PageBreakStep's inverse carries the new page's pid; JSON keeps it), a depth-1 join whose `pos` is no boundary any more joins the page with that pid when it is the page `pos` is in or the one after it.
  - Each is the other's inverse, so undo and redo of section commands re-create the page boundary wherever the content is after pagination has joined or split the pages involved. A plain AttrStep on a page is dropped from the history once pagination joins that page, and the inverse of a plain page join fails when pagination has put a boundary exactly there.
  - `restorePageAt(tr, pos, attrs)`: brings back a joined-away page after the page-level block holding `pos` (a PageBreakStep), or as a placeholder with an empty paragraph at the end of the page. Its undo removes exactly that page (PGR-2: the plain split used before had an inverse that pagination's join swallowed, and undo showed the page's objects twice). Use it, never a plain split or insert, to re-create a page in a command.
  - Also `secondPartAttrs(node, index)`.
- measure.ts and the dev harness find the flow with `:scope > div.columnWrapper` (RV-9).
- testing.ts: `lineLayout(getDoc, { lines, evenLines, chars, columns, waiting, visible })` returns a LineLayout with `lines(page)` (the line measurement; `measure` may return 'waiting'), `log` ([page index, first text] per measurement), `parityMatters()` and `isVisible()`.
- New pagination/testEditor.ts: `mountPaginated(doc, opts)` → `{ editor, layout(), frame(), settle(), st(), steps(), select(a, h?), press(key), destroy() }`. It is a TipTap editor with paginatedExtensions on the line model; `press` sends a real keydown through the keymaps.

SECTION COMMANDS (web/src/editor/commands/sections.ts)
- PM commands: `insertPageBreak`, `setSectionAttrs(attrs: SectionSettings, pageIndex?)`, `removeSectionBreak(pageIndex?)`.
- Helpers: `makeSectionStart(tr, index)`, `sectionSettings(page)`, `isValidSectionValue(key, value)`, `sectionStartAt(state, pageIndex?)`, `selectionPageIndex(state)`, `atPageFlowStart($pos)`, `atPageFlowEnd($pos)`, `SECTION_SETTINGS`, type `SectionSettings`.
- TipTap extension `Sections` (name 'hbSections', priority 1100):
  - Commands `insertPageBreak()`, `setSectionAttrs(attrs, pageIndex?)`, `removeSectionBreak(pageIndex?)`.
  - Key Mod-Enter. It fails in code blocks, so TipTap's exitCode runs there. The toolbar lane's HbKeymap (priority 1200) calls the same command first.
- insertPageBreak: a selection is deleted first. The break point is lifted out of tables and raw HTML and off node edges. Then, by where the break falls:
  - Inside a page's flow: a PageBreakStep split. A paragraph becomes two, and an ordered list keeps counting. When the inner levels can't split, the break goes before the page-level block.
  - At the start of an auto page, or at the end of a page followed by one (a seam): that auto page becomes the section start (PageBreakStep attributes, and `continuation` cleared on its first-block spine).
  - At the start of a manual page: a blank page before the content. The blank page keeps the page's markers and objects.
  - At the end of a section: a new page with an empty paragraph.
  - The new page has kind 'manual', the section's settings, and a pid from PageIds. The cursor goes to the start of the new section. One undo step.
- setSectionAttrs writes the section's first page only, with AttrSteps. Manual pages are never joined by pagination, so their undo is safe. Invalid keys, values or page indexes fail without a change (columns 1 | 2 | null, pageNumber boolean, footer and style string | null, classes string[]).
- removeSectionBreak is a PageBreakStep that gives the page kind 'auto' and the settings of the section before it. Its undo re-creates the section start even after pagination merged the page away.

SEAM EDITING (web/src/editor/commands/continuation.ts, plan §4.8)
- PM commands: `backspaceAtSeam`, `deleteAtSeam`, `arrowAcrossSeam(key: 'ArrowLeft' | 'ArrowRight', extend?)`, `enterAtSeam`, `backspaceAtPageStart`, `deleteAtPageEnd`, `deleteWordAtSeam(dir)`, `joinBackwardAtHead`, `joinForwardBeforeHead`. Helpers `firstGraphemeLength(text)`, `lastGraphemeLength(text)`, `wordLengthBefore(text)`, `wordLengthAfter(text, mac?)` (Intl.Segmenter), and the handleTextInput prop `continuationTextInput`.
- TipTap extension `SeamEditing` (name 'hbSeamEditing', priority 1100): Backspace, Shift-Backspace, Delete, Mod-/Alt-Backspace, Mod-/Alt-Delete, ArrowLeft, ArrowRight, Shift-ArrowLeft, Shift-ArrowRight and Enter, plus a plugin with `continuationTextInput` (it runs before the input rules of the default-priority node extensions). Each returns false away from a seam, so other keymaps run. ColumnNavigation keeps ArrowUp and ArrowDown.
- Behaviour:
  - Backspace at the start of a continuation deletes the last grapheme (or inline atom) before the seam; the cursor stays.
  - Delete at a fragment's end deletes the first one after the seam. A continuation left empty goes when its parent allows it.
  - ArrowLeft and ArrowRight skip the seam, one character per press. They are reversed on right-to-left text, and Shift extends the selection. Alt and Ctrl variants, and positions away from a seam, stay native. Firefox has two caret stops at soft wraps inside a paragraph; the seam itself takes one press.
  - Enter at a seam: the text after it becomes its own paragraph (in a split list item, a new item of the list, which still continues). No empty paragraph is created, and the cursor goes to its start.
  - Backspace at the start of an auto page (no continuation): JoinPagesStep, then the fragments re-join, then joinBackward. When nothing can be joined (a table before it, for example), the block before is selected and the pages stay apart. A page that carries objects or markers comes back after the joined block.
  - Delete at the end of a page before an auto page: the same, with joinForward.
  - Backspace at the start of a manual page, or Delete at the end of the page before it: removeSectionBreak.
  - A selection across pages: the default ProseMirror delete, then pagination settles. A later page with objects or markers comes back after the joined block (pageData.ts, PGR-8).
  - Backspace (and the typed text) after it: the stored marks are those of the text before the seam; so are the marks of text typed at a continuation's start without stored marks (PGR-13).
  - Ctrl+Backspace / Alt+Backspace at a continuation's start delete the word before the seam; Ctrl+Delete / Alt+Delete at a fragment's end the word after it (Windows/Linux: to the next word's start; macOS Alt: to the word's end), one undo step (PGR-7). The e2e compares them with the browser's own word delete in the unsplit paragraph.
  - Text typed in a continuation while the text before the cursor there is at most one word is inserted directly, so '# ', '- ', '1. ', '> ', '```' don't convert or wrap a fragment in the middle of a paragraph (PGR-9).
  - Backspace at the start of a split paragraph's head whose previous block is not a same-type sibling (a list, a heading), and Delete at the end of a block before such a head: the paragraph's chain is joined first and the join runs on the whole paragraph, history-safe (blockType.ts withChainsJoined, PGR-4). Other paths that move a head (range deletes, input rules) are repaired by repairContinuations.

BLOCK TYPES (web/src/editor/commands/blockType.ts, PG-2 carry-over), for the toolbar lane
- PM commands: `setTextblockType(typeOrName, attrs?)`, `toggleTextblockType(typeOrName, toggleTypeOrName, attrs?)`, `setListType(listTypeOrName)`.
- Helpers: `isTextblockActive(state, type, attrs?)`, `blockTypeTargets(state, type, attrs)`, `listAround(state)`, `convertedAttrs(node, type, attrs?)`, `convertedContent(content, type, schema)`.
- TipTap extension `BlockTypeCommands` (name 'hbBlockType', default priority) replaces TipTap's `setNode`, `toggleNode` and `toggleList`. So `setParagraph()`, `setHeading({ level })`, `toggleHeading({ level })`, `setCodeBlock()`, `toggleCodeBlock()`, `toggleBulletList()`, `toggleOrderedList()` and Mod-Alt-0…6 are history-safe.
- How it works:
  - A type change replaces the whole textblock with a ReplaceStep that keeps the content, never with setBlockType's ReplaceAroundStep.
  - A block split across pages is joined first (JoinPagesStep, then the fragments re-join) and changes as a whole. Its undo splits it at the seams again.
  - The same type with other attributes (a heading level) uses attribute steps on every fragment.
  - The cursor keeps its place in the text.
  - Attributes carried over: classes, style, attributes, align, language and id. A generated heading id is dropped; an id the author set makes the new heading's id custom.
  - Code blocks drop marks and turn hard breaks into newlines.
- setNode on blocks that already have the type is a no-op that returns false. This fixes the toolbar lane's report: TipTap's fallback ran clearNodes, whose setNodeMarkup reset align, classes and a fragment's continuation flag. A covered block that can't take the type where it stands (a list item's paragraph → heading) still falls back to TipTap's setNode: lift, then change. That path is not history-safe on a split list.
- setListType and toggleList: bullet ↔ ordered changes every fragment of a split list. TipTap changed one fragment with setNodeMarkup, which broke the chain (the toolbar lane's list note). `start` is kept (1 for a new ordered list), and pagination renumbers the fragments. As in TipTap, the list then joins a list of the same type right before or after it. Lifting out of a list stays TipTap's (Tab / Shift-Tab: the keymap lane's blocks.ts moveListItem).
- Wraps (PGR-3): `withChainsJoined(command, more?)` runs a PM command on the document with the chains of the covered textblocks (and of the textblocks at `more(state)`) joined into whole blocks, then records its change as one ReplaceStep of the page-level blocks it touched (restorePages brings back joined pages with objects or markers). BlockTypeCommands also replaces TipTap's `wrapIn` (toggleBlockquote, toggleWrap) and `wrapInList` (toggleBulletList / toggleOrderedList outside a list) with it; commands/blocks.ts `wrapInThemeBlock` (Shift-Mod-M) goes through it too. A split paragraph is wrapped whole, and the undo survives pagination splitting the result.
- `restorePages(tr, after, joined)` is exported (blocks.ts moveListItem uses it).

LAYOUT WARNINGS AND STATUS (P4.8)
- web/src/editor/ui/oversize/oversize.ts:
  - `oversizedPages(doc)`, `offendingBlock(doc, pageIndex)` (the unit that starts the page, after its headings).
  - `oversizeFixes(state, index, columns?)` → { makeWide, allowSplitting, shrinkImages }.
  - `oversizeWarnings(state, columnsOf?)` → OversizeWarning[] ({ index, pos, pid, label, fixes }); `sameWarnings`, `pageColumns(view, index)`, `describeBlock(node)`.
  - Commands: `makeWide(index)` (class `wide`; a TOC's `wide` attribute), `allowSplitting(index)`, `shrinkImages(index)` (needs the view, because it measures), `goToPage(index)`.
  - Each fix is one undo step. Pagination re-checks the page, and the warning clears when the block fits.
- "Allow splitting" (the choice asked for): the inline style `break-inside: auto` on the block, plus `display: block` for a theme block (themes make .block an inline-block, which never splits). It needs no editor CSS, export keeps it, and the inspector shows it. A block that may split flows over the columns of its page. A block taller than the whole page stays oversized: theme blocks have no `continuation` attribute, so pagination can't split them across pages.
- `<OversizeList editor warnings onAction? labelledBy? />` (ui/oversize/OversizeList.tsx): the warning items with their fix buttons (group "Fixes for page N", test ids `oversize-<index>`).
- `<LayoutStatus editor delayMs? className? />` (ui/layoutStatus):
  - A polite `role="status"` region (test id `layout-status-text`, data-busy). It shows "Laying out pages…" with a decorative spinner while a pass runs longer than `delayMs` (default `LAYOUT_BUSY_DELAY_MS`, 400), "Waiting for images…" while pages wait, and a visually hidden "N layout warnings".
  - A "N layout warnings" button (test id `layout-warnings`, aria-haspopup dialog, aria-expanded) that opens a Popover dialog "Layout warnings" (test id `layout-warnings-popover`) with the OversizeList.
  - A click on a page's "Oversized" badge (PageView chrome) opens the same popover next to the badge, for that page.
  - After a fix or "Go to page", the popover closes and the editor gets focus, with the cursor on that page. Escape returns focus to the button, or to the editor when the popover was opened from a badge.
- Store: `createLayoutStatusStore(editor, { delayMs? })` → { subscribe, getSnapshot }. It listens to the editor only while subscribed. The snapshot { busy, waiting, pages, oversized } changes only when something shown changes. Also `EMPTY_LAYOUT_STATUS` and `LAYOUT_BUSY_DELAY_MS`. A pass paused for IME composition or the fonts gate (`isPaginationPaused`) is not busy (PGR-15).

DEV PAGES AND E2E
- /dev/pagination now mounts EditorCanvas (PageView, theme chain, user CSS, zoom, fonts gate) with paginatedExtensions and LayoutStatus. Its test API (`window.__hbPagination`, typed in e2e/pagination/harness.ts) is kept, with these additions:
  - `state().waiting`.
  - `events()`: pagination steps { kind 'step', page, action } and repagination triggers { kind 'repaginate', from, to, source: 'canvas' | 'meta', reason }. Each call clears the log.
  - `setUserCss(css)`, `setTheme(theme)`, `parityMatters()`.
  - `caretInBlock()` → { text, offset, fragments, page, fragment } for the caret's split block, fragments joined.
  - `setZoom` renders the zoom prop synchronously (flushSync).
  - Query params: theme, doc, zoom, paginate, css, busyDelay.
- /dev/sections: the same page with a toolbar (Page break, Section columns, Block type); its default doc is 'sections'. New fixtures: 'sections' (three sections: 2, 1 and 2 columns) and 'oversize'. Open it with `openHarness(page, { sections: true, css?, busyDelay? })`.
- Specs (port 5326), all passing in Chromium and Firefox:
  - e2e/sections/seams.spec.ts: Backspace, Delete, Ctrl+Backspace, Ctrl+Delete and Enter compared with the same paragraph unsplit; arrows one character per press; joinBackward at an auto page's start; deleting a head.
  - sections.spec.ts.
  - triggers.spec.ts.
  - oversize.spec.ts: fixes by keyboard, badge and pointer; undo brings the warning back; axe on the status and popover; the busy indicator.
  - e2e/pagination: scheduler.spec's image test now asserts the waiting state (image response held back).
- Vitest: pagination/triggers.test.ts, pageSteps.test.ts, step.test.ts additions; commands/{sections,continuation,blockType}.test.ts; ui/oversize/oversize.test.ts; ui/layoutStatus/LayoutStatus.test.tsx. Phase-3 review (PGR-*): pagination/fragments.test.ts (stale continuations, undo after re-splits, the three-page chain) and pageData.test.ts (markers, placeholders), plus additions to the files above.

### Notes for later phases
- Integrator: replace `Pagination.configure(...)` plus `Sections` with `paginatedExtensions({ gate })`, which includes Sections, SeamEditing and BlockTypeCommands. Mount one `<LayoutStatus editor />` in the status area. HbKeymap (priority 1200) above Sections and SeamEditing (1100) is fine: the only key they share is Mod-Enter, and both send it to insertPageBreak.
- Journal: odd and even pages have different paddings (2.1/1.9/1.7/3.8 cm and 2.1/3.9/1.7/1.8 cm) with the same total width. Their flow boxes have the same size, so parityMatters() is false and adding a page doesn't change later pages. The parity trigger matters for brew CSS that sizes odd and even pages differently; triggers.spec uses `.page:nth-of-type(2n) .columnWrapper { padding-right: 3cm }`.
- Snippets lane: your `setSectionAttrs(tr, index, attrs)` writes every page of the section, in the history. Attribute steps on auto pages are dropped from the history once pagination joins those pages, and the section sync already copies the first page's settings to them. Writing the first page only is enough (or use commands/sections.ts setSectionAttrs).
- Page markers on auto pages (snippets lane note): durable now (PGR-5): a page with markers is kept like a page with objects, blank when all its text flows back. makeSectionStart is only needed when the marker should also stop content flowing across the page's start. The inspector's cover hint says so.
- Objects lane: the natural-size transaction (hbImageNaturalSize) is a document change, so an image's load now re-checks from the page before the image's page (one extra measurement). This is harmless.
- Delete at the end of a section (before a manual page) removes the section break, like Backspace at the section's start; Word does the same. It is one undo step. If that surprises authors, make deleteAtPageEnd return false before manual pages.
- History safety (phase-3 review): wraps (wrapIn, wrapInList, wrapInThemeBlock) and joins at a split head are whole-block ReplaceSteps now; Tab / Shift-Tab are the keymap lane's moveListItem. Input rules at a split paragraph's start ('# ', '- ') still use TipTap's setBlockType / tr.wrap on the head fragment; repairContinuations merges the rest of the paragraph into it in the same undo event, and the line-model tests undo them after pagination moved the result. In the DOM, a list item split across pages after such a wrap could still lose that undo (not seen). Not guarded: '```' + Enter at a continuation's start (the code-block rule runs on Enter), and input rules after IME compositionend there. Lifting out of a list with toggleBulletList / toggleOrderedList (TipTap's liftListItem) and TipTap's clearNodes fallback are not chain-aware.
- A theme block taller than a whole page stays oversized even with "allow splitting". Splitting it across pages needs a `continuation` attribute on themeBlock (schema, manifest and backend) and a cut rule for containers (cut.ts cutInBlock).
- Performance: the S2 30-page test (e2e/pagination/s2.spec.ts) takes 175–272 ms per edit in Firefox alone, but over 500 ms (up to about 1.3 s) with 3 or more parallel workers on this machine. The measure-spec zoom tests can time out in page.goto under the same load. Run Firefox with --workers=1 before suspecting the code.
- No packages needed.


## Page objects, icons, tables, block UI, images (P5.3, P5.5, P5.6, P5.7, plan §4.9, §6.6)

### Interfaces
Every command below is a plain ProseMirror command `(state, dispatch?) => boolean` (dispatch-less = "can I?"), one transaction per user action (one undo step; block and page commands call `closeHistory` so they never merge with typing). Node attributes change with `tr.setNodeAttribute` (pagination convention PG-2).

EDITOR EXTENSIONS
- In every EditorCanvas (added to `editorNodeViews`, web/src/editor/nodeviews/index.ts): `ImageWithView` (objects/imageView.ts), `TableHeaderRows` (tables/headerRows.ts), `CaretBlock` (ui/blockMenu/caretBlock.ts).
- For an editing canvas: `pageEditingExtensions` from '@/editor/objects' = `[PageObjects, IconSuggestion, DefinitionListKeys]`. Memoize the array you pass to EditorCanvas (the shell's edit page should add it; /dev/objects shows the wiring with Pagination).

PAGE OBJECTS (web/src/editor/objects; import '@/editor/objects')
- State (state.ts): `objectSelectionKey`, `selectedObject(state): ObjectRef | null` (`ObjectRef = { pagePos, id }`), meta `OBJECT_SELECTION` (ObjectRef selects, null clears; no history, no doc change), `applyObjectSelection`, `pageNodeAt(doc, pagePos)`, `findObjectByPid(doc, pid, id)`. The selection maps through transactions (when pagination re-splits its page, join + split, it is found again by the page's pid) and goes away with its page or object.
- Page attribute steps (pageAttrStep.ts): `setPageAttr(tr, pagePos, attr, value)` writes a `PageAttrStep` (step JSON id 'hbPageAttr') on an auto page with a pid, else an AttrStep. A PageAttrStep names the page by pid (its position is a hint, updated when it applies) and is never dropped by mapping: an AttrStep on an auto page lost its undo once pagination moved the page's leading boundary (join + split deletes the page's opening token; UI-1). Used by every object command, setPageCover, the inspector's page edits (attrs.ts writeNodeAttr) and the snippets' page markers and lifted objects.
- Commands (commands.ts): `selectObject(ref|null)`, `updateObject(ref, patch)` (style, text, classes, src), `deleteObject(ref)`, `moveObjectInZOrder(ref, 'forward'|'backward'|'front'|'back')` (array order = stacking order among equal z-index), `addObject(pagePos, id => PageObject)`, `addImageObject(src, at?)`, `addTextObject(text?, at?)` (on the selection's page), `placeImageFreely(imagePos, at)` ('Place freely': inline image → object at `at`, page px; float/margins/shape-outside dropped), `putObjectInText(ref, hint?)` ('Put back in text': image object → inline image at `hint` (posAtCoords) or the page's first text block; positioning dropped, size kept), `setPageCover(pagePos, cover|null)`, `setSelectionCover(cover)`, `selectionCover(state)`, `selectedImage(state)`, `pageAround(doc, pos)`, `selectionPage(state)`, `DEFAULT_PLACEMENT` ({left: 96, top: 96}). Removing the last object of an auto page kept only for it (isPlaceholderPage) removes the page in the same step (deleteObject; putObjectInText puts the image at the end of the page before): pagination would remove it outside the history and the undo would have no page to restore the object to (UI-1). A caret on that page goes to the end of the page before.
- Model (model.ts, pure): `parseDeclarations`, `serializeDeclarations`, `styleValue`, `withStyle(style, {prop: value|null})` (in place, cssText form `a: b;`), `pxValue`, `px`, `objectsOf(attrs)`, `findObject`, `newObjectId` ('o-xxxxxx'), `patchObject`, `removeObject`, `reorderObject`, `imageObject(id, src, at)`, `textObject(id, text, at)`, `objectStyleFromImage`, `imageStyleFromObject`, `COVER_MARKERS`/`CoverMarker`/`COVER_LABELS`, `coverOf(markers)`, `withCover(markers, cover)` (other markers such as skipCounting kept).
- DOM helpers (dom.ts): `placementInPage(view, el, pagePos, zoom)`, `imagePlacement(editor, imagePos, pagePos)` (page px, zoom removed).
- `PageObjects` extension (extension.ts, name 'hbPageObjects'): the selection plugin plus the ObjectLayer; `objectLayerOf(editor)` gives the layer (`focusFrame()`, `startEditing()`, `putBackInText()`, `deleteSelected()`, `root`, `isEditing`).
- ObjectLayer (web/src/editor/nodeviews/ObjectLayer.ts, a plugin view; styles objects/objectLayer.module.css): `div[data-hb-object-layer]` appended to view.dom's parent (.hb-canvas, next to div.pages; never inside a page, so pages' overflow can't clip it and theme selectors never see it). Frame `[data-testid=object-frame]` (role=group, aria-roledescription "page object", focusable, 8 `[data-handle=nw|n|…]`), toolbar `[data-testid=object-toolbar]` (role=toolbar, roving focus: Send backward, Bring forward, Edit text | Put back in text, Delete; buttons carry `data-action`), live region `[data-testid=object-status]`. Also exports `resizeGeometry`, `anchorElement`, `HandleName`.
  - Pointer: click an object element; objects behind the text (5ePHB `.page img { z-index: -1 }`) with Alt+click or a click where there is no text (page margins, the empty part of the column wrapper); drag the object/frame to move, a handle to resize (images keep their ratio on corners, Shift toggles). Deltas are divided by `canvasZoom(editor)`. The drag only rewrites the object element's style attribute (PageView ignores chrome mutations) and commits one `updateObject` on pointerup (nothing when the pointer moved < 3 px).
  - Keys on the frame: arrows move 1 px (Shift 10), Alt/Ctrl+arrows resize, Enter/F2 edit text, Delete/Backspace delete, Ctrl+] / Ctrl+[ forward/backward (with Shift: front/back), Escape back to the text. Tab reaches the toolbar.
  - Moving writes left/top in px and removes right/bottom; when a class still anchors the object at right/bottom (measured), `right: auto; bottom: auto` are added. Resizing writes left/top/width/height in px (percentages become px). Moves, resizes and nudges keep at least `PAGE_STRIP` (16) px of the object inside the page's padding box (`clampToPage(geometry, pageSize, strip?)`; bleeding past the edges stays possible); the status says "Kept on the page" when it held the object back (UI-9).
  - A gesture (drag, in-place edit) follows its object while the document changes under it: sync() takes the mapped selection, and at commit the object is found again by its page's pid when the selection was dropped (UI-2).
  - In-place text editing (double-click, Enter, "Edit text", "Add text object"): the object span becomes contenteditable=plaintext-only (fallback true) and its page element gets contenteditable=false for the duration, because ProseMirror's root is otherwise the editing host of everything inside it (focus and typing would go to ProseMirror). PageView's stopEvent/ignoreMutation keep ProseMirror out. Enter commits (one `updateObject`), Escape restores, blur commits.

IMAGES (objects/imageView.ts)
- `ImageWithView` = HbImage + `ImageView` NodeView + `imageNaturalSizePlugin()`. When an image loads in an editable view, `naturalSizeTransaction(view, imgs)` stores naturalWidth/Height in attrs.width/height (addToHistory false, meta `NATURAL_SIZE_META = 'hbImageNaturalSize'`; autosave should save it). Covers insert, paste and import (imported docs get their sizes on first load).
- ImageView renders renderHTML's img (src last, --HB_src kept) plus, with a stored size, `data-hb-natural` and `--hb-natural-width: Wpx` (left out when the author's style sets only a height: `heightOnly(style)`). canvas.css: `:where(.hb-canvas img[data-hb-natural]) { width: var(--hb-natural-width, auto); height: auto }` — zero specificity, so theme and author sizes win, the width/height attributes (kept for pagination's "sized image" check) only contribute the aspect ratio.

ICONS (web/src/editor/icons; import '@/editor/icons')
- Catalog (catalog.ts): `iconCatalog()` (Dice, Elderberry Inn, Game Icons, Font Awesome from themes/fonts/iconFonts/*.js; `IconEntry { name, font, glyph, set, label, words }`), `ICON_SETS`, `iconByName(name)`, `iconClasses(e)`, `queryWords(q)`, `searchIcons(query, { set?, limit? = 200 }) → { results, total }` (exact name, then prefix, then word, then substring).
- `insertIcon(icon)` command; `IconSuggestion` extension (priority 1300, above HbKeymap's Tab; UI-5): `:` + ≥2 name characters at a word start opens the list (`iconSuggestionKey` state; `acceptSuggestion(view, i?)`, `moveSuggestion`, `dismissSuggestion`, `triggerBefore(state)`, `insertIconAt(state, from, to, icon)`, `suggestionIds(view)`); ArrowUp/Down, Enter/Tab, Escape (closed for that colon); a typed `:name:` of a known icon converts at once. Inserting is its own undo step (closeHistory). While open, the editor element carries aria-autocomplete=list, aria-controls, aria-activedescendant.
- UI (web/src/editor/ui/iconPicker): `IconPicker({ open, onOpenChange, onPick, initialQuery? })` (Dialog; search field is a combobox over a listbox; font filter; ArrowUp/Down by rows, Alt+arrow by one, PageUp/Down, Enter), `IconPickerButton({ editor })` (IconButton `data-testid=insert-icon` + dialog; inserts at the selection), `IconSuggestionPopup` (vanilla plugin view in the UI kit's portal root, `data-testid=icon-suggestions`), `glyphElement(doc, classes)`. Glyph previews sit in a `span.hb-canvas`: the icon font CSS is part of the (scoped) theme.

TABLES (web/src/editor/tables; import '@/editor/tables')
- Header rows: `TableHeaderRows` decorates the leading all-header rows with class `hb-header-row` (`HEADER_ROW_CLASS`, `isHeaderRow`, `headerRowCount`, `headerRowPositions`, `headerRowsPlugin`, `headerRowsKey`). `rewriteHeaderRowSelector(selector)` / `rewriteHeaderRowSelectorList(list)` (headerRowSelectors.ts, pure, no imports) rewrite theme and user selectors, same specificity:
  - `thead X` → itself plus `tr:where(.hb-header-row) X`; `thead > tr` / `thead tr` → plus `tbody > tr:where(.hb-header-row)`; `thead` alone → plus `tr:where(.hb-header-row)`.
  - `tbody tr:nth-child(odd)` → `tbody tr:nth-child(odd of :where(:not(.hb-header-row))):where(tr:not(.hb-header-row), tr:not(.hb-header-row) *)`; other tbody descendants get the `:where(…)` body-row constraint.
  - `tr:nth-child(…)`/`:first-child`/… outside thead/tbody count within the header rows and within the body rows (`:is()` of both).
  - Applied by web/vite/scopeThemes.ts (a postcss plugin on each rule's selector list, after prefixing) and canvas/cssScope.ts (top-level and nested rules). canvas.css forces `tr.hb-header-row { display: table-row !important }` (themes set `thead { display: table-row-group }`).
- Commands (commands.ts): `insertTable({ rows, cols, headerRows })`, `createTable(schema, opts)`, `setHeaderRows(on)` (the selected rows' cells become th/td, attributes kept), `isHeaderRowSelected`, `setColumnWidth(px|null)` (colwidth of the selected columns in every row, spanning cells at the right index; 10–2000), `selectedColumnWidth`, `resetColumnWidths`, `toggleTableClass('classTable'|'frame'|'decoration'|'wide')` (on the `{{classTable …}}` theme block around the table: classTable creates it (frame/decoration too), removing classTable unwraps it keeping wide on the table; without a wrapper, wide goes on the table), `tableClasses(state)`, `tableContext(state)`, `TABLE_CLASSES`, `TABLE_CLASS_LABELS`. Row/column/merge/split are prosemirror-tables' commands (`@tiptap/pm/tables`), which keep spans.
- UI (ui/tableMenu): `TableMenu({ editor, label?, iconOnly? })` (MenuButton `data-testid=table-menu`: Insert table outside a table; inside: rows, columns, "Column width…" dialog `column-width-dialog`, cells, table style checkboxes, delete table), `tableMenuContext(state)`.

BLOCKS (P5.7, ui/blockMenu)
- blockCommands.ts: `insertBlock(make)`, `insertSpacer`, `insertHorizontalRule`, `insertDefinitionList` (a non-empty paragraph becomes term (before `::`) and description (after); an empty paragraph becomes an empty list), `insertColumnBreak` (re-export of the toolbar lane's commands/blocks.ts command, so the menu and Shift-Mod-Enter agree), `emptyDefinitionList`, `findBlock(state, type)`, `removeBlock(type)` (node selection, the ancestor list, or the block right before/after the caret; lists are unwrapped into paragraphs with the caret at the same character, atoms deleted; a container keeps one child), `runBlockCommand(editor, cmd)` (runs and focuses the text), `canRun`, `BLOCK_TYPES`, `BLOCK_LABELS`.
- `DefinitionListKeys` (definitionListKeys.ts, priority 150): Enter in a term → description, in a description → term (or into an empty next item of the other kind), in an empty item → leave the list (a paragraph after it, or between its halves; the id stays on the first half, UI-10); Backspace at the start of the first item → paragraph before the list. `definitionListEnter`, `definitionListBackspace`.
- `CaretBlock` (caretBlock.ts, in every canvas): class `hb-caret-block` (`CARET_BLOCK_CLASS`) on the dt/dd holding the caret of a focused editor (plugin state tracks focus, so read-only and blurred views look like upstream), so it keeps the line canvas.css otherwise hides; types the first character of an empty dt/dd through ProseMirror (Chromium would type into the term before an empty inline dd); a plain click in an empty table cell puts the caret into that cell. `caretBlockDecorations(state, focused?)`, `caretBlockKey`, `isLinelessWhenEmpty`.
- `BlockMenu({ editor, label? = 'Blocks', iconOnly? })` (MenuButton `data-testid=block-menu`): groups Insert (definition list, spacer, column break, horizontal rule, page break = commands/sections.ts insertPageBreak), Remove (what findBlock finds), Image ('Place freely' for a node-selected image), the selected object (edit text / put back in text, forward, backward, delete), Page N (cover type radios, "Add image object…" dialog, "Add text object" (starts editing), "Select <object>" for every object: keyboard access, also to objects behind text). `blockMenuContext(state)` is the plain-data model. ui/objects: `AddImageObjectDialog({ open, onOpenChange, onSubmit })` (URL checked with isSafeSrc).

CANVAS.CSS (additive section "Objects lane" at the end): header rows `display: table-row !important`; image natural width; the trailing <br> of empty (or atom-ending) dt/dd hidden except in `.hb-caret-block` and after a hard break; float-only paragraph (the separator image after a floated image needs !important, prosemirror.css sets it; the trailing break after it hidden); an empty table cell's paragraph is a block with the cell's font and no margins (with `display: contents` Chromium put the caret of a click into a neighbouring cell), and its <br> is hidden in read-only views only (`.ProseMirror[contenteditable=false]`: an entirely empty row is one line taller while editing, so new tables stay clickable); the caret's empty dt/dd is an inline-block while edited.

DEV PAGE AND E2E
- /dev/objects?doc=blank|blocks|tables|images|objects[&fixture=<S3 fixture>][&theme=][&zoom=][&paginate=0] (web/src/dev/objects): EditorCanvas + Pagination + pageEditingExtensions, a UI-kit toolbar with Undo/Redo, BlockMenu, TableMenu, IconPickerButton, zoom select. `window.__hbObjects` (ObjectsDevApi): editor, handle, settled(), doc(), pages(), objects(i), markers(i), selected(), undo(), redo(). devDocs.ts exports the documents and `svgImage(w, h)`.
- web/e2e/objects: objects.spec.ts (cover page from scratch without the inspector; select/drag/zoom/keys/toolbar/edit/convert), tables.spec.ts, icons.spec.ts, blocks.spec.ts (insert/remove each block, dl keys, images, fidelity rules), a11y.spec.ts (axe); helpers.ts (`openObjects` stubs only `/api/`: a `**/api/**` glob also catches `/src/api/` modules). Port 5328.

MEASUREMENTS (header rows, fidelity rules; /dev/import is read-only EditorCanvas)
- S1 screenshot vs the old renderer (e2e/canvas/screenshot.spec.ts): Chromium 0.35% → 0.00% (7 px), Firefox 0.34% → 0.00% (10 px). The win32 regression baselines (e2e/canvas/baseline/s1-p1-*-win32.png) were re-recorded, as their old images held the wrong header rows.
- S3 fixtures (e2e/import/fidelity.spec.ts run directly with FIDELITY=all, FIDELITY_FILTER on 41 fixtures: tables, class tables, stat blocks, definition lists, GNU FDL, ORC notice, welcome; `scripts/fidelity-run.ts` was not used because it deletes and replaces test-results/fidelity-runs/<browser>, the import lane's saved full runs): under 2% before 34/41 (Chromium) and 33/41 (Firefox, the saved P2 run), after 41/41 in both.
  - The 9 class tables: 0.76–10.18% → 0.00% (e.g. martial 10.18/9.99% → 0.00%). GNU FDL page 3: 17.99/17.18% → 0.00%. ORC notice: 2.92/2.69% → 0.00%. welcome: Chromium 0.99% → 0.13%, Firefox 2.07% → 1.18%. The blank tables, the stat blocks and md-definition-lists-* went to 0.00% too (at most 0.17% left).

CHANGES OUTSIDE MY PATHS (all additive)
- web/src/editor/nodeviews/index.ts: `editorNodeViews` gains ImageWithView, TableHeaderRows and CaretBlock (so every canvas, the S3 harness included, has them).
- web/src/editor/nodeviews/domContract.test.ts: normalizeEditorDom also removes the editor-only class hb-header-row.
- web/src/editor/canvas/canvas.css: the section above (appended at the end).
- web/vite/scopeThemes.ts and web/src/editor/canvas/cssScope.ts: the header-row rewrite (task-owned for the thead fix), with tests in scopeThemes.test.ts and cssScope.test.ts.
- web/e2e/canvas/baseline/s1-p1-{chromium,firefox}-win32.png: re-recorded (HB_UPDATE_BASELINE=1).
- Uses (read only) the toolbar lane's `insertPageBreak` (commands/sections.ts) and `insertColumnBreak` (commands/blocks.ts), and the import lane's `loadFixture`, `hbfmToDoc` and HBFM renderer (dev page and tests).

### Notes for later phases
- Shell / edit page: add `pageEditingExtensions` (memoized) to the editing canvas, and slot `BlockMenu`, `TableMenu` and `IconPickerButton` into the toolbar. TipTap's editor element has role=textbox without a name (axe aria-input-field-name): give it an aria-label (editorProps.attributes, canvas/shell lane).
- Export (P6.4): move leading header rows (tr.hb-header-row, i.e. `headerRowCount(table)`) into a real <thead> (the unscoped theme CSS has no rewrite); copy canvas.css's image rule (`img[data-hb-natural]` is editor-only: exported <img> get width/height attributes, so either strip them or add `img[width][height] { height: auto }` plus the width variable) and the dt/dd, float and empty-cell rules (read-only variants).
- Importer (P6.2): its probe could record natural image sizes (img.naturalWidth/Height after load) into image attrs; until then ImageWithView fills them on the first editable load (outside history; autosave should save that transaction, meta 'hbImageNaturalSize').
- Header-row rewrite limits: only top-level compounds (`table:has(thead)`, `:is(thead) th` are left alone), a rule for `tbody` itself still covers the header rows, and `thead { display: … }` can't hide header rows (canvas.css forces table-row). An empty all-header row is one line taller while editing than in read-only views (empty cells keep their <br> in editable views).
- Undo of object and marker edits on auto pages (PageAttrStep, UI-1): the page is found by its pid. One case is left: when the last object of an auto page WITH text is removed and pagination later merges that page away entirely (its text pulled back, no objects left to keep it), the pid is gone and the undo can't restore the object. A page kept only for its objects is removed in the author's step instead (deleteObject), so that case undoes.
- Objects: z-order is the objects array order (an explicit z-index in the style wins). Images in 5ePHB sit behind the text (z-index -1): they are selected by Alt+click, a click on an empty area, or the BlockMenu's "Select …" items. Resizing writes px (percent sizes become px). Moving a theme-anchored object (`.footnote`, `.banner` rules with right/bottom) adds `right: auto; bottom: auto`. The inspector lane edits classes/style of objects through `updateObject(selectedObject(state), patch)`.
- In-place text editing sets contenteditable=false on the page element for the duration (see ObjectLayer); code that watches that attribute (none today) should ignore it. If the page's chrome is re-rendered mid-edit (e.g. pagination flips `oversized`), the edit ends and the typed text is committed (to where the object is by then, UI-2).
- Duplicates to consolidate later: blockCommands `insertBlock` (spacer, rule, dl, table) and the toolbar lane's private `insertBlockAtCursor` (column break) place blocks the same way; one shared helper would do.
- Tests: e2e/objects runs in ~2 min (Chromium) and ~4 min (Firefox) with 3 workers against one dev server (`E2E_BASE_URL=http://localhost:5328 E2E_PORT=5328`). Firefox is slow on a loaded machine (the cover-page test has a 180 s timeout).
- A `page.route('**/api/**')` glob in a spec also intercepts Vite's /src/api/ modules and blanks the app: match `/^https?:\/\/[^/]+\/api\//` instead (helpers.ts).


## App pages: EditorApp, /edit, /new, /share, home, end-to-end flows (phase 3 integration, P7.1, P7.2, plan §9, §12)

### Interfaces
EDITORAPP (web/src/editor/EditorApp; import the component from '@/editor/EditorApp/EditorApp', helpers from './editorAppModel'):
- `<EditorApp mode saving content brew … />`: the composed editor of the app pages. Props:
  - `mode: 'edit' | 'view'` ('view' = read-only, pagination still on) and `saving: 'server' | 'none'` ('server' runs useAutosave with drafts and snapshots; 'none' = never saved, no IndexedDB writes).
  - `content: JSONContent` (already migrated) and `brew: EditorAppBrew` are read once (useState). Mount a new EditorApp (a new React key) for another brew; never re-create it from refetched data.
  - `initialMetaInput?` (a /new draft's BrewMetaInput, sent with the first save), `baseline?` (BrewBaseline: "Restore unsaved changes" on /edit), `unsavedOnLoad?` (the content is not on the server yet: markDirty() as soon as someone is signed in, now or after signing in).
  - `onCreated?(brew, 'new' | 'copy')` (navigate; see the session keys below; it can arrive after the page unmounted: the unmount save of a /new brew), `onDeleted?(result, editId)` (called after the render that turned autosave off, so leaving doesn't save the deleted brew again; before it, EditorApp forgets the brew on this device: its 'edit' Recent brews entry (and the 'view' one when the brew was deleted, not just left), its drafts (readDraftsFor) and its local snapshots (SnapshotHistory.clear)).
  - `statusNote?` in view mode goes to the end of the viewing bar (the share page's view count).
  - `recent?: 'edit' | 'view' | null` (useRecordRecentBrew with the current editId / shareId and title), `navbar?` (default true: Share / Edit items via NavbarPortal), `showTitle?` (brew title in the navbar), `navItems?` (more navbar items first), `tabTitle?` (document title = brew title), `heading?: string | (title) => string` (visually hidden h1 with data-route-focus), `banner?` (under the toolbars), `statusNote?` (toolbar status slot when saving is 'none'), `overlay?` (floating content over the canvas), `autoFocus?` (caret in the editor once ready, per editor instance (a StrictMode re-creation takes the focus back), unless the reader is busy in <main> or a dialog/popover; a navbar item, <main> or the route-focus heading don't count), `label?` (the editor root's name, default 'Brew pages'), `data-testid?` (default 'editor-app').
  - Root element: `[data-mode][data-canvas-status][data-save-status (autosave status | 'none')][data-edit-id][data-share-id]`.
- What it composes: EditorCanvas with `editingExtensions(gate)` or `viewingExtensions(gate)` (memoized per gate; createCanvasGate), zoom/spread/startOnRight/pageShadows from the UI store, theme and lang from the metadata draft (a theme picked in Properties restyles at once), userCss = the Style drawer's value. Edit mode: EditorToolbar (Insert slot = InsertMenu + BlockMenu + TableMenu + IconPickerButton; status slot = SaveStatus or statusNote), EditorAppBar, LockBanner (BrewForEdit.lock), DraftRestoreBanner, OutlinePanel, StylePanel (style-view SnippetPicker through `snippets={(api) => …}`; generator errors toast), InspectorPanel, and for saving 'server' ConflictDialog, LocalHistoryDialog and MetadataDialog (Properties; its meta goes to autosave's getMeta/watch, its author list is reset to the server's after a create or a saved author edit). View mode: EditorAppBar with zoom and page layout, OutlinePanel; the viewport becomes a focusable region "Pages" (keyboard scrolling; axe scrollable-region-focusable).
- Snippet groups: `useSnippetGroups(canvasStatus.chain.snippets, brew snippets, title)` once the canvas is ready (edit mode only); `<style>` blocks of text snippets are appended to the brew style (insertStyleSnippet).
- Shortcuts (`useEditorShortcuts({ editor, onSave, onPrint, saveKeyOnWindow? })`): HbKeymap's 'save' → autosave.saveNow() ('none': a toast "This page is never saved"), 'print' → print; a window keydown listener takes Ctrl/Cmd+P anywhere on the page (the read-only editor never has focus), and with `saveKeyOnWindow` (pages that never save) Ctrl/Cmd+S too. Keys already defaultPrevented are left alone. Print = `settleNow(editor.view)` (finish pagination), then `handle.print()` (lazy images, window.print).
- `EditorAppBar({ mode, editor, tracker, toggleRefs, onProperties?, onHistory?, propertiesRef?, onPrint, status? })` (status: a note before Print in view mode): role toolbar "Brew" (edit) / "Viewing" (view): toggles Outline, Style (edit only) and Inspector (edit only) with aria-expanded, and aria-controls while open (PANEL_ELEMENT_IDS), PageNav, zoom and page layout (view only), LayoutStatus (edit only), Print (Ctrl+P), Local history and Properties (saving 'server' + edit). Test ids: editor-app-bar, toggle-outline, toggle-style, toggle-inspector, print, open-local-history, open-properties, zoom-in, zoom-out, zoom-menu, spread-menu.
- `EditorNavItems({ shareId?, editId? })`: navbar "Share" disclosure (nav-share; View the share page = nav-share-view, Copy the share link = nav-share-copy, with a toast) in edit mode once saved; "Edit" link (nav-edit) on the share page for authors. Print lives in the app bar, which keeps the navbar within a phone's width.
- `LockBanner({ lock, editId, onLockChange? })`: region "This brew is locked" (lock-banner, lock-message), "Request review" (lock-request-review; useRequestLockReview) or "Review requested <date>" (lock-review-requested). The MetadataDialog shares the lock state (onLockChange). Failures the error policy leaves to the caller: 409 (an admin removed the lock meanwhile) → toast "This brew is no longer locked" with the API detail and `onLockChange(null)` (the banner goes); other caller errors (400) → a role=alert line in the banner (lock-review-error). Others toast through the policy.
- Session and sign-out (EditorApp, saving 'server'): a save answered 401 sets `me` to null (autosave calls the API directly, so the query client's 401 policy never saw it); signing in again, even as the same user, then changes userKey and retries. While mounted it registers a before-sign-out hook (web/src/app/signOutHooks.ts) that saves pending changes (saveNow, then waits until the status is neither 'dirty' nor 'saving'). Restoring a Local history snapshot applies its meta without `authors` (history; sending it again would re-invite or remove people); a restored draft keeps its unsaved author edit and the Properties dialog shows it (known handles keep their role, others 'invited').
- Extensions (editorAppExtensions.ts): `editingExtensions(gate, label?)` = hbKeymapExtensions + paginatedExtensions({ gate }) + pageEditingExtensions + EditorAccessibility; `viewingExtensions(gate, label?)` = paginatedExtensions({ gate }) + EditorAccessibility (read-only). `EditorAccessibility` (name 'hbEditorAccessibility') puts aria-label (EDITOR_LABEL 'Brew pages') and, read-only, aria-readonly on the ProseMirror root through the `attributes` prop. This fixes the axe aria-input-field-name issue the panels and objects lanes reported. `editorAccessibilityKey`.
- Model (editorAppModel.ts, pure): `EditorAppBrew`, `EditorAppMode`, `EditorAppSaving`, `appBrewFromEdit(BrewForEdit)`, `appBrewFromShare(BrewForShare)` (editId only for authors), `appBrewForNew(draft?)`, `baselineOf(BrewForEdit)`, `docForEditor(doc, docSchemaVersion)` (migrateDoc; anything that isn't a doc → blankDoc()), `blankDoc()`, `defaultMeta(overrides?)`, `metaFromInput(input, base?)`, `displayTitle(...candidates)` (first non-blank, else 'Untitled brew' = UNTITLED), `isPrintShortcut(event)`, `PANEL_ELEMENT_IDS`, DEFAULT_THEME, DEFAULT_LANG.
- Dev builds only (devApi.ts): `window.__hbEditorApp = { editor, handle, settled(), save() }` (settled = canvas ready and pagination idle; save = the autosave state or null). The e2e flows use it; production builds drop it (import.meta.env.DEV).

LAZY LOADING: the pages render `<LazyEditorApp {...EditorAppProps} />` (LazyEditorApp.tsx: React.lazy + Suspense; the fallback is the page heading (sr-only h1 with data-route-focus, from `heading`) and PageLoading "Loading the editor…"). The route modules stay small (pages import editorAppModel, which imports only schema/migrations and schema/version), so a navigation to /, /new, /edit or /share completes at once; the four pages share one EditorApp chunk (about 1.5 MB minified in a scratch production build, with neither the dev API nor marked-hbfm in it).

ROUTES AND PAGES:
- web/src/app/routes.tsx: /new and /edit/:editId are children of ONE pathless layout route (`id: 'editor'`, lazy '@/pages/edit', children `{ path: 'new', element: null }` and `{ path: 'edit/:editId', element: null }`), so the editor stays mounted when the URL changes between them. web/src/pages/new/index.tsx re-exports the same module (not routed).
- pages/edit/index.tsx `EditorRoute`: picks the session key with editorSession.ts and renders `BrewSession` (a new brew or a loaded one for its whole life, whatever the URL says later). Keys (`editorSessionKey(sessions, editId, location.key)`): /edit/:editId → `edit:<editId>` (reopening the same brew keeps the editor), /new → `new:<location.key>` ("New brew" or "Start over" mounts a fresh one). `adoptSession(sessions, key, editId, from?)` maps a brew created (first save) or copied ("Save mine as a copy") by a session to that session, so the navigation to its /edit/:editId keeps the same editor and autosave's version bookkeeping. `from` = the brew the session held until then (a copy's original): it is released (`EditorSessions.released[from]` counts up), so its URL (Back, Recent brews, any link) gets a fresh key (`edit:<id>#<n>`) and mounts an editor that loads it again; the copy handler also removes the original's edit query (it predates the conflict). The sessions only navigate or adopt while mounted (`useMountedRef`): a create that lands after the user left (the unmount save of /new) leaves the page where the user went, records the brew in Recent brews and toasts (pages/edit/leftSession.ts `noteCreatedAfterLeaving`). A deliberate sign-out (`onSignedOut`) removes every brews.edit query and remounts every session (a sign-out counter in the React key): /edit/:editId then shows the inline sign-in form, and the brew and its Local history leave the page; a session that merely expired (401 while saving) keeps the editor for "Sign in to save". `draftDiscardedAt(state)` / `NewPageState { hbDraftDiscardedAt }`.
- /edit/:editId (EditBrewSession): useBrewForEdit. Once data is there the editor stays (the session keeps the brew it opened in state), even if a later refetch fails (an expired session: autosave reports it) or the query is removed (after a copy). Before that: ErrorPage (401 → the inline sign-in form, 403 "Access denied", 404 "Not found", transient errors with Try again) or PageLoading. A brew stored with a newer docSchemaVersion than this client (`isOpenableVersion`) shows NewerVersionPage (pages/edit/NewerVersionPage.tsx: "This brew needs a newer editor", Reload the page) instead of crashing in migrateDoc; /share does the same, and /new ignores such a draft. EditorApp edit/server with baseline (draft offer), recent 'edit', heading "Editing <title>", autoFocus. Delete → toast, then /user/<handle> (or /).
- /new (NewBrewSession): reads the 'new' draft from IndexedDB (readDraft(defaultDraftStore(), 'new')) before mounting. The draft's doc/style/snippets/meta become the initial content (no "Restore" offer: it is loaded directly). It waits for `me` first: whether the loaded draft is saved at once (`unsavedOnLoad`) depends on the sign-in hand-off (pages/new/signInHandoff.ts): a signed-out visitor marks sessionStorage 'hb-new-awaiting-sign-in' (`markAwaitingSignIn`); `saveLoadedDraft(hasDraft, signedIn, take?)` is true for a signed-out visitor with a draft (saved once they sign in on the page) and for a signed-in one who comes back with the mark (`takeAwaitingSignIn` reads and clears it: the sign-in redirect). A draft left from another time is shown to a signed-in user with "It is saved as a new brew when you edit it." and is not turned into a brew by itself. Banners: "Sign in to save" for anonymous visitors (new-sign-in-notice: Sign in → requestSignIn(), Create an account → /register?returnTo=/new) and "Your unsaved draft" (new-draft-notice) with "Start over" (new-start-over → ConfirmDialog "Start over?" → autosave off for one render, the draft deleted, then a fresh /new with `hbDraftDiscardedAt`; a draft written before that time is ignored). The first save POSTs (sign-in required, plan §1), then `navigate(/edit/:editId, { replace: true })` with the session adopted. Heading "New brew".
- /share/:shareId (SharePage): useBrewForShare; EditorApp view/none, recent 'view', heading = the title; ErrorPage for 404 and 423 (the lock page with shareMessage and code). Navbar items follow who is signed in now (live query data and `me`, not EditorApp's first brew): "Edit" (EditorNavItems) for authors (handle in BrewForShare.authors, with editId), "Clone" (nav-clone; useCloneBrew → /edit of the copy) for other signed-in readers, nothing when signed out. An author who signs in on the page gets one refetch (an author's view counts nothing) for the editId; other sign-ins and sign-outs refetch nothing (refreshUserData leaves loaded share views alone: every fetch counts a view). The view count ("1,234 views", share-views) is in the viewing bar. Pagination runs; nothing is saved.
- / (pages/home): the sr-only h1 "The Homebrewery" (data-route-focus) + HomeEditor: EditorApp edit/none with the bundled welcome brew, no navbar title, status note "Changes here are not saved" (home-not-saved), floating "Create your own" → /new (home-create). pages/home/welcomeBrew.ts: `WELCOME: WelcomeDocFile { source, generator, docSchemaVersion, theme, lang, title, style, doc }`, `welcomeBrew(file?) → { content, brew }`.
- web/src/pages/home/welcome.doc.json is generated ONCE by `npx tsx scripts/welcome-doc.ts` (from web/; `--check` exits 1 when stale; `--url <origin>` uses a running dev server, else it starts Vite with e2e/flows/vite.isolated.config.mjs on --port, default 5329). It drives Chromium on /dev/import (window.__hbImportApi.hbfmToDoc, theme 5ePHB, variables expanded, API answered 404 so themes are static) over legacy/client/homebrew/pages/homePage/welcome_msg.md. Result: 2 manual pages, the css block as style, about 99 KB; deterministic (--check passes on a second run).

E2E (web/e2e/flows, port 5329, API 5429):
- `node e2e/flows/run-flows.mjs [playwright args…]` (from web/; default e2e/flows): starts (or reuses) the API on :5429 (database hb_e2e_flows, migrated on start; Admin__Emails flows-admin@e2e.test and shell-admin@e2e.test; Spa__DevServerUrls = the Vite origin; --artifacts-path <tmp>/hb-artifacts-flows) and Vite on :5329 with e2e/flows/vite.isolated.config.mjs (no HMR/watch, cacheDir node_modules/.vite-isolated-flows, HB_API_URL). Then it runs Playwright with E2E_PORT, E2E_BASE_URL, HB_API_URL and FLOWS_ADMIN_EMAIL, and stops what it started. `node e2e/flows/run-flows.mjs e2e` runs the whole suite on those servers.
- flows.spec.ts (the plan §12 row): register → New → type → autosave (the URL becomes /edit/:editId, same editor) → reload → Share → read-only (contenteditable=false, aria-readonly, typing changes nothing) → print media: no chrome visible, every .page 8.5×11 in with no margins or shadow, stacked edge to edge from the top (page i starts sheet i), and in Chromium page.pdf() has exactly as many pages as .page elements. Also axe (all impacts) on /edit and /share outside the brew pages, and the author's visit counted no view.
- pages.spec.ts: share views (the author's none, an anonymous one), anonymous /edit → sign-in form → the brew, 403/404 pages, the /new draft through a reload and the navbar sign-in redirect → POST → /edit, a leftover draft shown but only saved once edited (a new tab, no hand-off), Start over, a closed tab's changes offered on /edit and restored, 409 with two tabs (dialog, Load the saved version), Mod-S (saved within 2.5 s), Mod-P and the Print button (window.print stubbed), Properties (title and theme saved, canvas restyled), lock (editor banner + request review; the share page's 423 lock page). Skipped unless HB_API_URL is a private API (`privateApi`); the lock test also needs FLOWS_ADMIN_EMAIL.
- home.spec.ts (API stubbed by pathname; runs anywhere): the welcome brew renders and is editable, nothing is requested from /api/brews or written to IndexedDB, Ctrl+S explains, undo, Create your own; axe; the Print button and Ctrl+P from the navbar; outline, style drawer → canvas restyle, an Insert menu snippet as one undo step.
- Helpers (e2e/flows/helpers.ts): privateApi, adminEmail, uniqueEmail, nav, docOf, signUpApi, signInApi, registerOnly, createBrewApi, storedBrew, editorRoot, waitForEditor, openEditorPage, typeAt, editorTexts (null while no editor is mounted), saveStatus, appRoot, waitForDraft(page, key, text), waitForNewDraft, stubPrint/printCount, chromeViolations (axe, all impacts, brew pages excluded), printLayout, pdfPageCount. The IndexedDB probes never create the database (they abort an upgrade).
- ROUTE-LEVEL VITEST (web/src/pages/routeTesting.tsx, Vitest only): the app's real `routes` in a memory router over an in-memory brew API. `createBrewServer({ me?, brews? })` → BrewServer { me (the session; null = expired), loginAs (who POST /api/auth/login signs in), brews (Map editId → FakeBrew), requests, log ('METHOD /path status'), override, delays ('METHOD /path' prefix → ms) } answering /api/account/me, logout, /api/auth/login, themes, notices, user lists, GET edit/share (share counts views for non-authors), POST /api/brews (ids newA, newB, …), PUT (409 { serverVersion } on a stale baseVersion), DELETE. `fakeBrew(editId, overrides?)`, `pageDoc(text)`, `docText(doc)`, `editView(brew)`, `logOf(server, method, path)`, `renderApp({ url, me? })` → { router, queryClient, user, … }, `appEditor()` (the dev API's editor), `typeInEditor(text)`, `pressSaveKey()`, `preloadAppPages()` (call in beforeAll with a long timeout: in a full parallel run the lazy EditorApp chunk took longer than a test's waits). Mock the theme loader in the test file (see pages/edit/editorRoute.test.tsx). Also polyfills Range.getClientRects/getBoundingClientRect for jsdom. Used by pages/edit/editorRoute.test.tsx, pages/share/sharePage.test.tsx and the save lane's editor/save/appRoutes.test.tsx.
- web/e2e/shell/narrow.spec.ts (API stubbed, both browsers): 320 px navbar on /edit and someone else's /share (no overflow, the account item on screen and usable); 390 px editor panels (closed by default, one at a time, inside the screen, the canvas keeps ≥ 200 px, nothing stored). It serves /share/* documents from '/' itself (Vite proxies /share to the API).

### Notes for later phases
- Integration fixes in other lanes' files (all minimal):
  - web/src/editor/objects/objectLayer.module.css (objects lane): appended `.toolbar.toolbar[hidden], .button.button[hidden] { display: none }`. The object toolbar's `display: flex` beat the hidden attribute, so the toolbar showed at the object layer's corner on every page load with no object selected, and the edit / put-back buttons showed for every object kind.
  - web/src/api/brews.ts (foundation lane): `brewQueries.share` no longer passes the abort signal. Every share fetch counts a view; in dev (React StrictMode) the first request was cancelled at the remount and sent again, so one anonymous visit counted 2 views. The request in flight is reused now (src/pages/share/shareQuery.test.tsx fails without the fix).
  - web/src/app/App.test.tsx (shell lane): /edit/abc123 and /share/abc123 now expect the 404 page ('Not found'); the mocked API has no such brew.
  - web/e2e/smoke.spec.ts (P0): the h1 check uses `name: 'The Homebrewery', exact: true` (the welcome brew's own h1 "The Homebrewery V3" matched too), and axe excludes `.hb-canvas .ProseMirror > .page` (upstream's welcome text skips heading levels: heading-order, moderate). The app chrome has zero violations.
  - web/e2e/shell/shell.spec.ts (shell lane): the home test's h1 check uses `exact: true`, for the same reason.
- web/src/pages/HomePage.tsx (the original placeholder, not mine) is no longer imported by anything; it can be deleted.
- Title: a new brew shows "Untitled brew" until it has a title (Properties) or the server stores its first heading as the title (SaveBrewResponse.title).
- /new for anonymous visitors: typing leads to one 401 POST after the autosave delay. The status then says "Not saved" with "Sign in to save", and autosave's beforeunload warning asks before leaving (the changes can't be saved). The draft is in IndexedDB either way. Tests that reload such a page accept the dialog.
- The brew's own snippets (brews.snippets) are loaded, saved back unchanged and listed under "Brew Snippets" in the Insert menu; there is no editor for them yet.
- ErrorNavItem is not used: SaveStatus reports save failures in the toolbar.
- Phone widths: on a compact screen (≤ 720 px) the side panels start closed, open one at a time, and are sheets over the canvas (UI store + SplitPanel CSS; the stored open state stays the wide-screen preference). The editing toolbars still wrap to several rows (toolbar lane). The navbar fits 320 px (tighter items and no chevrons under 400 px, wrapping as a fallback). e2e/shell/narrow.spec.ts checks both (API stubbed).
- Test data: users flows-*@e2e.test, flows-admin@e2e.test (Admin) and shots-*@e2e.test with their brews live in the private database hb_e2e_flows on the compose Postgres, not in 'homebrewery'. Drop it whenever you like.
- E2E environment: the flows run against the isolated Vite (no HMR), so edits to the tree need a Vite restart before they show. The editor's route module is large: a client-side navigation to /new or /share waits for it before the URL changes, so URL assertions after such clicks use the 90 s load timeout.
- Bundle: the EditorApp chunk carries TipTap, pagination, CodeMirror, the snippets pipeline and every panel. Lazy-loading the closed drawers (Style drawer with CodeMirror and Prettier, Inspector) and the share view's editing-only code would shrink the first load of /share and /. I checked the production bundle with `npx vite build --outDir <scratch dir>` (not `npm run build`, which writes wwwroot): it builds, and the snippets lane's forbidden-module check passes.
- Phase-3 review fixes (app area) in other lanes' files, all minimal: web/src/editor/save/snapshots.ts gained `SnapshotHistory.clear(brewKey)` (deletes the brew's five slots; used when a brew is deleted); web/e2e/panels/navigation.spec.ts "the current page follows scrolling" waits for the wheel scroll to stop, then polls current page = most visible page (see the Firefox note below).
- Firefox flake in e2e/panels/navigation.spec.ts "the current page follows scrolling" (root cause): Firefox animates wheel scrolling after page.mouse.wheel() returns (Chromium's synthetic wheel scrolls at once; sampled scrollTop was final at the first read), and the page tracker follows the animation through the pages in between (IntersectionObserver entries a frame later). The test polled "current page > 5" with the default 5 s timeout and then compared once: on a loaded machine the scroll alone took over 5 s (timeouts; the page later showed 7), and a poll that passed mid-scroll compared page 6 with the final most-visible page 7 ("Expected 7, Received 6"). Not a tracker bug. After the change the test passed 16 of 16 in Firefox (4 workers). A later run of the whole spec 3× in Firefox on the overloaded machine (15 min for 33 tests) had 5 failures, all environment timeouts (page.goto, page.evaluate or context teardown over 90 s) spread over different tests; none came from this test's assertions. Run again with fewer workers, the whole spec passed 11 of 11 in each browser.
- Not done here (save lane's files): scoping the shared 'new' draft to its signed-in author (SEC-1 optional part / SAVE-12: a Draft.ownerId written by autosave, checked by NewBrewSession), and stripping `authors` from snapshot meta at record time (defence in depth for SAVE-5; EditorApp now strips it on restore). A deliberate sign-out now saves pending /new work first, so a leftover 'new' draft remains only after a failed create.

## Security review, CSP and security headers (P8.3, plan §11, §14)

### Interfaces
- docs/security.md is the review record: a threat model summary, every header with its reason, the CSP decisions, the plan §14 table (each item with the file or test that proves it), the fresh-review findings SR-1..SR-14, and the residual risks R-1..R-8. It also has rules for new code (no inline script/handlers/eval; other origins only over https; workers and real iframes need a policy change first).
- src/Homebrewery.Api/Infrastructure/SecurityHeaders.cs:
  - `AddSecurityHeaders()`: options, startup validation, and Kestrel's `Server` header off.
  - `UseSecurityHeaders()`: the first middleware, which adds headers in `Response.OnStarting`, so errors, 429s, static files and the share shell get them too. A header that an endpoint set itself is kept.
  - Pages get `SecurityHeaders.DocumentPolicy` (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`), plus `upgrade-insecure-requests` on HTTPS.
  - `/api`, `/openapi` and `/healthz` (`SecurityHeaders.IsApiPath`) get `ApiPolicy` (`default-src 'none'; …`), `Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: no-store` unless the endpoint set its own.
  - Every response gets nosniff, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (the constant; only feature names Chromium knows), `Cross-Origin-Opener-Policy: same-origin` and `X-Frame-Options: DENY`.
  - HSTS (`max-age=31536000`) is sent on HTTPS responses (also through forwarded headers) except to loopback hosts.
- Configuration (section SecurityHeaders):
  - `Csp`: Enforce | ReportOnly | Off. Unset means Enforce, but Off in Development, where Vite's inline React refresh preamble needs inline script.
  - `CspReportUri`: an https URL or `/path`, validated at startup.
  - `HstsMaxAge` (365 days) and `HstsIncludeSubDomains` (false).
  - `SecurityHeaders.CspKey` = "SecurityHeaders:Csp".
- Program.cs wiring (already in place): `builder.Services.AddSecurityHeaders()` and `app.UseSecurityHeaders()` right after UseRequestLogging, before UseExceptionHandler.
- Tests (tests/Homebrewery.Api.Tests/Security):
  - SecurityHeadersTests covers the page, share shell, API, 429 and HTTPS/HSTS headers, the proxy, the modes, the report URI, the Server header, and index.html and share shell HTML parsed with AngleSharp (no inline script, style element, `on*` or `javascript:`).
  - ContentPolicyAlignmentTests: stored raw HTML keeps nothing the policy blocks, including form controls.
  - EndpointAuditTests: plan §14 against the live route table (admin role on every /api/admin route, authorization on every write outside /api/auth, no stream endpoint, no default admin, a token-free cookie sign-in).
- E2E (web/e2e/security, port 5377, API 5477): `node e2e/security/run-csp.mjs [playwright args…]` from web/.
  - It runs `vite build` into <tmp>/hb-security-wwwroot (never the shared wwwroot; `SECURITY_WEBROOT` reuses a build).
  - It starts the API in **Production** on :5477 with `ASPNETCORE_WEBROOT` at that build and its own database hb_e2e_security (migrated on start), with admin security-admin@e2e.test (no confirmed email needed) and generous rate limits.
  - It then runs `playwright test e2e/security` (default `--workers=3`) with E2E_BASE_URL and HB_CSP_E2E=1. Without HB_CSP_E2E the spec skips, so the normal suites (Vite dev, no policy) skip it.
- csp.spec.ts, 7 tests × Chromium and Firefox:
  - A canary: an inline script, an inline handler and an http: image are blocked and reported; an https image loads.
  - The home page and /new; signed-out site pages plus a seeded share page (its https image, raw HTML, and the web font from the user CSS `@import` all load); the register and sign-in forms.
  - Editing: typing, autosave, the Insert menu stat block, the Style drawer (typed CSS), Outline, Properties, reload, the share page, the user page, the account page.
  - Import: paste → probe → create; the admin pages.
  - Each test fails on any `securitypolicyviolation` event (a binding plus an init script in every document) or on a console message about CSP or Permissions-Policy. In Chromium the console also covers the script-less probe iframes.
  - Other origins are stubbed with `context.route`. Blocked requests never reach the stubs.

### Notes for later phases
- Result 2026-09-26: all 14 walks pass with zero violations. Security namespace: 150/150.
  - `npm audit --omit=dev`: 0 vulnerabilities. `dotnet list package --vulnerable --include-transitive`: none.
  - The production bundle has no eval or `new Function`. The built index.html has only external module scripts and stylesheets. web/index.html needed no change.
- `style-src 'unsafe-inline'` is required. Evidence: a run with that token removed saw Chromium block TipTap's `<style data-tiptap-style>`, CodeMirror style-mod's `<style>`, ProseMirror style attributes, and the import probe's `<style>` elements. Nonces would need a per-request `index.html`.
- `connect-src https:` exists for `cssScope.inlineCssImports` (user CSS `@import`, such as Google Fonts). The trade-off is in docs/security.md.
- Anything that adds a Worker (`blob:` or a file), a non-about:blank iframe, `<object>`, a cross-origin fetch over http:, or eval-like code (for example lodash `template`, or a template engine) must change `SecurityHeaders.DocumentPolicy`, SecurityHeadersTests and docs/security.md, and run `node e2e/security/run-csp.mjs`.
- Export lane: the export probe's `doc.write` into an about:blank iframe inherits the page policy. An exported document with inline `<script>` would only log a violation there, but keep scripts out of exports anyway.
- New walk steps belong in e2e/security/csp.spec.ts: pages must pass there in both browsers. Firefox is slow with the big welcome brew under parallel load, so the runner defaults to 3 workers.
- Deploy notes, not code (docs/security.md R-3/R-4):
  - When the app's port is reachable by anything other than the proxy, set `ForwardedHeaders:KnownProxies`/`KnownNetworks`.
  - Set `AllowedHosts` to the site's host name in production.
  - Optionally set `Auth:CookieSecurePolicy=Always` behind TLS.
- The Caddyfile needed no change: in production-image mode every response comes from the app with its headers, and in dev mode pages come from Vite without a policy (by design). The walk used `dotnet run` in Production with a private build instead of the compose prod image, because that image is published on the humans' port 8080. The code path is the same (the Production environment and the same wwwroot content).
- Other lanes' files: none changed.


## User page and vault: list pages, brew items (P7.3, plan §9)

### Interfaces
ROUTES (lazy, default exports, as the shell expects):
- /user/:handle → web/src/pages/user/index.tsx. It loads GET /api/users/{handle}/brews once (useUserBrews; at most 1000 brews) and sorts and filters in the browser, as upstream did. The component is keyed by the normalised handle, so another user's page starts fresh.
  - Other people see "<handle>’s brews" with one group, published. The owner (own=true) sees "Your brews" with published, unpublished and, only when there are any, "Brews you are invited to edit" (role 'invited').
  - Loading keeps the h1 "<handle>’s brews" with PageLoading. A 404 shows ErrorPage "User not found" ("No one has the handle …"). Other errors show ErrorPage with Try again.
  - When total > items.length the page says "Only the N brews updated most recently are listed here, of M." (list-capped). An owner without brews gets "Create a brew" and "Import a brew" links (list-no-brews).
  - URL state: ?sort=&dir=&filter=&tag=a&tag=b (tags in click order). Every change writes the URL with replace, as upstream's replaceState did. The page's state follows URL changes it did not make (a "My brews" link, Back). It remembers its own recent writes, so a late transition from fast typing can't reset the field.
- /vault → web/src/pages/vault/index.tsx. It calls GET /api/vault (useVaultSearch with keepPreviousData and errorPolicy 'manual', so errors show in place, not as toasts).
  - The URL is the state: ?q=&author=&sort=&dir=&page=&pageSize=, written canonically with defaults left out. Upstream links (?title=&count=&sort=createdAt|updatedAt, v3/legacy ignored) are read.
  - Form: Search (websearch syntax; maxLength 256), Author (handle), Results per page (10/20/40/60), Search, and Clear (shown while q or author is set). The form follows the URL but keeps unsent typing.
  - The sort bar and the page links push history entries, so Back works. Relevance is offered only with a search.
  - Status line (role=status): "N brews found. Page x of y." / "No brews found." / "Searching…" / "Check the search." / "Couldn't search the vault."
  - Errors: a 400 errors.q goes on the search field (aria-invalid) with an alert "Fix the search above and try again." Other errors show an alert with describeApiError and Try again.
  - Empty states: no match (with advice), no published brews at all, and a page past the end ("the results end on page N").
  - Pagination: upstream's window of ten, plus first and last links, Previous and Next. Every page is a link (aria-current="page" on the current one). Following one moves focus to the "Results" h2.

PORTED MODULES:
- web/src/ported/listPage/listModel.ts (pure, unit tested):
  - Sorting: LIST_SORTS ['title','created','updated','views','pages'], ListSort, SortDir, LIST_SORT_LABELS, parseListSort (also accepts upstream's alpha/createdAt/updatedAt), parseSortDir, defaultDirFor (title asc, the rest desc), dirLabel (e.g. "A to Z", "newest first", "best match first").
  - deburr (lodash's, no dependency), UNTITLED 'Untitled brew', displayTitle.
  - sortBrews: titles compared without case or accents, numbers naturally; ties go to the most recently updated, then the shareId.
  - filterBrews: upstream's rule. The text must appear in the title, the description or the tags, ignoring case and accents, and the brew must have every selected tag, ignoring case.
  - Tags: toggleTag, hasTag, sortTags (upstream's order), tagParts.
  - URL: ListState {filter, tags, sort, dir}, SortPrefs, LIST_QUERY_KEYS, readListQuery(params, prefs), writeListQuery(params, state) (keeps other parameters).
  - Groups: GROUP_IDS, GroupId, BrewGroup {id, title, brews, empty}, possessive, groupUserBrews(list), visibleGroups.
  - Counts: formatCount, brewCount, countSummary.
- web/src/ported/listPage/listPrefs.ts: per-browser preferences in localStorage 'hb-list-page' {sort, dir, collapsed: GroupId[]}. The store is createLocalStore, validated field by field, with an in-memory fallback when storage is blocked. When the key is absent, upstream's HB_listPage_sortType, HB_listPage_sortDir and HB_listPage_visibility_group_<id> are imported once. Also listPrefsStore(), useListPrefs(), setSortPrefs, setGroupCollapsed, parseListPrefs, readLegacyListPrefs, createListPrefsStore, resetListPrefsStoreForTests.
- `ListPage({ groups, state, onStateChange, collapsed, onToggleGroup, renderItem, children? })`: the controlled list UI.
  - Controls: the SortBar and the Filter field (type=search).
  - The selected tag filters show as a role=group "Tags" of chips ("Remove the tag filter <tag>").
  - The result count (role=status) and "Clear filters".
  - The groups are sections. Each h2 holds a disclosure button (aria-expanded/aria-controls, with the count, or "k of n" while filtering). Items go in a responsive grid (one column on phones).
- `SortBar<T>({ options, sort, dir, onChange, defaultDir, label? = 'Sort by' })`: a role=group of toggle buttons (aria-pressed). The active one shows the direction and reverses it when pressed again. The direction is in the button's name ("Views, most first"). The vault uses it too.
- web/src/ported/listPage/testing.ts (Vitest only): `summary(shareId, overrides)` → BrewSummary.
- `BrewItem({ brew, headingLevel? = 3, onTagClick?, selectedTags?, actions?, now?, className? })` (web/src/ported/brewItem/BrewItem.tsx):
  - Layout: an article named by its title, with an hN link to /share/:shareId. The thumbnail is decorative, lazy-loaded and no-referrer, and is dropped if it fails to load. Then a Locked badge, the description (3 lines), and tags as colour tones for type/group/meta/system, with the prefix kept for screen readers. Tags are toggle buttons with aria-pressed when onTagClick is given, plain labels otherwise.
  - Details list: author links to /user/:handle, "N views" (title: last viewed), "N pages", "Updated <relative>" (with a <time>) and "Created <date>".
  - Actions: Edit (link, own brews: editId), Copy link, Clone (signed in, not locked), Download (own), and Delete / Remove / Decline (own, worded by role). Every action has an aria-label "<Action> <title>" that contains its visible text.
  - `BrewItemActions { onCopyLink?, onClone?, cloning?, onDownload?, downloading?, onRemove? }`: an action without its callback is not shown.
- `useBrewActions({ signedIn, onRemoved?, focusAfterRemoval? })` → { actionsFor(brew), dialog } (web/src/ported/brewItem/useBrewActions.tsx):
  - Copy link (clipboard, then the toast "Share link copied" or "Couldn't copy the link", both showing the URL).
  - Clone (useCloneBrew, then navigate to the copy's /edit).
  - Download (fetchBrewForEdit, then a JSON file; no view is counted).
  - Remove: one danger ConfirmDialog, then useDeleteBrew (DELETE /api/brews/{editId}), then a toast. It forgets the brew on this device, as the editor does after a delete: its Recent brews entries, drafts and local snapshots. Then it moves focus (the user page: the next brew's title link, else the previous one, else the group toggle).
  - Also `copyShareLink(shareId)`.
- web/src/ported/brewItem/brewItemModel.ts:
  - `removeCopy(brew)`: label, title, message, confirmLabel and done(brewDeleted), per role (see the dropped list below).
  - viewCount, pageCount, formatDate, fileNameFor.
  - `brewFile(BrewForEdit)` → {name '<title>.json', text}: format 'homebrewery-brew', formatVersion 1, exportedAt, shareId, docSchemaVersion, version, createdAt, updatedAt, meta, authors (handles without the invited ones), style, snippets, doc, sourceMarkdown.
  - `saveTextFile(name, text, type?)`.
- web/src/ported/brewItem/brewIcons.tsx: `BrewIcon` for pencil, pages, clock, calendar, link and clone (the UI kit has no such icons).
- web/src/pages/vault/vaultQuery.ts (pure, unit tested): VAULT_SORTS, VAULT_SORT_LABELS, PAGE_SIZES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_PAGE, MAX_QUERY_LENGTH, VaultQuery, parseVaultSort, parseVaultDir, readVaultQuery, writeVaultQuery, vaultSearchParams, effectiveSort and effectiveDir (the API's defaults), totalPages, pageWindow. Pagination.tsx: `Pagination({ page, pages, searchFor, onNavigate? })`.
- Test ids:
  - User page: user-page, list-page, list-sort, list-filter, list-tag-filters, list-count, list-clear-filters, list-group-<published|unpublished|invited> (data-group), list-capped, list-no-brews.
  - Brew item: brew-item (data-share-id, data-thumbnail), brew-thumbnail, brew-locked, brew-views, brew-pages, brew-updated, brew-created, brew-edit, brew-copy-link, brew-clone, brew-download, brew-remove.
  - Vault: vault-page, vault-form, vault-q, vault-author, vault-page-size, vault-submit, vault-clear, vault-results (aria-busy while fetching), vault-sort, vault-status, vault-error, vault-retry, vault-empty, vault-items, vault-pagination, vault-previous, vault-next.

UPSTREAM PARITY (legacy basePages/listPage, brewItem, userPage, vaultPage):
- Matched on the list page:
  - Sort by title (deburred, case-insensitive), created, updated and views; direction by pressing the active sort again.
  - Defaults: title A to Z. The sort, direction and closed groups are remembered per browser, and upstream's keys are imported.
  - The text filter over title, description and tags. Tag filters toggle from an item's tags, show as removable chips and must all match (case-insensitive).
  - Everything in the URL with replaceState semantics; upstream links (?sort=alpha|createdAt) are read.
  - Collapsible published and unpublished groups (unpublished for the owner only); upstream's possessive rule ("james’").
- Matched on the brew item:
  - Thumbnail, title, description, tags (with prefix colours and upstream's order), author links, views (with the last-viewed tooltip), page count, and updated (relative) with created.
  - Share (the title link, plus Copy link), Edit, Download (own brews) and Delete.
- Matched on the vault:
  - Title/text search and author, and results per page 10/20/40/60.
  - Sort title/created/updated/views with direction, and the total count.
  - Upstream's ten-page window with the first page, the last page, Previous and Next.
  - Search tips, a searching state, a no-result state, an error state, and the state in the URL.
- New:
  - A page-count sort and the invited group.
  - Clone for signed-in readers (not for locked brews) and a Locked badge.
  - A relevance sort (with a search).
  - Websearch syntax: "phrase", -word, or.
  - Links for pages (Back and Forward work).
  - Removal worded by role, with focus management instead of a page reload.
  - One-column layouts on phones.
- Dropped or changed, with reasons:
  - The storage icon (Google Drive or Homebrewery): there is no Google Drive storage.
  - The "hidden" author placeholder: handles are validated and never emails.
  - Upstream's commented-out "latest" (last viewed) sort.
  - The vault's v3/legacy renderer checkboxes: every brew here is one kind.
  - Upstream's "title of at least 3 characters or an author" rule: an empty search lists the most recently updated brews.
  - The MongoDB stop-word tip: the 'simple' search configuration has no stop words and no stemming, so the tips say "whole words match".
  - "Usernames are case-sensitive": handles are case-insensitive here.
  - Actions opened new tabs (target=_blank): here they are in-app links.
  - The hover-revealed icon links became always-visible labelled buttons.
  - Two window.confirm prompts became one ConfirmDialog.
  - Download for other people's brews: upstream's /download/:id gave anyone the markdown without counting a view. Here the only public source is GET /api/brews/share/{id}, which counts a view, so Download is offered only for brews the reader can edit (the edit endpoint). The file is the stored brew as JSON (the source of a brew is its document), including sourceMarkdown for imported brews.
  - Print is not a list action: printing needs the paginated editor, and /share and /edit have Print (Ctrl+P).
  - The vault's tags are labels, not filters: the API has no tag filter, and its search vector is title, description and text.
  - The ErrorNavItem on list pages: errors use the app's policy (toasts for failed actions, ErrorPage for a failed list, in-place alerts on the vault).
- Removal wording (DELETE /api/brews/{editId} removes the caller; AccessPolicy):
  - "Delete" when the reader is the only non-invited author. The brew is gone; pending invitations don't keep it.
  - "Remove" with other authors. For an owner the message says the next author becomes the owner.
  - "Decline" for an invitation.

TESTS:
- Vitest (74 tests in 8 files):
  - Pure: listModel, listPrefs, brewItemModel, vaultQuery.
  - Components: BrewItem.test.tsx and ListPage.test.tsx (the sort bar, filters, tag chips, group disclosure from the keyboard, empty groups).
  - pages/user/userPage.test.tsx (renderRoute + mockApi): visitor and owner views; URL state (replace), external URL changes and remembered prefs; delete (confirm, focus to the next brew, toast), cancel (focus returns), decline, clone (navigates), copy link (clipboard), download (Blob JSON and file name); capped and empty lists; 404 and 500.
  - pages/vault/vaultPage.test.tsx (a fake /api/vault that searches, sorts and pages): the default list, form submit into the URL, sort toggles, page links with focus and Back, upstream links, the form following the URL, empty and past-the-end states, the q field error, a 503 with Try again, Clone when signed in, and Clear.
- E2E (web/e2e/lists, real API, both browsers): `node e2e/lists/run-lists.mjs [playwright args]` from web/.
  - It starts (or reuses) the API on :5472 (database hb_e2e_lists, migrated on start; RateLimits__Auth__PermitLimit=2000 and RateLimits__Writes__PermitLimit=10000, because every test registers accounts and seeds brews from one IP) and Vite on :5372 with e2e/lists/vite.isolated.config.mjs (no HMR, cacheDir node_modules/.vite-isolated-lists).
  - Env: LISTS_API_PORT, E2E_PORT, LISTS_API_DB, HB_ARTIFACTS. The specs skip without a private HB_API_URL.
  - Flags alone (--project=firefox, -g …, --workers=4) keep the e2e/lists path; only a path-like argument replaces it. run-flows.mjs replaces its default path with any argument, so `run-flows.mjs --workers=4` runs the whole suite.
  - Helpers (e2e/lists/helpers.ts): the specs' `test` adds an `account({ browser?, prefix? })` fixture: a new account (register, sign in, unique handle). With `browser: true` it is signed in in the test's own context, so the `page` fixture is that user (one per test). Otherwise the account lives in an API-only request context, disposed after the test. The specs open no extra browser contexts: with other lanes' Firefox suites running (80+ Firefox processes), Firefox sometimes hung in browserContext.newPage, and at first unclosed extra contexts piled up too. Also signUp, createBrew (meta, page count, invited authors), captureDownloads/capturedBlobs/blockedDownloads (see the Firefox download note below), DOM_READY, saveAs (turns an invited user into an author), addViews (anonymous share fetches), authorsOf, groupTitles, vaultTitles, brewItem, axeViolations (all impacts), horizontalOverflow, offscreen, and `expect` with a 15 s timeout.
  - Budget: 300 s per test. With other lanes' Firefox suites running, one Firefox test took about 2.8 minutes (fresh contexts load the dev server's modules cold, and axe is slow).
  - user.spec.ts:
    - A visitor sees only published brews; sort by pages, the filter and a tag go into the URL and survive a reload; axe.
    - The owner's groups (axe), Edit links, Download and Delete (the brew is 404 afterwards, focus goes to the next brew).
    - Remove (a co-authored brew stays the other author's) and Decline an invitation.
    - A signed-in reader: Copy link (the clipboard in Chromium, the toast in both) and Clone (lands on /edit/<copy>, the copy is in their list).
    - Keyboard only: sort buttons, group toggle, tag chip, and the delete dialog (Escape returns focus, then confirm).
    - 320 px in dark mode: no sideways overflow, nothing off screen, axe with the dialog open too.
    - An unknown handle shows the not-found page.
  - vault.spec.ts:
    - Websearch syntax (two words, -word, "phrase"); the author filter (any case); unpublished brews never show; sort title asc/desc and views; reload and Back; axe.
    - 12 brews at pageSize 10: Next page, focus on Results, a page link by keyboard, Back, and page size 20 removes the pages.
    - The empty state and the 400 field error (light and dark axe).
    - A stubbed 500 with Try again (axe).
    - 320 px: the form stacks above the results, no overflow, axe.
  - Every test seeds its own accounts (lst-*@e2e.test with lst-* handles) and searches for its own unique word, so earlier runs' data never matters.
  - Results (the final run through run-lists.mjs, 4 workers, both browsers, with five other lanes' Firefox suites running):
    - Chromium passed 12 of 12, as in every run since the first fixes.
    - Firefox passed 10 of 12. Both failures hung in Playwright/Firefox outside the test's own steps: one in the `page` fixture's setup ("Test timeout … while setting up page"), one in page.reload waiting for DOMContentLoaded. Both passed when rerun (50 s and 1 min).
    - Firefox needed the four mitigations above (no extra contexts, axe legacy mode, DOM_READY, no real downloads). Before them, runs lost 2 or 3 Firefox tests each to such hangs.

### Notes for later phases
- Integration: web/src/app/App.test.tsx (shell lane) now expects "User not found" for /user/someone: its mocked API answers 404, and the page is real now. This was my only edit outside my paths.
- Shell lane: e2e/shell/shell.spec.ts's /vault axe test stubs every /api call with 404, so the vault now shows its in-place error (alert + Try again) there. The vault spec checks that state with axe (a 500 stub), but I did not run the shell spec.
- Firefox and axe (for every lane with axe e2e): @axe-core/playwright's default `analyze()` finishes in a new blank page (`finishRun`: context.newPage(), then evaluate). With other lanes' Firefox suites running, that newPage, or the evaluate on the blank page, sometimes hung until the test timeout (5 min plus teardown). The traces pointed inside `axeViolations`. `new AxeBuilder({ page }).setLegacyMode(true)` runs axe in the page itself and fixed it for my specs; it only drops cross-frame (iframe) scanning. The e2e specs that call AxeBuilder without it are e2e/a11y, admin, export, flows, import-ui, inspector, objects, panels, save, sections, shell, smoke and snippets. If they time out in Firefox under load at an axe call, this is the likely cause. My phone tests also set the viewport and colour scheme with `test.use` (context options) rather than setViewportSize/emulateMedia right before the navigation. With five other lanes' Firefox suites running, page.goto waiting for 'load' also hung for 5 minutes on a test's first navigation, and Firefox's context.close sometimes hung at teardown. Vite answered in milliseconds, and index.html has no external resources. My navigations now use `DOM_READY` ({ waitUntil: 'domcontentloaded' }, as flows' openEditorPage does), and every spec then waits for real content. Teardown hangs are outside a spec's control.
- Firefox downloads (for the export lane too): on this Windows machine, once a real download started in Playwright's Firefox, Firefox often stopped answering. page.evaluate and download.path() waited until the test timed out, and Firefox's log showed its Windows download-taskbar component failing (DownloadsTaskbar … NS_ERROR_ILLEGAL_VALUE). The owner test therefore does a real download only in Chromium: the event, the suggested file name, and the file equal to the Blob the app created. In Firefox, e2e/lists/helpers.ts `captureDownloads(page, { blockDownloads: true })` records the <a download href="blob:…"> click (its file name) and the Blob's text instead of starting the download. Both browsers check the name and the JSON content.
- The scratchpad directory is shared by the lanes of one workflow session: the admin lane's Vite log overwrote my `vite.log` there. Use lane-prefixed file names.
- jsdom and accessible names: dom-accessibility-api (Testing Library's getByRole name) trims the text of each child element. "Delete<VisuallyHidden> Title</VisuallyHidden>" becomes "DeleteTitle" in jsdom, though browsers say "Delete Title". Composed names here use aria-label (containing the visible text, for WCAG 2.5.3). Other lanes may hit the same issue.
- Backend (optional, for upstream parity): a view-free public source endpoint (for example GET /api/brews/{shareId}/source, or a flag on the share endpoint that doesn't count the view) would let the list offer Download for every brew, as upstream's /download did. A vault `tags` filter would make the vault's tags clickable, like the user page's.
- Import lane: the Download file ({format:'homebrewery-brew', formatVersion:1, doc, style, snippets, meta, sourceMarkdown, …}) could be accepted by /import as a lossless re-import.
- Export/print lane: if /share gains a print-on-load switch (for example ?print=1), a "Print" item action is a one-line addition in BrewItem.
- Performance: the user page renders every brew it has (at most 1000), like upstream. Sorting and filtering are memoised per state change. If very large accounts feel slow, add `content-visibility: auto` to .itemCell or virtualise the grid.
- Data: accounts lst-*@e2e.test and their brews live in the private database hb_e2e_lists on the compose Postgres. Drop it whenever you like.
- Process: I edited only my paths (web/src/pages/{user,vault}/**, web/src/ported/{listPage,brewItem}/**, web/e2e/lists/**), the one test line above and this section. No packages were added and no git commands were run. The API ran with --artifacts-path C:/Users/ranky/AppData/Local/Temp/hb-artifacts-lists. One mistake: an early version of run-lists.mjs, given only flags, started the whole e2e suite (1022 tests) against my private servers (:5472 and :5372). I stopped it after about 37 tests and killed its processes, then fixed the runner (above). It used no other lane's ports; any data it created is in hb_e2e_lists.


## Operations: logging, health probes, migrate command, backups, managed PostgreSQL (P8.4, plan §11)

### Interfaces
Guide: docs/operations.md (deploy, configuration reference, secrets, managed PostgreSQL, migrations and upgrades, backups and restore, logs, health, Data Protection keys, rate limits, admin accounts). README "Running in production" links to it.

C# (src/Homebrewery.Api/Infrastructure):
- AppLogging.AddAppLogging() (Program.cs, next to AddAppHealthChecks): console formatter `json` outside Development, `simple` in Development, unless `Logging:Console:FormatterName` is set. JSON options: IncludeScopes, UseUtcTimestamp, TimestampFormat `yyyy-MM-dd'T'HH:mm:ss.fff'Z'` (AppLogging.TimestampFormat); `Logging:Console:FormatterOptions:*` overrides. Constants FormatterNameKey, FormatterOptionsSection.
- RequestLogging middleware, `app.UseRequestLogging()` (first after Build). One entry per request: category `Homebrewery.Api.Infrastructure.RequestLogging`, EventId 1 `RequestFinished`, state Method, Route (the endpoint's route template; the path only when no endpoint matched, without query, cut at MaxPathLength 200), StatusCode, ElapsedMs. Levels: Error for 5xx (also when an exception escapes: logged as 500, rethrown), Debug for 2xx/3xx health probes (/healthz*) and endpoint-less requests (static files), Information otherwise. Scope `RequestId` = `Activity.Current?.Id ?? HttpContext.TraceIdentifier` (RequestLogging.RequestIdOf), which is the problem+json `traceId`. Internal: RouteOf, LevelFor.
- MigrateCommand: `dotnet Homebrewery.Api.dll migrate` / `docker run … image migrate` / `docker compose … run --rm app migrate`. First argument `migrate` (case-insensitive; MigrateCommand.IsRequested). Runs DatabaseInitializer with Database:MigrateOnStartup forced on (connection-string check, MigrateAsync, Admin role + Admin:Emails), logs `The database is up to date: N migrations applied, the latest is X.` and exits 0; any failure: Critical `The migrate command failed.` with the exception, exit 1. The web server never starts. Later arguments are ordinary config switches.
- AppLifetime.RunOrExit() replaces `app.Run()`. When the start fails (the host has already logged Error `Hosting failed to start` with the exception) it rethrows, and registers an AppDomain.UnhandledException handler that calls Environment.Exit(1) (AppLifetime.StartupFailedExitCode) for exactly that exception object. The real process therefore exits 1 instead of the runtime crash (plain-text trace on stderr; exit 139/SIGSEGV in the Linux container, 0xE0434352 on Windows), while WebApplicationFactory, which runs the entry point and catches the exception, still sees start failures (the first version swallowed the exception and broke every '...stops the host' test). Exceptions after ApplicationStarted are untouched.
- HealthEndpoints (DatabaseHealthCheck.cs): Path `/healthz` (every check, unchanged), LivePath `/healthz/live` (no checks), ReadyPath `/healthz/ready` (checks tagged ReadyTag `ready`; DatabaseHealthCheck has it). Same body shape; MapAppHealthChecks() returns one convention builder for all three.

Program.cs lines this lane owns: `builder.Services.AddAppLogging();`, the `if (MigrateCommand.IsRequested(args)) { … return; }` line right after Build, `app.UseRequestLogging();`, and `app.RunOrExit();` (was `app.Run();`).

appsettings.json `Logging` (production levels): Default Information; Microsoft.AspNetCore Warning; Microsoft.AspNetCore.Hosting.Diagnostics None (at any other level the hosting layer adds a `RequestPath` scope with the raw path to every entry; also repeated under `Logging:EventLog:LogLevel`, because the Windows Event Log provider's own default rule would otherwise re-enable it); Microsoft.EntityFrameworkCore Warning; …Database.Command None; …Migrations Information.

Compose and deploy:
- compose.prod.yml: new `backup` service (postgres:18, `bash /opt/hb-backup/hb-backup.sh schedule`, init, restart unless-stopped; PG* env for the compose db; BACKUP_INTERVAL=${HB_BACKUP_INTERVAL:-1d}, BACKUP_KEEP=${HB_BACKUP_KEEP:-7}; volumes ./deploy/backup:/opt/hb-backup:ro and ${HB_BACKUP_VOLUME:-backups}:/backups; healthcheck `hb-backup.sh health`), top-level volume `backups`.
- deploy/backup/hb-backup.sh (bash, runs in postgres:18): `schedule | now [label] | list | verify <file|latest> | restore <file|latest> [--clean] [--no-owner] | health`. libpq env (PGHOST… PGSSLMODE; .NET spellings VerifyFull/VerifyCA/Require are normalized). BACKUP_DIR (/backups), BACKUP_INTERVAL (1d; s/m/h/d), BACKUP_KEEP (7; 0 = all), BACKUP_PREFIX (db name), BACKUP_RETRY_INTERVAL (5m), BACKUP_HEALTH_GRACE (1h), BACKUP_MAINTENANCE_DB (postgres). Files `<prefix>-<yyyymmddThhmmssZ>[-label].dump`, written as .partial and renamed after `pg_restore --list` succeeds; umask 077; flock on /backups/.lock for dumps, pruning and restores. Scheduled mode logs JSON lines (Category `hb-backup`). Restore default = check rolcreatedb/rolsuper, DROP DATABASE … WITH (FORCE), CREATE DATABASE, `pg_restore --exit-on-error --single-transaction`; `--clean` = `--clean --if-exists` into the existing database; then ANALYZE.
- deploy/scripts/backup-now.{sh,ps1} [label] (prints the file name), restore.{sh,ps1} <dump|latest|local file> [--yes] [--clean] [--no-owner] [--no-safety-backup] (safety `pre-restore` dump, stop app, restore, `up -d --no-deps --wait app`; on failure the app stays stopped). Compose files: COMPOSE_FILE / COMPOSE_ENV_FILES / COMPOSE_PROJECT_NAME when set, else docker-compose.yml + compose.prod.yml. HB_APP_SERVICE (app).
- deploy/compose.external-db.yml (standalone, `name: homebrewery`): app (HB_IMAGE, HB_CONNECTION_STRING required, HB_MIGRATE_ON_STARTUP false, HB_FORWARDED_HEADERS, HB_KNOWN_NETWORKS/PROXIES, HB_ADMIN_EMAILS, HB_LOG_LEVEL, published ${HB_BIND:-127.0.0.1}:${HB_HTTP_PORT:-8080}) + backup (HB_PGHOST/PORT/DATABASE/USER/PASSWORD/SSLMODE (verify-full)/SSLROOTCERT (/etc/homebrewery/db-certs/root.crt)); both mount ${HB_DB_CERTS_DIR:-./db-certs} at /etc/homebrewery/db-certs:ro; json-file log rotation 5 × 10 MB. deploy/external-db.env.example documents every variable; deploy/.gitignore ignores external-db.env; deploy/db-certs/.gitignore ignores its contents; deploy/.gitattributes forces LF for *.sh (core.autocrlf=true here would otherwise break the scripts mounted into Linux containers).
- deploy/caddy/Caddyfile: `@api` also matches `/healthz/*`.
- Tests: deploy/scripts/test-restore.sh [--keep] [--no-build] (project hb-ops-restore-test via deploy/test/compose.restore-test.yml: no db port, image HB_TEST_IMAGE=homebrewery:ops-test, Caddy on HB_TEST_PORT=5478) and deploy/scripts/test-external-db.sh [--keep] [--no-build] (project hb-ops-extdb-test via deploy/test/compose.external-db-test.yml; external server container hb-ops-extdb on network hb-ops-extdb-net, alias pg.external.test:6543, TLS only, role without CREATEDB). Helpers in deploy/test/lib.sh (bash + curl + perl JSON::PP; `http` sets HTTP_STATUS/HTTP_BODY; call it directly, not in `$(…)`).
- xUnit: tests/Homebrewery.Api.Tests/Operations/ — LogCapture (ILoggerProvider + ISupportExternalScope), RequestLoggingTests (+ CapturedLogHost), AppLoggingTests, ApiHostLoggingTests, HealthProbeTests, MigrateCommandTests (runs the built Homebrewery.Api.dll from the test output as a Production process: migrate on a ScratchDatabase twice, JSON stdout lines, unreachable database exits 1, no connection string exits 1, failed server start exits 1 without "Unhandled exception").

Results (this lane, 2026-09-26, final code): Operations tests 42/42; full backend suite 1014/1014 (an earlier full run showed 17 "...stops the host" regressions from a first RunOrExit that swallowed the exception, fixed as described above, plus one RawHtmlSanitizer time-limit failure under heavy machine load that passed on the rerun); deploy/scripts/test-restore.sh 30 passed, 0 failed; deploy/scripts/test-external-db.sh 30 passed, 0 failed; backup-now.ps1 and restore.ps1 (-Yes -NoSafetyBackup) and restore.sh with a dump file from the host were also run against the kept restore-test stack.

### Notes for later phases
- A new health check that should gate traffic must be registered with tags [HealthEndpoints.ReadyTag]; untagged checks count for /healthz only.
- New endpoints are logged by their route template automatically. Do not log raw paths, query strings, handles, emails or ids at Information; log ids at Debug if needed. Keep `Microsoft.AspNetCore.Hosting.Diagnostics` at None in appsettings.json (the RequestPath scope) and set levels under Logging:LogLevel, not Logging:Console:LogLevel.
- WebApplicationFactory runs the whole entry point (with no arguments, so the `migrate` branch is skipped) and observes start failures through the exception that RunOrExit rethrows. Never swallow exceptions from `app.Run()` in Program.cs. The real exit codes are covered by the process tests in MigrateCommandTests and by test-external-db.sh.
- A new migration that needs a PostgreSQL extension would need superuser or a trusted extension on managed servers; test-external-db.sh runs migrations as a plain owner role and would catch it.
- Dockerfile: unchanged. compose.prod.yml's app has no log rotation (local mode); deploy/compose.external-db.yml has it.
- The first scheduled dump in compose.prod.yml can run before the app has migrated a fresh database (it is then nearly empty). Harmless; the next one is complete.
- The images `homebrewery:ops-test` (built by the test scripts) can be removed with `docker image rm homebrewery:ops-test`.
- Data Protection keys still live in a volume; Microsoft.AspNetCore.DataProtection.EntityFrameworkCore would put them in the database (and in the dumps). A lead decision, not added.
- Other lanes' files touched: deploy/caddy/Caddyfile (`/healthz/*` added to the @api matcher, one line + comment); src/Homebrewery.Api/Program.cs (`app.Run()` → `app.RunOrExit()`, the other three lines above were already this lane's).


## Brew snippets editor (plan §6.3 user snippets; upstream's Snippets tab)

### Interfaces
TEXT FORM AND STORED FORM (web/src/editor/snippets, additive; exported from '@/editor/snippets'):
- snippetText.ts, upstream's "\snippet name" text form (legacy editor.jsx Snippets tab, helpers.js yamlSnippetsToText / brewSnippetsToJSON):
  - `parseSnippetText(text)` → `{ snippets: TextSnippet[] { group, name, gen }, ignored, skipped }`. A header is "\snippet", one or more spaces and a label. The body runs to the next header, without the line break before it. Text before the first header is `ignored`; a header with a blank label is skipped with its body (as upstream). \r\n and \r are read as \n.
  - A label "Group › Name" carries a group (`GROUP_SEPARATOR` ' › ', the Insert menu's path separator). Upstream has no groups: it reads such a line as a snippet named "Group › Name".
  - `snippetsToText(list)` writes each header, its body and a line break. The round trip parse(write(x)) is exact (empty bodies and trailing blank lines included); the only differences from upstream's parser are that a final header without a line break counts and only one final line break is dropped.
  - Also `isSnippetHeader(line)`, `hasSnippetHeaderLine(gen)`, `splitGroupAndName(label)`, `snippetLabel(group, name)`.
- storedSnippets.ts, what the editor stores in brews.snippets:
  - `storedSnippets(list)` → `[{ group?, name, gen }]` in list order, or null when there are none. Names and groups are trimmed; `group` is left out when empty (the Insert menu then lists the snippet under the brew title). parseUserSnippets reads this form like every older one.
  - `editableUserSnippets(value)` → `UserSnippetFields[] { group, name, gen }` from any stored shape (flat, upstream's `[{ name, subsnippets }]`, text). Unlike parseUserSnippets it keeps flat entries without a name or body, so a snippet saved mid-edit comes back as it was.
  - The server's size rule: `MAX_SNIPPETS_JSON` (2 MB = BrewRules.MaxSnippets), `serverJsonLength(value)` (the length of JsonNode.ToJsonString() after StoredText.ToNode: System.Text.Json's default escaping, i.e. " < > & ' + ` and every non-ASCII UTF-16 unit as \uXXXX, U+0000 removed), `jsonStringLength`, `snippetsFit(value, max?)`. The unit test's expected lengths (134, 45, 49) were checked against the real StoredText.ToNode + ToJsonString with a .NET 10 file-based program.

SNIPPETS EDITOR (web/src/editor/ui/snippetsEditor; import from '@/editor/ui/snippetsEditor'):
- `useSnippetsEditor(value, onChange, reportMs = SNIPPETS_REPORT_MS)` → `SnippetsEditorStore`. The page keeps it for its lifetime (closing the panel keeps the list and its undo history). `value` is the page's snippets state. Changes come back through `onChange` in the stored form, at most every SNIPPETS_REPORT_MS (120 ms, the latest value; 0 = every change). A pending report is sent when the page unmounts. Each report re-renders the whole EditorApp, which is why typing is not reported per keystroke. Measured in Chromium on the loaded machine (Playwright typing, per keystroke): the Name field went from 245 to 100 ms, the Body from 161 to 83 ms, against 140–170 ms for the Style drawer in the same runs. Read `store.value()` where the very latest value matters: EditorApp's autosave `getSnippets` does.
- `SnippetsEditorStore(value, { onChange?, maxSize?, mergeMs?, maxSteps?, now? })` (useSyncExternalStore: `subscribe`, `getSnapshot` → `{ snippets: EditableSnippet[] (key, group, name, gen), selected, canUndo, canRedo, size, maxSize, notice }`):
  - Edits, each one undo step: `add(fields)` (after the selected snippet, selected), `duplicate(key, name)`, `remove(key, selectNext)`, `update(key, 'name'|'group'|'gen', value, { merge? })`, `swap(a, b)`, `importSnippets(list, 'append'|'replace')`, plus `select(key)`, `undo()`, `redo()`, `breakMerge()`, `announce(message, tone?)`, `fits(key, patch)`, `refuseSize()`, `value()`. `value()` returns one object per list state, the same object onChange got, so `sync` recognises it.
  - Typing merges into one step while it continues: same field of the same snippet, less than MERGE_MS (1 s) apart, no blur in between. MAX_STEPS 200. Undo and redo select the snippet they changed.
  - Until the first edit, and after undoing back to the start, it reports the value it was given unchanged (an untouched brew never looks edited, whatever shape it was stored in).
  - `sync(value)`: a value from outside (the saved version loaded again after a 409, a restored draft or snapshot) replaces the list and clears the history. Objects the store reported itself are recognised by identity, so a render that lags behind typing changes nothing. null or a string is compared with the current value (the saved version's null clears a list the author added to).
  - Size: an edit that would take the stored JSON over MAX_SNIPPETS_JSON (as the server measures it) is refused with the notice SIZE_REFUSED; an edit that makes it smaller is always allowed. The body editor's transaction filter refuses such typing or pasting before it reaches the text.
- `<SnippetsEditor store brewTitle themeSnippets? readOnly? />` (test id snippets-editor). Content only:
  - A "Snippet tools" toolbar: New snippet, Undo / Redo snippet edit, Import…, Export….
  - A listbox "Brew snippets" grouped like the Insert menu's "Brew Snippets" submenus (role group per submenu; snippets without a group and those whose group is the brew title share the title's). Options carry data-key and test id snippet-option. Keys: arrows, Home/End (select), Enter (to the Name field), Delete (undoable). One tab stop (the selected option).
  - The selected snippet's fields: Name (required), Group (a text field with a datalist of the existing groups), Body (CodeMirror, `SnippetBodyEditor`), then Duplicate, Move up / Move down (within its submenu) and Delete.
  - Validation (`snippetIssues(list, brewTitle)` in snippetsModel.ts). Errors: a name is required; the name must be unique within its Insert-menu submenu (case- and NFKC-insensitive); "›" is refused in names and groups. Warnings: an empty body ("isn't listed in the Insert menu", as upstream); a body line starting with "\snippet " (it would split the snippet in exported text). Errors show on the field (aria-invalid, the TextField error) and as a "(needs attention)" mark in the list; the footer counts them.
  - Footer: "n snippets · size of 2.0 MB · n need attention", and a role=status notice (added, deleted "… Ctrl+Z undoes it", imported, refused).
  - "From your themes": the snippets of the user themes in the theme chain (`userThemeSnippets(chain.snippets)`), read-only (details/summary with the markdown), each with "Copy to brew snippets".
  - Mod-Z / Mod-Shift-Z / Mod-Y anywhere in the editor (list, fields, body) run the store's undo/redo, not the inputs' own history. Portaled dialogs are excluded. When an edit removes the focused element (an undo of an add, a delete), focus goes to the selected option (else New snippet).
- `<SnippetBodyEditor store snippetKey value label describedBy? readOnly? />`: CodeMirror 6 with no history of its own (Mod-Z etc. go to the store), `hbfmLanguage` highlighting (headings, {{ }}, \page/\column/\snippet lines, ::: spacers, HTML tags and comments, links, bold and italics; hbfmLanguage.ts, colours from the Style drawer's --hb-css-* palette), line wrapping and search. It reuses the Style drawer's `styleEditorTheme`, `useResolvedScheme` and `minimalChange` (store changes are applied as a minimal change outside the report path).
- `<SnippetTextDialog mode='import'|'export'|null …/>`: Import has a "Snippet text" field (paste) or a text file (at most MAX_IMPORT_FILE_BYTES 8 MB), a live summary ("Found 2 snippets: …", ignored text, unnamed headers), then "Add n snippets" (after the others) or "Replace all"; both are one undo step. Export shows the text form (unnamed snippets left out, with a note), Copy (the clipboard, else the text is selected) and Download (`exportFileName(title)` → "<slug>-snippets.txt").
- Panel: `<SnippetsPanel store brewTitle themeSnippets? readOnly? side?='left' returnFocusRef? />` is a left Drawer titled "Snippets" (id SNIPPETS_PANEL_ID 'hb-snippets-panel', test id snippets-panel, "Close snippets panel", "Resize snippets panel"). `<SnippetsToggle ref? />` is its app-bar button (test id toggle-snippets, label "Snippets", icon code, aria-pressed and aria-expanded, aria-controls while open).
- Panel state (snippetsPanelState.ts): `snippetsPanelStore` / `createSnippetsPanelStore({ storage?, compactMedia?, ui? })` / `useSnippetsPanel()`. It is kept beside the UI store rather than in it, so uiStore.ts (another lane's file) is unchanged. It stores `{ open, size }` in localStorage 'hb-snippets-panel' (per viewer; failures ignored; size clamped to 260–900). On compact screens it follows the UI store's rules: it starts closed, opening it closes the store's panels, opening one of those closes it, and nothing is stored.
- Helpers: helpers.ts (`formatSize`, `exportFileName`, `userThemeSnippets`, `plural`), snippetsModel.ts (`groupSnippets`, `displayOrder`, `groupLabel`, `groupNames`, `uniqueName`, `countErrors`, NEW_SNIPPET_NAME, MAX_SNIPPET_LABEL_LENGTH 200). The CSS is SnippetsEditor.module.css (UI kit tokens only).

EDITORAPP WIRING (small, additive):
- EditorApp.tsx: `const snippetsEditor = useSnippetsEditor(snippets, setSnippets)` next to the existing snippets state (before useAutosave, so its sync effect runs before autosave's watch effect). Autosave's `getSnippets` is now `() => snippetsEditor.value()`, so a save or draft right after typing has the last keystroke. Autosave's `watch` and `useSnippetGroups(chain, snippets, title)` are unchanged, so every edit marks the brew dirty and reaches the Insert menu's "Brew Snippets" within one report window. onServerBrew/onRestore already set `snippets`; the store follows through `sync`.
- Edit mode only: `<SnippetsPanel store brewTitle={title} themeSnippets={chainSnippets} returnFocusRef />` right after the StylePanel, and `panelToggles={<SnippetsToggle ref />}` on EditorAppBar.
- EditorAppBar.tsx: a new optional prop `panelToggles?: ReactNode`, rendered at the end of the "Panels" toolbar group.

TESTS:
- Vitest (web project): snippets/snippetText.test.ts, snippets/storedSnippets.test.ts; snippetsEditor/snippetsModel.test.ts, snippetsEditorStore.test.ts, snippetsPanelState.test.ts, hbfmLanguage.test.ts, SnippetsEditor.test.tsx (the list, fields and errors, CodeMirror edits with Mod-Z/Mod-Y through the store, the size filter, add/duplicate/move/delete undo, keyboard, read-only, user themes, import, file import, export and copy, the panel with useSnippetsEditor, sync, the throttled reports and the unmount flush); snippetsEditorRoute.test.tsx (the real /edit route over routeTesting's fake API: the toggle in the Panels group, Insert menu paths following each edit, dirty, the PUT's `snippets`).
- E2E, web/e2e/snippets-editor/snippetsEditor.spec.ts (real API; skipped without a private HB_API_URL). Run it with `FLOWS_API_PORT=5480 E2E_PORT=5380 FLOWS_API_DB=hb_e2e_snippets node e2e/flows/run-flows.mjs e2e/snippets-editor` (from web/). Six tests pass in Chromium and Firefox:
  - create → Insert menu at once → insert (a note block, one undo step in the canvas) → Mod-S → the stored `snippets` → reload → still there and not dirty;
  - keyboard-only rename, duplicate-name error, Ctrl+Z in the name field, Delete from the list and its undo/redo, a body edit undone and redone with the body editor's Ctrl+Z / Ctrl+Y, save and reload;
  - import and export of the text form (summary, download file name, copy, focus return) and the size readout;
  - 390 px: starts closed even when stored open, one side panel at a time, inside the screen;
  - axe on the panel and the app bar (list and fields, errors and warnings) and on both dialogs, in light and dark.
  - Final run on the final code: Chromium 6 of 6 (2.3 min, 3 workers), then Firefox 6 of 6 (5.2 min, 2 workers). Also run: e2e/shell/narrow.spec.ts and e2e/flows/home.spec.ts in Chromium (6 of 6; the extra app-bar toggle breaks neither).

### Notes for later phases
- Changes outside web/src/editor/ui/snippetsEditor: web/src/editor/EditorApp/EditorApp.tsx (the import, 3 lines of hook and ref, autosave's getSnippets reading the store, the panel and the toggle prop), web/src/editor/EditorApp/EditorAppBar.tsx (the `panelToggles` prop), and web/src/editor/snippets/index.ts (exports of snippetText.ts and storedSnippets.ts, both new). No other lane's file was changed, no package was added, no git command was run.
- The Insert menu doesn't list an empty snippet (compileSnippets drops entries without a body, as upstream). The editor warns about it on the body field.
- User themes' snippets are read-only in the panel; they are changed in the theme brew's own Snippets panel. A brew whose group equals a user theme's name gets a second submenu with the same label under Brew Snippets (the Insert menu's grouping; not merged).
- The stored form is always the flat `[{ group?, name, gen }]` once edited. A brew still holding upstream's `[{ name, subsnippets }]` or the text form keeps it until its snippets are edited; after an edit, upstream's group names (the old brew title) become groups.
- Export (P6.4) can reuse `snippetsToText(editableUserSnippets(brew.snippets))` for a metadata `snippets:` block or a Snippets tab.
- If the UI store ever gains a 'snippets' panel id, snippetsPanelState.ts can go: its behaviour matches the store's panels (storage key 'hb-snippets-panel').
- E2E environment: the spec uses the flows runner with its own ports and database (hb_e2e_snippets on the compose Postgres; drop it whenever you like). The machine was very loaded (about 40 Firefox processes of other lanes, CPU above 80 %). Firefox took up to 2.8 min per test, so the spec's timeout is 420 s.
  - One run of both browsers at once (4 workers), right after a fresh start of the isolated Vite, had 4 Firefox timeouts: the editor chunk still showed "Loading the editor…" after 90 s, and browser-context teardown took over 240 s. None was an assertion.
  - A real test bug also showed up. Whether typed keystrokes merge into one undo step depends on their timing (MERGE_MS, 1 s): Firefox under load typed "\nInn" more than 1 s apart, so Ctrl+Z undid only part of it. The e2e now inserts the text as one input, and the component tests use a store clock that stands still. The unit tests with a fake clock cover merging.
- Keystroke cost: each change the page receives re-renders the whole EditorApp. The Style drawer (setStyle on every keystroke) pays this in full; see the measurements above. Throttling its onChange the same way, or memoizing EditorApp's heavy children, would help it too.
- Package: hbfmLanguage.ts imports `@lezer/highlight` (tags) directly, like the Style drawer. It resolves through @codemirror/language's dependency; add it to web/package.json explicitly (no package was installed).

## Save path: idempotent create, the 'new' draft's owner, the /new race (SAVE-8, SAVE-12, phase-3 review carry-overs)

### Interfaces
BACKEND (the only migration of this phase):
- POST /api/brews (CreateBrew) takes an optional `Idempotency-Key` header: 1-128 visible ASCII characters (a UUID; surrounding double quotes are stripped). Keys are per user. The first request that commits stores (user, key, request fingerprint, brew) in `brew_create_keys` in the same transaction as the brew. Within 24 hours the same user sending the same key again gets:
  - the same request (equal fingerprint): 201 with the brew the first request created, as it is now (same Location). Nothing new is stored. Two concurrent requests with one key create one brew: the second insert waits on the key's primary key, fails, and replays.
  - a different request: 422 problem+json, title 'Idempotency-Key reused'. 422, not 409: in this API a 409 is a version conflict (SaveConflict), and the IETF idempotency-key draft uses 422 for a key reused with another payload.
  - a malformed key (empty, over 128 characters, not visible ASCII, the header sent twice): 400 ValidationProblem with errors['Idempotency-Key'].
  - a replay whose brew was deleted meanwhile: a new brew (the key row cascades with its brew, and with its user). A replay of a brew the caller can no longer edit: 403 (GetForEdit's answer).
- Expiry: cleanup on write. Every keyed create first runs `DELETE FROM brew_create_keys WHERE created_at <= now - 24 h` (index ix_brew_create_keys_created_at), and lookups ignore expired rows. There is no hosted service; creates without a key never touch the table.
- Fingerprint (CreateIdempotency.Fingerprint): SHA-256 of the bound CreateBrewRequest as canonical JSON (members sorted, numbers as doubles, no whitespace). Key order, whitespace, escapes, number spelling (2.0 or 2), a missing versus a null field and gzip make no difference; any changed value does.
- Core: `BrewCreateKey { UserId, Key, BrewId, RequestHash, CreatedAt }`, MaxKeyLength 128, Lifetime 24 h. Data: `AppDbContext.BrewCreateKeys`; BrewCreateKeyConfiguration (PK pk_brew_create_keys (user_id, key); FKs to brews and asp_net_users ON DELETE CASCADE; ix_brew_create_keys_brew_id; ix_brew_create_keys_created_at). Migration 20260925043420_AddBrewCreateKeys (table brew_create_keys).
- Api: `CreateIdempotency` (HeaderName, ErrorKey, HeaderValue(IHeaderDictionary): the raw value, several values joined with ", ", null when absent; Parse; Fingerprint). `BrewService.CreateAsync(request, userId, idempotencyKey, ct)` (the 3-argument overload still exists, without a key). `BrewOutcome<T>.KeyReused` → 422.
- Endpoints/BrewEndpoints.cs (shared file, small change): CreateAsync reads the header from HttpRequest (the [FromHeader] parameter stays so that OpenAPI documents it; binding alone treats an empty value as absent), maps KeyReused to 422, and the operation's description explains the header. shared/openapi.json and web/src/api/schema.d.ts are regenerated with the documented flow; the diff is additive (the header parameter, the description, the 422 response).

WEB (import from '@/editor/save'):
- `createBrew(body, { idempotencyKey })` (web/src/api/brews.ts, the foundation lane's file, additive) sends the header. `AutosaveApi.createBrew` options gained `idempotencyKey`.
- Autosave's create chain: every POST of one new brew sends the same key (`newCreateKey()`: a UUID, or 32 hex characters where crypto.randomUUID is missing). The POST's body and its rev are the pending create until an answer settles it. A network error, a timeout, 401, 408, 429 or 5xx keeps it: the next attempt (retry timer, online, sign-in, saveNow, unmount) sends that body again, exactly, with the key; the server answers with the brew it made, and what was typed since goes in the PUT that follows (savedRev = the pending create's rev). Any other 4xx means nothing was created: the body is dropped (the next attempt sends the page as it is then); a 422 also starts a new key. Copies ("Save mine as a copy", "Save as a new brew") send no key.
- Draft fields (drafts.ts): `createKey` (the chain's key; the 'new' draft only) and `pending` (the create's body, with pendingVersion null) are written before the POST leaves and kept while its outcome is unknown. `ownerId`: the signed-in user who wrote the draft. `draftOwnedBy(draft, userId)`: true for its owner, or for an anonymous draft (ownerId null or missing). isDraft validates both fields.
- AutosaveOptions: `ownerId` (written into drafts; the last non-null value stays while it is null, so an expired session keeps the author) and `createChain` (read once at creation, only for a new brew). useAutosave fills them from `userKey` and from `CreateChainContext`, so EditorApp needs no change.
- createChain.ts: `CreateChain { key, pending, docSchemaVersion }`, `createChainOf(draft)` (null without a key, or for an existing brew), `CreateChainContext` (React context, default null), `newCreateKey()`.
- newBrewCreates.ts, the create signal (module state, per tab): `trackNewBrewCreate(key, startedAt)` → { created(editId), failed() } (autosave calls it for every POST of a new brew; `created` fires after the 'new' draft is deleted, `failed` after the draft that keeps the changes is written); `pendingNewBrewCreates()`; `createdFromDraft(draft)` = a created brew that sent the draft's key or started after the draft was written; `resetNewBrewCreates()` (tests).
- /new (pages/new): NewBrewSession first waits for creates still running in this tab (`waitForRunningCreates`, at most CREATE_WAIT_MS = 65 s; the spinner says "Saving your previous brew…"), then reads the 'new' draft and picks with `chooseNewDraft(draft, { discardedAt, userId })` (pages/new/newDraft.ts) → { draft, withheld, reason: 'none' | 'loaded' | 'discarded' | 'newer' | 'created' | 'otherUser' }. A draft that this tab turned into a brew is not loaded (the toast "Your new brew was saved" from leftSession.ts says where it went). Another user's draft, and a signed-in author's draft for an anonymous visitor, is withheld. If its owner then signs in on the page (the sign-in dialog) and the stored draft is unchanged (nothing was typed here), the editor mounts again with it, saved on their next edit like any earlier draft. An anonymous draft goes to whoever signs in (the existing hand-off). A loaded draft's chain goes to the editor through CreateChainContext.

TESTS:
- Backend: tests/Homebrewery.Api.Tests/Brews/BrewIdempotencyTests.cs (28): a replay (same brew, one row, same Location), a respelled and gzipped replay, 422, per-user keys, no key → two brews, malformed keys (400, also two headers), 128 and 129 characters, a quoted key, a replay returns the brew as it is now, a deleted brew → a new one, 24 h expiry and cleanup, a request racing an uncommitted one with the same key (row lock + pg_stat_activity), 6 concurrent requests → one brew, the table's indexes and cascades; HeaderValue, Parse and Fingerprint units. All 182 Brews tests pass.
- Vitest: editor/save/autosave.test.ts ('idempotent create of a new brew (SAVE-8)', 9 tests, plus the Idempotency-Key header over the real @/api call), newBrewCreates.test.ts, drafts.test.ts (the fields, draftOwnedBy), useAutosave.test.tsx (the context chain, userKey as owner), appRoutes.test.tsx (the real /new over the in-memory API: another user's draft is not offered; an anonymous visitor, then the author signing in; the anonymous hand-off; "New brew" during the unmount create: waits, starts blank, one brew; the same with the answer lost: the fresh page continues the chain, one brew; a reload continuing a stored chain), pages/new/newDraft.test.ts.
- E2E: web/e2e/save/idempotent-create.spec.ts (4 tests, real API only; skipped without a private HB_API_URL). (1) The first POST reaches the API and its answer is dropped (page.route: route.fetch(), then route.abort('failed')); the retry sends the same key and gets the same brew: exactly one brew in the user's list. (2) "New brew" during the unmount create (answers held 3 s): the fresh /new waits, starts blank, one brew holds the text, and the next brew gets a new key. (3) The same with every answer lost until the fresh page is up: it loads the draft, and the edit replays the key: one brew. (4) Alice's leftover draft is not offered to Bob nor to an anonymous visitor, and is offered to Alice again.

### Notes for later phases
- Running the e2e spec needs a private API: start src/Homebrewery.Api on a free port with its own database (as run-with-api.mjs does: ASPNETCORE_ENVIRONMENT=Development, Database__MigrateOnStartup=true, ConnectionStrings__Homebrewery=…Database=<db>…, --artifacts-path <tmp dir>), then `HB_API_URL=http://localhost:<api> E2E_PORT=<port> npx playwright test e2e/save/idempotent-create.spec.ts` from web/. `node e2e/save/run-with-api.mjs` runs it together with the other e2e/save specs. My runs used API :5479 (database hb_e2e_save8 on the compose Postgres; drop it whenever you like) and E2E_PORT 5379.
- E2E results on the loaded machine (11 lanes): Chromium 4/4. Firefox: all 4 passed, but not all in one run. In a 3-worker run with both browsers, the two race tests failed in Firefox before reaching the code under test (the first page.goto('/new') showed "Loading the editor…" for 90 s), and in a 1-worker rerun one showed the app's "Error 500" page (what the dev Vite serves while another lane's module fails to transform). Rerun alone, both passed. Run Firefox with few workers.
- useAutosave.test.tsx now sets testTimeout 30 s: in a parallel run its first test took 6.9 s, and the timed-out test broke every later test in the file (the mass failure the Autosave section mentions).
- Not done: a retried PUT whose first attempt was applied still gets a 409 against its own save (shown as a conflict, never a silent overwrite). Fixing that needs a per-save key (an idempotency key on PUT, or a client save id stored with the version).
- Limits of the create chain: a pending create older than 24 h, or one sent again by a client whose DOC_SCHEMA_VERSION changed in between, is no longer a replay (a new brew, or 422 → a new key and a new brew). Only then is a duplicate possible, and text is never lost. Keys are per user: if another account signs in mid-chain, that account gets its own brew.
- The 'new' draft still has one key per browser: a user who types on /new overwrites another user's withheld leftover draft (it is never shown to them). A leftover draft exists only after a failed create (a deliberate sign-out saves first). Per-owner keys ('new:<userId>') would keep both; the e2e flows helpers read 'new'.
- The "created" rule of the create signal is per tab (module state). Another tab that loaded the same draft sends the same pending body with the same key and gets the same brew from the server.
- Formatting incident (fixed): I once ran `npx prettier --write` without options on the files I touched. The repo has no Prettier config; the code follows `--single-quote --print-width 140`. The run expanded object literals, also in web/src/api/brews.ts. I reverted every formatting-only hunk to the original text (checked token for token) and tidied my own lines; the remaining diff of brews.ts is only the idempotencyKey option.
- Other lanes' files I changed: src/Homebrewery.Api/Endpoints/BrewEndpoints.cs (above) and web/src/api/brews.ts (the option). No packages were added and no git commands were run.

## Admin pages (P7.4, plan §8.3 admin rows, §8.6 locks)

### Interfaces
ROUTES (web/src/pages/admin; the default export `AdminPage` of index.tsx is the shell's lazy `admin/*` route; everything is inside `<RequireAuth role={ADMIN_ROLE}>`, so anonymous visitors get the "Sign in required" page with the form in place and other accounts the 403 "Access denied" page, and neither sends an admin request). Nested routes; build links with `adminPaths` (adminPaths.ts; ids, handles and ?q= are encoded):
- `/admin` OverviewPage: totals tiles (AdminStats: brews, published, accounts, locked, awaiting review; Refresh), links to the locks and the review queue, quick lookups (account → /admin/users?q=, brew → /admin/brews/:id).
- `/admin/users?q=` UsersPage: search form (role=search; empty → field message, nothing sent), results table (handle link, email with Confirmed/Not confirmed, roles, brew count, Identity lockout), "N accounts match", the 50-result cap explained.
- `/admin/users/:handle` UserDetailPage: the account (exact handle from the search; id, email, roles, brews, lockout, link to the public /user page) and EVERY brew of the account in any role (GET /api/admin/users/{handle}/brews: unpublished, locked and invited ones), each linking to the brew lookup and the share page.
- `/admin/brews[/:id]` BrewsPage: lookup by share id, edit id or internal id (the id is in the URL); details (ids, authors with roles → user pages, description, tags, theme, language, pages, views, version and schema, times, thumbnail); a sr-only role=status "Found …" / "No brew has the id …"; then LockPanel.
- LockPanel (LockPanel.tsx): the current lock (code with its upstream name, applied, review request, both messages) with "Dismiss review request" (only when requested) and "Unlock"; the lock form ("Lock this brew" / "Change the lock": code prefilled with upstream's 455 and the default public message "This Brew has been locked.", or the current lock's values; "Suggested codes" = upstream's list 455-466 as toggle buttons; both messages required, at most 1000 characters; client checks first, focus to the first bad field). Every action goes through a confirmation (alertdialog; Cancel focused; Escape cancels). After a lock change, focus goes to the panel's "Lock" heading.
- `/admin/locks` LocksPage: "Review queue" (oldest request first) and "Locked brews" (newest lock first) tables with per-row "Dismiss request for <title>" and "Unlock <title>" (confirmed; afterwards focus goes to the table's heading, since the row may be gone), Refresh (queue, locks and totals). `/admin/locks#review-queue` focuses and scrolls to the queue heading.
- `/admin/notifications` NotificationsPage: every notification with its state (Showing now / Scheduled / Ended, computed once per load), an Edit link and Delete (confirmed). `/admin/notifications/new` and `/admin/notifications/:id` NotificationEditPage: dismiss key, title, message (plain text, line breaks kept), start (datetime-local in the browser's time zone; empty = now) and end; the API's rules are checked first; 409 "Dismiss key taken" and 400 field errors land on the fields; a stored time the admin did not touch is sent unchanged (the field shows minutes only); Delete on the form too. NotificationPreview: a live preview built from the shell's NotificationBanner.module.css classes (so it follows the banner's look), plus "Showing now / Scheduled. Shown from … until …".
- Every page: `AdminSection` = SitePage (width wide, tab title "<Page> - Admin - The Homebrewery") + the "Admin sections" nav (NavLinks Overview, Users, Brews, Locks, Notifications). While reviews are pending, the Locks link shows a badge with the number and has aria-label "Locks, N awaiting review"; the badge itself is aria-hidden.
- Shared parts (adminParts.tsx): `QueryError` (role=alert "Couldn't load <what>" + message + Try again; a 403 says the account lost the Admin role), `Loading`, `Pill` (the text always states the state), `Time` (formatDateTime / formatRelativeTime from web/src/app/relativeTime.ts), `TableRegion` (a focusable, horizontally scrollable role=group named by the table caption; deliberately not a region, see the notes). `useConfirmAction()` → { confirm(request), dialog } and `ConfirmActionDialog`: stays busy while the request runs, then closes either way; focus after a success = `focusAfter()` or the opener; `onError` runs after the dialog has closed and returned focus, so it can move focus to a rejected field; without its own onError, 409 and 400-with-fields are toasted; any failure except a 400 refetches every admin query, because the page may be out of date.
- Pure model (adminModel.ts): DEFAULT_LOCK_CODE 455, MIN/MAX_LOCK_CODE, MAX_LOCK_MESSAGE, DEFAULT_SHARE_MESSAGE, LOCK_CODES, lockCodeText, lockDraftFor, validateLock → { errors, request }; notification limits (100/200/10000), newNotificationDraft (now → +7 days), notificationDraftFor, validateNotification(draft, { now, original }) → { errors, input }, toDateTimeLocal / fromDateTimeLocal (local time; rejects overflow such as Feb 31), notificationStatus (start inclusive, stop exclusive, like /api/notifications/active), apiFieldErrors(error, labels) (the API's "is required" on title → "Title is required."), formatCount, isLockedOut.

API (web/src/api/admin.ts, extended; not in the '@/api' barrel, so import from '@/api/admin'): `fetchAdminUserBrews(handle)` (normalized handle), `adminKeys.{userBrewLists, userBrews(handle)}` (['admin','user-brews',handle], under queryKeys.admin.all so sign-out drops it), `adminQueries.userBrews(handle)`, `useAdminUserBrews(handle?)` (disabled while blank; a 404 'User not found' gets no toast). Changed behaviour: lock mutations also invalidate the admin user-brews lists. Notification mutations refetch the admin notification LIST even when no page shows it (refetchType 'all'), before the mutation resolves, so the form navigates back to a current list; the other admin notification queries only become stale; the site banner's active list is invalidated. There are no optimistic updates: the pages show what the server returned and what was fetched again.

TESTS:
- Vitest: src/pages/admin/adminModel.test.ts (23), src/pages/admin/adminPages.test.tsx (24), src/api/admin.test.tsx (4). The page tests cover: access for anonymous / non-admin / admin (no admin request for the first two), totals and the badge (refetched per page), a failed load + Try again, an unknown page, quick lookups, user search → account → brews, brew lookup by internal id and a miss, lock with the defaults (client checks, suggested code, Cancel sends nothing, the PUT body, focus, refetch), API field errors focusing the field, relock clearing the review, dismiss + unlock (Escape cancels), a 409 from a stale page refetching, the locks page tables and row actions, the queue anchor focus, notifications list / create (preview, client checks, 409 on the key, the list current on return) / edit (untouched times kept) / delete from the list and the form, a missing notification. src/pages/admin/adminTesting.ts is an in-memory /api/admin/* for them (Vitest only): createAdminServer({ me, users, brews, notifications }) with override, log and requestsTo; fixtures adminBrew, adminUser, notification.
- Playwright: web/e2e/admin/admin.spec.ts, 6 tests in Chromium and Firefox, axe with all impacts on every page state (light and dark): anonymous → sign-in page; another account signs in with the form in place → the 403 page (and a 403 from the API) → signs out from the navbar; the admin signs in with the form in place → the page; overview totals and the keyboard to a section; user search by email → account → both brews (published/unpublished) → brew lookup; lock by edit id with the 455 default by keyboard (Enter on the button, Tab to the confirm button in the alertdialog), the share API answers 423 with the code and message, the author's review request shows in the queue and the badge, dismiss (after a Cancel that returns focus) and unlock from the locks page, the share API answers 200 again; relock on the brew page with a suggested code clears the review, unlock there; notifications: create (scheduled for tomorrow, preview, end-before-start refused), a duplicate key refused on the field, edit to start now → the site banner shows it → delete (confirmed) → gone from the list and the banner (the test deletes its notice in `finally` if it fails earlier).
- Run: `node e2e/admin/run-admin.mjs [playwright args]` from web/. It starts the API on :5473 (Development, database hb_e2e_admin migrated on start, Admin__Emails=admin-e2e@e2e.test, Admin__RequireConfirmedEmail=false, --artifacts-path <tmp>/hb-artifacts-admin), registers the admin once, starts Vite on :5373 with e2e/admin/vite.isolated.config.mjs (no HMR/watch, cacheDir node_modules/.vite-isolated-admin), runs Playwright with HB_API_URL, E2E_PORT, E2E_BASE_URL and ADMIN_E2E_EMAIL, then stops what it started. The spec also runs under e2e/flows/run-flows.mjs (it falls back to FLOWS_ADMIN_EMAIL and registers the admin itself); it is skipped without a private HB_API_URL.

### Notes for later phases
- Upstream parity: stats, author lookup, brew lookup, lock / unlock / clear review, the locks table and review queue, notification add / list / delete are ported; editing a notification is new. Not ported (no endpoints; see "Backend follow-ups"): deleting a brew, changing its owner, locking or unlocking an ACCOUNT (the UI shows Identity's lockoutEnd read-only), upstream's cleanup / compress / script-clean tools (DocInspector sanitizes on save). Upstream's lock "overwrite" checkbox is gone: PUT always replaces the lock, and the confirmation says so ("Change the lock?").
- Accessibility finding worth reusing: a focusable scroll wrapper named like its surrounding section trips axe landmark-unique when both are regions. Name the section (the landmark) and make the wrapper role=group.
- The admin nav's stats query uses refetchOnMount 'always' (review requests come from authors, so the badge would otherwise wait up to 30 s of staleness); each admin page open costs one small GET /api/admin/stats.
- Lock changes leave inactive lock lists stale (they refetch when the Locks page opens). I tried refetchType 'all' there too, but web/src/api/hooks.test.tsx (foundation lane) expects the lock PUT to be the last request after mutateAsync, so I kept the default. If that test is relaxed, the Locks page would never briefly show a list from before the change.
- /admin/notifications/:id with a non-GUID id is a 404 from the API's route constraint; the page shows "This notification doesn't exist (any more)" for 404 and 400.
- Barrel: '@/api' does not re-export fetchAdminUserBrews / useAdminUserBrews / adminKeys (index.ts belongs to the foundation lane); its owner may add them.
- Test data: accounts admin-e2e*@e2e.test and their brews live in the private database hb_e2e_admin on the compose Postgres, not in 'homebrewery'. Drop it whenever you like.
- Change in another lane's file (shell lane, minimal): web/src/app/App.test.tsx "lazy-loads the page module" now expects 'Sign in required' for /admin and /admin/locks (its mocked API is signed out; the placeholder showed an h1 "Admin" for every admin path). In the same file, "/new" timed out once in a full-file run on the loaded machine and passed alone (not admin-related).
- Other lanes' specs that open /admin: e2e/security/csp.spec.ts walks /admin, /admin/users, /admin/brews, /admin/brews/<id>, /admin/locks, /admin/notifications, /admin/notifications/new against a real API (h1 visible). e2e/a11y/axe.spec.ts checks /admin as admin and as a non-admin with its fake API, which answers /api/admin/* with 404: the overview then shows its inline "Couldn't load the totals" alert (and no nav badge) instead of the tiles. If that lane wants the real overview under axe, its fake needs GET /api/admin/stats → AdminStats.
- Firefox e2e under load (Playwright 1.63.0, Firefox 155): with other suites running, Firefox tests hung in axe (`page.evaluate` or `browserContext.newPage` until the test timeout, then "Browser.removeBrowserContext … _maybeDontRestoreTabs" on teardown), and sometimes a full page load stalled after the document committed. The first is @axe-core/playwright's default mode, which finishes in a new blank page (the lists lane found the same, see its notes): the spec now runs axe with `setLegacyMode(true)` (no iframes on these pages). Against the second, every test loads the app once and navigates inside it (sign-in and sign-out through the UI, section links, in-app lookups), full loads go in two steps (`open()`: commit, then DOMContentLoaded), the dark-scheme test sets colorScheme with test.use, and each test may take 240 s.
- Process: I edited only web/src/pages/admin/**, web/src/api/admin.ts (plus the new admin.test.tsx beside it), web/e2e/admin/**, the two expectations in web/src/app/App.test.tsx above, and this section. No packages were added; no git commands that change the index or tree were run. For e2e I ran my own API on :5473 (--artifacts-path C:/Users/ranky/AppData/Local/Temp/hb-artifacts-admin, database hb_e2e_admin) and Vite on :5373.


## HTML export and print (P6.4, plan §5 print bullet, §11)

Since issue #2 the HTML file is no longer offered as a download: it is the input of the PDF export (see [PDF export](#pdf-export-downloads-and-exports-are-pdf-issue-2)). `downloadHtml` and `ExportHtmlButton` below were replaced by `downloadFile` and `DownloadPdfButton`.

### Interfaces
EXPORT (web/src/editor/export; `import … from '@/editor/export'` where an export runs; the app bar's button loads it on first click)
- `exportBrewHtml(source, options) → Promise<ExportResult>`. `source`: an Editor (its document after `settleNow`, as printing does), a ProseMirror node, or doc JSON. `options`: `chain` (ThemeChain or `{ styles }`: EditorCanvas's `status.chain`, or loadThemeChain), `userCss?` (brew style), `lang?` ('en'), `title?`, `baseUrl?` (default document.baseURI; its origin is "this site"), `fetch?`, `probe?` (default `createIframeProbe()`; `null` = no layout: every url() written in, no TOC exclusions, no page size), `separators?` (default true), `signal?`.
  - `ExportResult { html, filename, report }`; `ExportReport { pages, bytes (UTF-8), inlined, inlinedBytes, external: string[] (other sites' images and fonts the page uses, left as links), failed: string[] (same-origin files or stylesheets that could not be fetched, left as absolute links), removed (active content stripped), pageSize ('816px 1056px' or null), fontsSettled }`.
  - Pipeline: collectExportCss → serializeBrew (+ stripActiveContent, relative URLs made absolute, TOCs filled) → the probe lays the file out once → TOCs filled again with the theme's --TOC exclusions → same-origin files the page uses fetched and written in as data: URIs (CSS url()s the probe saw used, img src, svg image href, video poster, inline-style url()s including --HB_src) → exportDocumentHtml.
  - `exportDocument(source)`, `exportFileName(title)` ('<title>.html'; characters that file systems reject are replaced; at most 100 characters; 'brew.html' when blank), `pageRule(sizes)`.
- File format: `<!DOCTYPE html><html lang>` › head: `<meta charset>`, `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">` (EXPORT_CSP), `<meta name="generator" content="The Homebrewery (HTML export)">` (EXPORT_GENERATOR), `<title>`, `<style data-hb-export="page|theme|editor|theme-css|brew">` in that cascade order › `<body class="hb-canvas" lang>` › `div.pages.ProseMirror[contenteditable=false]` › `div.page#p{n}` (the editor's CSS contract). No <script>, no comments; `<` never appears literally in text, attributes or CSS (html.ts `serializeHtml`, cssText.ts `cssForStyleElement`).
- Theme CSS: the chain's scoped stylesheets (style.scoped.css, the files the editor links), with <body> playing .hb-canvas; not the unscoped style.css. Every selector keeps the specificity it has in the editor (the header-row rewrites too, which still match the real <thead>). The `editor` group is Open Sans @font-face, `CANVAS_PRESENTATION_CSS` (EditorCanvas.module.css's inherited-property reset for the canvas, single-spread spacing, shadows, print), canvas.css as it is (page flex structure, upstream base, dl, image, float, empty-cell and continued-list rules) and `PROSEMIRROR_CSS` (TipTap's injected rules that reach read-only pages). User themes' CSS and the brew's CSS are scoped with scopeCssText. Identical @font-face blocks repeated across the chain are written once (`dedupeFontFaces(css, seen)`).
- `page` group: `@page { size: <measured page size in px, unrounded>; margin: 0 }` when every page has the same size (else only the margin). It comes first, so theme and brew @page rules win. Unrounded px matters: layout sizes are exact binary fractions (Chromium 1/64 px, Firefox 1/60 px), so the sheet is exactly as tall as a page. A sheet rounded a hair shorter pushes a sliver of every page onto the next sheet. Printing the file gives one brew page per sheet whatever paper the print dialog starts with (A5 brews print on A5 sheets).
- `serializeBrew(doc, { separators?, document? }) → { pages, headings, tocs }`: DOMSerializer with PageView (chrome, contenteditable=false), ImageView (data-hb-natural, --hb-natural-width) and TocView's element. Leaf nodes get contenteditable=false and textblocks ProseMirror's trailing <br class="ProseMirror-trailingBreak">, as ProseMirror adds them. Chromium's <img class="ProseMirror-separator" alt=""> follows a trailing uneditable inline node (inside its mark wrappers); `separators: false` gives Firefox's DOM. Page ids p1…pN. The leading header rows of top-level tables (headerRowCount) move into a real <thead> (they stay in <tbody> when a header cell's rowspan reaches the body). Left out: data-hb-chrome, data-object-id, draggable, the oversized badge and class, data-objects (the page objects' JSON copy, which can hold data: URIs), loading=lazy (printing the file must not wait for scrolling), img srcset (it would point back at the site). `fillTocs(serialized, doc, isExcluded?)` writes TocView's markup (tocInnerHtml, data-toc-entries). `stripActiveContent(root)` removes script, base, meta, link, iframe[srcdoc], noscript, template and portal elements, on* attributes, srcdoc, and script or non-image data: URLs (a second line behind the schema's raw-HTML sanitizer).
- Probe (probe.ts): `createIframeProbe({ document?, fontsTimeoutMs = 10 s, width = 1100 })` → `ExportProbe(html) → { excludedHeadings (HEADING_INDEX_ATTR indexes), cssUrls (absolute url()s the page uses), fontsSettled, pageSizes }`. It uses a hidden, sandboxed (allow-same-origin, no scripts), aria-hidden iframe and removes it afterwards. It first asks the FontFaceSet for the faces of every piece of text (`textFonts(doc)`, `loadTextFonts(doc)`: elements' own text, ::before and ::after (`contentText`: strings, counters as digits, quotes), ::first-letter and ::marker). Reason: Firefox can start a font load a tick after the layout flush, so reading the face status alone missed a face (the offline file then requested Overpass Medium). `usedCssUrls(doc)`: a style rule's url()s count when its selector (pseudo-elements and hover/focus states removed, `elementSelector`) matches an element, in any @media; @font-face files count when the face was loaded or tried; rules it can't judge count. Also `excludedHeadings(doc)`, `pageSizes(doc)`.
- Resources (resources.ts): `classifyUrl(url, base, origin)` ('data' | 'same-origin' | 'external' | 'other'), `absoluteUrl`, `mediaType(url, contentType)` (text/plain and octet-stream count as unknown: the extension decides), `bytesToBase64`, `fetchDataUri` / `fetchDataUris` (credentials same-origin, 20 s per file, 6 at a time, each URL once; null for failures; AbortError when cancelled).
- Download: `downloadHtml(html, filename)` (a Blob URL and a temporary <a download>, revoked after 60 s), `formatBytes`.
- UI: `ExportHtmlButton({ editor, chain, userCss, lang, title, exportBrew?, download? })`: IconButton 'download', label "Export HTML", data-testid `export-html`. Disabled until the editor and the theme chain are there; `loading` (aria-busy) while it exports; cancelled on unmount. Toast id `EXPORT_TOAST_ID`: success "Exported “<file>”" with "N pages, size. It opens without an internet connection.", or a warning that lists other sites' files and files that couldn't be included; errors "Couldn't export the brew". `exportSummary(result, formatBytes)` is in exportSummary.ts.

WIRING (the one additive change in web/src/editor/EditorApp the task allowed)
- EditorAppBar: new optional prop `exportAction?: ReactNode`, rendered right after the Print button (both modes).
- EditorApp: passes `<ExportHtmlButton editor chain={canvasStatus.state === 'ready' ? canvasStatus.chain : null} userCss={style} lang title />`. So /, /new, /edit/:editId and /share/:shareId all have "Export HTML" next to Print; on the share page it is in the viewing bar.

PRINT FROM THE APP (verified, not changed: the canvas lane's print.ts and EditorCanvas.module.css): Print and Mod-P settle pagination, load lazy images (loadLazyImages: the print waits for a held image response), then call window.print. Under print media no app chrome shows, pages are 816 × 1056 px stacked from the top of sheet 1 with no margins or shadows, and Chromium's PDF has one sheet per page. A brew's own `@page { size: A5 }` (in its adopted sheet) is honoured (the PDF sheets are A5).

DEV PAGE /dev/export[?doc=inn|external|a5|s1|chrome][&fixture=<S3 fixture>][&theme=][&css=][&editable=1] (web/src/dev/export): a read-only EditorCanvas with viewingExtensions (editable=1: editingExtensions), a Print button and the real ExportHtmlButton. `window.__hbExport = { editor, handle, settled(), exportHtml({ separators? }), print() }`; data-theme-status on the frame. devDocs.ts: `exportDevDocs` (inn: 3 pages with footer, page numbers, an image object and a text object, a TOC (depth 3) whose stat block heading 5ePHB excludes, header rows, a note, same-origin images inline, as an object and in the brew CSS, links to #p1 and #p3; external: the same plus an image of another site; a5: A5 pages from brew CSS, without an @page rule of its own), `EXPORT_ASSETS`, `EXTERNAL_IMAGE`.

TESTS
- Vitest (web/src/editor/export/*.test.ts[x], 9 files, 85 tests): the exported DOM equals a read-only editor's DOM on the S1, chrome, tall, continued, objects-lane and export documents plus an inline/raw document (header rows normalized to <thead>; jsdom doesn't reflect ProseMirror's contentEditable property, so a separate test checks contenteditable=false on leaves); header rows, separators, TOC exclusions, active content; serializeHtml escaping; the document shell; CSS collection (fake fetch) and the canvas reset against EditorCanvas.module.css; probe rules (usedCssUrls, excludedHeadings, contentText, textFonts, the iframe); the whole pipeline with a fake site and probe (used files inlined, unused ones left, external and failed files reported, page rule, file name, cancel); download; the button (disabled, busy, toast, error, cancel on unmount).
- Playwright (web/e2e/export, port 5371, API stubbed with page.route; no API server needed):
  - export.spec.ts: for inn (5ePHB), inn (Blank), s1 and chrome: export, then open the file from a file:// URL in a context with `offline: true` and every http(s) request aborted. It makes no request at all, has no <script>, loads all its images and fonts, and every page's screenshot matches the editor's (pixelmatch, at most 0.5%); measured 0 px on every page in Chromium and Firefox. The file's DOM equals the editor's DOM in the browser (Firefox compared with `separators: false`). Also: TOC, page ids, <thead> and links; other sites' images reported and linked; print media (pages stacked at i × height, no margins, shadows or backdrop; Chromium page.pdf() sheets = brew pages, Letter, and A5 for the a5 document with preferCSSPageSize); the CSP and data: URIs in the text.
  - app.spec.ts: share page (stubbed BrewForShare): Export HTML right after Print downloads "A Shared Brew.html", which opens offline and whose page 1 matches the share page's. Print waits for a lazy image whose response is held (nothing is printed until it is released; then 1 of 1 loaded). Print media hides the navbar, bars and toolbars; pages stacked; Chromium PDF sheets = 3. The brew's `@page { size: A5 }` is honoured (PDF sheets A5). Home page: from Print, ArrowRight reaches Export HTML (roving toolbar) and Enter downloads; the file opens offline with the editor's pages and h1s; axe finds nothing on the app bar.
  - helpers.ts: stubApi, blockOtherSites, openExportDev and settleFonts (visits every page, loads every image, waits for pagination to settle again), exportFromDev, writeExport, openOffline, diffImages, attachImage, pageShot, pdfSheets (MediaBox per page), pageBoxes. Assertions on the file's text are booleans: a failing `toContain` would print megabytes of base64.

### Notes for later phases
- App print (canvas lane, EditorCanvas.module.css / print.ts): the app adds no default @page size, so an A4, A5 or card brew printed from the app overflows Letter sheets unless the user picks the paper (upstream behaves the same). The export's `pageRule(pageSizes)` could be reused at print time (a temporary adopted sheet with the measured size, first in the cascade).
- The home page's welcome brew has an empty title, so its export is "Untitled brew.html" (displayTitle). Give the welcome brew a title if that matters.
- Pasting from an exported file (or a share page) goes through the external-paste path and loses classes (canvas lane note). The file carries `<meta name="generator" content="The Homebrewery (HTML export)">`; a paste marker would need a change in pasteCleanup.ts.
- Fonts or images of other sites (Google Fonts through @import in brew CSS, imgur images) stay links: the file shows them only online, and the toast says so. Same-origin files that fail to fetch are listed in report.failed.
- File size: each font and image the page uses is written in once (the 5ePHB inn document: about 0.9 MB, 14 files). An image in the text is written twice (its src and its --HB_src style, which Blank's wrapLeft/wrapRight shape-outside needs).
- canvas.css is copied into the file as it is. Its editor-only rules stay inert there: `.hb-canvas[data-hb-offscreen='skip'] .page` (perf lane) needs an attribute only EditorCanvas sets, so the file's pages keep `content-visibility: visible`; `.page[data-hb-measuring]` and the oversized/caret rules match nothing. A new canvas.css rule that should not reach exported files must be keyed the same way. The spec's DOM comparison drops the editor's transient data-hb-measuring attribute.
- Vitest turns CSS imports (`?raw` too) into empty strings: exportCss.test.ts mocks '../canvas/canvas.css?raw' with the file's text (read with node:fs; the test file references node types).
- Environment: on this overloaded machine a full Firefox run of e2e/export takes longer than 30 minutes (page loads of /dev/export and /share took up to several minutes, and contexts were slow to close). Every Firefox test passed when run in small groups. The helpers' load timeout is 180 s and each test may take 480 s (a Firefox run of one document took 4.7 min alone). Run the Firefox project with 1–2 workers.
- Process: I edited only web/src/editor/export/**, web/src/dev/export/**, web/e2e/export/**, the one wiring change above in web/src/editor/EditorApp/EditorAppBar.tsx and EditorApp.tsx, and this section. No packages were added; no git commands that change the index or tree were run.

## Import page and import report UI (P6.1, P6.3, plan §7, §9)

### Interfaces
ROUTE /import (web/src/pages/import/index.tsx, default export, lazy-routed; replaces the placeholder). `ImportPage({ convert?, Preview?, prefetch? })` (web/src/pages/import/ImportPage.tsx). The props are for tests; the defaults are the real conversion, LazyImportPreview and prefetchEditor.
1. "1. Choose the brew": Tabs "Where the brew comes from":
   - "Paste text": TextArea "Brew text" + "Preview the import".
   - "Upload a file": file input "Brew file". The preview starts when a file is chosen.
   - "Homebrewery link": TextField "Share link or share id" + "Download and preview" (signed out: "Sign in and download").
2. "2. Check the import" (h2, takes the focus when the visitor started the conversion): the source line (for a link, "open it on the Homebrewery"), then ImportReportView next to the read-only paginated preview (LazyImportPreview) with the brew's theme, CSS and lang. "Start over" clears everything.
3. "3. Create the brew" (a sticky bar): Title, Theme, Pages, Tags, Snippets, then "Create brew" (signed out: "Sign in and create the brew", with a "Create an account" link to /register?returnTo=/import). It sends POST /api/brews with:
   - doc: the preview's paginated JSON once it has settled, else hbfmToDoc's doc;
   - style; snippets; meta (title, description, tags, lang, theme); sourceMarkdown (the text as imported); docSchemaVersion.
   Then it navigates to /edit/:editId.
- A role=status line (import-status) announces "Converting…" and "Converted. <headline>".
- Test ids:
  - Page: import-page, import-source-tabs, import-paste, import-paste-preview, import-paste-error, import-file, import-file-error, import-link, import-link-download, import-link-error, import-link-sign-in-note.
  - Check step: import-status, import-check [data-state converting|done|error], import-start-over, import-source, import-converting, import-convert-error.
  - Create step: import-create, import-meta-{title,theme,pages,tags,snippets}, import-create-error, import-sign-in-note, import-create-button.
  - Report and preview: import-report [data-layout pending|done|unavailable], import-report-<id> [data-count][data-tone], import-report-<id>-count; import-preview [data-canvas-status][data-settled][data-zoom], import-preview-loading.
- Modules (web/src/pages/import):
  - convert.ts (loaded on demand):
    - `convertBrewText(text, deps?) → ImportConversion { result: HbfmImportResult, meta: BrewMetaInput, snippets: StoredSnippet[] | null, theme, themeName, notes }`.
    - `resolveImportTheme(wanted, load?)`; `metadataTags(raw)`; `storedSnippets(\snippet text)`; `ConvertDeps { hbfmToDoc?, loadThemeChain? }`.
  - importBrew.ts: `cleanImportMeta(ImportedMetadata) → { meta, notes }` (BrewRules limits MAX_TITLE 100, MAX_DESCRIPTION 500, MAX_TAGS 50, MAX_TAG 100; lang rule, else 'en'; theme rule, else 5ePHB); `createBrewRequest(imported, doc, source)`; `StoredSnippet { name, gen }`.
  - importErrors.ts: `upstreamErrorProblem(error)` (400/401/404/413/429 with Retry-After/502 ± upstreamStatus/network); `upstreamStatusMessage(status)`; `conversionProblem(error)` (legacy-renderer → "switch the renderer to V3" explanation); `createProblem(error)` (400/422 field errors, 413, 429); `ImportProblem { title, message, retry? }`.
  - importSession.ts: `IMPORT_SESSION_KEY` 'hb-import-session' (sessionStorage), `readImportSession`, `writeImportSession` (falls back to leaving out the loaded text when over quota), `clearImportSession`, `parseImportSession`, `EMPTY_SESSION`, `ImportSession { tab, paste, link, loaded: LoadedSource | null }`, `LoadedSource { kind: paste|file|link, text, label, note? }`.
  - readTextFile.ts: `MAX_IMPORT_BYTES` (2 MB, the proxy's cap), `IMPORT_FILE_EXTENSIONS` (.txt .md .markdown), `IMPORT_FILE_ACCEPT`, `decodeImportBytes`, `readImportFile`, `isImportFileName`, `formatBytes`, `utf8Bytes`, `sizeProblem`.
  - upstreamLink.ts: `parseUpstreamLink(input) → { ok, shareId } | { ok: false, problem: empty|edit-link|legacy-id|google-drive|other-site|not-a-brew-link|invalid, message }`, `UPSTREAM_HOST`, `upstreamShareUrl(shareId)`.
  - prefetchEditor.ts: `prefetchEditor()` loads '@/pages/edit' and the EditorApp chunk once, at idle (requestIdleCallback, timeout 3 s). The page calls it once the preview has settled, so "Create brew" opens the editor without waiting.
- Report UI (web/src/editor/ui/importReport; the index exports everything except the heavy ImportPreview):
  - `ImportReportView({ report, layout: 'pending'|'done'|'unavailable', notes?, headingLevel? = 3, title? = 'Import report', className?, data-testid? })`: a named region holding a `<dl>`, one entry per item: count, one sentence, and a `<details>` with the list.
  - `reportItems(report, { layout, notes? }) → ReportItem { id, label, count | null, summary, tone: neutral|info|warning, details? }`. Always listed (0 when nothing happened; the plan §7 counts): pages, clipped (with "Page n: now N pages" after recordPaginatedPages), variables, raw-html (with samples), comments, unknown-classes (null = not checked), transparent (tags that lost their attributes). Listed only when non-zero: grown (pages that grew without clipping upstream), unresolved, sanitizer, style-tags, lifted, positioned, lost, warnings (the page's notes first, then report.warnings). `reportHeadline(report, notes?)`.
  - `ImportPreview` / `LazyImportPreview({ doc, theme, style, lang, onSettled?, onStatusChange?, label?, className?, data-testid? })`: EditorCanvas, read-only, with viewingExtensions (pagination on) and zoom fitted to the box (`fitZoom(width, pageWidth?)`). Its viewport is a focusable region "Preview of the imported brew". `onSettled({ doc: PMNode, json() })` fires after the canvas is ready and isSettled() has held for 2 frames, and again if a later transaction (images, fonts) moves pages. The page calls `recordPaginatedPages(report, doc)` there.
- Vitest (75 tests in 10 files, project 'web'):
  - ImportPage.test.tsx: the conversion and preview are stubbed and mockApi stands in for the API. It covers the three sources, the report before saving and after the layout, the create body, a newer conversion winning, the legacy error, the proxy errors, the sign-in hand-offs (anonymous, and a 401 resuming), a 400 on create, and the session restore.
  - reportModel.test.ts (with fitZoom), ImportReportView.test.tsx and prefetchEditor.test.ts.
  - The module tests: convert, importBrew, importErrors, importSession, readTextFile, upstreamLink.
- E2E (web/e2e/import-ui):
  - How to run: `node e2e/import-ui/run-import-ui.mjs [playwright args]` from web/. It is a wrapper over e2e/flows/run-flows.mjs: API :5470 with database hb_e2e_import_ui, Vite :5370. The whole-suite runners also work, because create.spec skips without a private API.
  - report.spec.ts (API stubbed): every §7 count before saving, the clipped page's "now N pages", the preview (read-only, theme 5eDMG, variable inlined), the legacy-renderer message, keyboard use, axe.
  - errors.spec.ts (API stubbed; the proxy answered by page.route): 400/404/413/429 (Retry-After)/502 with upstreamStatus 455, 503 and 403, and 502 without it; refusals made before any request (edit link, 7-character id, Google Drive id, other site, non-brew link, junk); bare id and scheme-less link; signed-out download → sign-in dialog; refused files (png, empty, binary, over 2 MB); empty and oversized paste; 390 px width without horizontal overflow; axe.
  - create.spec.ts (real API; upstream stubbed): paste → report → create (meta, style, snippets, sourceMarkdown and pageCount checked in GET /api/brews/edit), a Windows-1252 .txt, a share link, anonymous → sign-in dialog → create resumes, and the text surviving the /login?returnTo=/import round trip.
  - helpers.ts: `reportBrew(paragraphs = 90)` / REPORT_BREW (written for the tests: metadata, css, a variable, a comment, raw HTML, <font>, an unknown class, and a second page that clips; 90 paragraphs grow into 3 pages in 5eDMG, 60 into 2, while 45 still fit on one), stubApi, stubUpstream, upstreamText, upstreamProblem, pasteAndPreview, waitForReport, reportCount, chromeViolations.
  - `settledPageCount(page)`: waits until the report's page count equals the preview's, twice in a row. The preview can settle a second time when late fonts or images move a page, and the report follows it, so a count read right after the first settle can be stale. A Chromium run caught this.
  - Timeouts: 240 s per test, and the paste-create test uses test.slow() in Firefox. On the loaded machine Firefox took 1-4 min per test.

DECISIONS
- Theme: the brew's metadata theme when this site has it. For an unknown theme (an upstream user theme, a typo), the import uses 5ePHB and says so in the report's notes, so the brew is never saved with a theme it can't load. A network failure keeps the theme.
- Tags: read from the ```metadata block. Upstream writes them there, but splitTextStyleAndMetadata doesn't read them back.
- Metadata that breaks the API's rules is cleaned rather than refused, and each change is a note: long title or description shortened (never splitting a surrogate pair), long tags dropped, more than 50 tags cut, a bad lang becomes 'en'.
- Snippets: `\snippet` text becomes the stored flat form [{ name, gen }] (no group, so the Insert menu lists them under the brew title, as upstream does); none → null.
- The created doc is the paginated one when the preview has settled. The brew opens already laid out, and pageCount is right from the first save.
- Sign-in:
  - A signed-out Create or Download asks to sign in (requestSignIn); the action runs by itself once `me` is set.
  - A 401 on the page's own requests (errorPolicy 'manual') sets `me` to null first, as EditorApp does, so that signing in again, even as the same user, resumes the action.
  - The text, the link, the tab and the loaded source are kept in sessionStorage for the tab (writes are debounced 300 ms, flushed on pagehide and unmount), so they survive /login, /register and a reload. A restored source is converted again without moving the focus. After a create the session is cleared.
- Upstream ids:
  - Checked client-side first, with a separate explanation for edit links, 7-9 character legacy ids, and Google Drive ids (1 + 32-43 characters + a 10-12 character id). Legacy ids and Google Drive ids come with the advice to use Source → Download and upload the file instead.
  - 502 with upstreamStatus: 401/403 = private or locked; 5xx = upstream trouble (retry); 400-429 = that HTTP error; any other code = an upstream lock code.
- Files: .txt, .md or .markdown (or a text/plain or text/markdown file without an extension), at most 2 MB. UTF-8 with or without a BOM, and UTF-16 with a BOM; otherwise Windows-1252, with a note to check accented letters. A NUL byte means binary, and the file is refused. The paste limit is also 2 MB, counted in UTF-8 bytes.
- CSS: app chrome only, CSS modules with UI kit tokens. The resumed work fixed token misuse: links and disclosure toggles used --hbui-color-accent-text (white on white; axe color-contrast), and error titles used --hbui-color-danger-text. They are now --hbui-color-accent and --hbui-color-danger.

### Notes for later phases
- Not done (scope):
  - A "variables: keep" choice in the UI (hbfmToDoc supports it; the page always expands).
  - Picking a theme before creating (Properties can change it afterwards).
  - Accepting the lists lane's Download file (format 'homebrewery-brew') for a lossless re-import. That would be a fourth source: skip hbfmToDoc and POST its doc, style, snippets and meta as they are.
- Results (final code, run-import-ui.mjs, single runs): Chromium 15/15 in 58 s (4 workers), Firefox 15/15 in 3.0 min (2 workers).
- Earlier, while 10 lanes ran suites at once, Firefox runs failed on timeouts: page.goto or context teardown past 240 s, and "timeout while setting up page". Vite answered curl in milliseconds at the same time. Each of those tests passed on rerun. All specs use 240 s timeouts, and the dialog wait is 30 s. If Firefox flakes in the integration run, rerun with --workers=2.
- Two test-design lessons from this lane:
  - In Firefox, fill() with a text of several hundred thousand characters takes minutes. errors.spec sets the oversized paste with the native value setter plus an input event.
  - Read a page count only after the layout has settled twice (see settledPageCount).
- Test data: accounts import-*@e2e.test and their brews are in the private database hb_e2e_import_ui on the compose Postgres. Drop it whenever you like.
- Process:
  - The shared scratchpad is shared by every lane of this session. The perf lane's `scratchpad/restart-vite.sh` replaced mine under the same name, so one call restarted the perf lane's Vite on :5375 (with its own config) instead of mine. Their runs in flight may have seen it drop once. I now keep my files in scratchpad/import-ui/.
  - I stopped only processes on my ports (:5370, :5470) and my own vitest run.
  - I edited only my paths. The API ran with --artifacts-path C:/Users/ranky/AppData/Local/Temp/hb-artifacts-import-ui. No packages were added and no git commands were run.

## Accessibility audit and fixes (P8.2, plan §11)

### Interfaces
EDITOR DESCRIPTION (web/src/editor/EditorApp):
- `EDITOR_KEYBOARD_HINT` (editorAppExtensions.ts): how to reach the chrome from the text (Alt+F10 → editing toolbar, Escape back; Shift+Alt+F10 → the theme block's controls; in lists Tab indents and in tables it moves between cells; elsewhere Shift+Tab → toolbars, Tab → panels). This is also the advisory WCAG 2.1.2 asks for where Tab stays in the text.
- `EditorAccessibility` has a new option `describedBy: string | null` (aria-describedby on the ProseMirror root). An editable root also gets `aria-multiline="true"`. `editingExtensions(gate, label?, describedBy?)` gained the third parameter; `viewingExtensions` is unchanged (read-only: no hint).
- EditorApp, edit mode: the canvas scroll container gets tabindex=-1 (Firefox made it an unnamed Tab stop between the toolbars and the text; the caret scrolls the pages). View mode keeps the focusable "Pages" region.
- EditorApp (edit mode) renders the hint as a VisuallyHidden span (`data-testid="editor-keyboard-hint"`, id from useId) and passes its id. Tests: editorAppExtensions.test.ts, EditorApp.test.tsx (accessible description; none in view mode).

CSS (all additive, CSS modules):
- Reduced motion: theme.module.css sets `--hbui-duration: 0ms` under `prefers-reduced-motion: reduce` (every UI kit transition uses the token); the navbar's literal 120 ms transitions (item colours, chevron turn) are off too. Spinners and the route-loading bar keep moving (they show progress; the Spinner already slows down).
- Forced colours (Windows contrast themes drop box-shadow, so box-shadow focus rings vanished, and Button's always-on `outline: 2px solid transparent` became a black ring on every button, so the focused one didn't stand out): under `forced-colors: active` Button, Field `.control` and Tabs `.tab` draw no outline unless focused, and every box-shadow-only `:focus-visible` ring in my paths also draws `outline: 2px solid Highlight`: Button, Field control, Tabs (tab, panel), Toaster viewport, SignInPrompt link, SitePage heading, Inspector (crumb, chip remove, class combobox, objects list), PageNav input, navbar panel links and text links, home "Create your own", auth/account/error page links.
- ResizeHandle (SplitPanel.module.css): the keyboard-focus strip is 4 px (the hover line stays 2 px).
- Save status (web/src/editor/save/save.module.css, save lane's file, one appended rule): the error tone used `--hbui-color-danger-text` (the text colour ON a danger fill: white in the light scheme) as a plain text colour: "Couldn't save"/"Conflict" had no contrast on the toolbar (axe color-contrast, serious, in both schemes). It now uses `--hbui-color-danger`.

E2E (web/e2e/a11y, port 5376; no API server: fakeApi.ts answers /api/* per page):
- axe.spec.ts: WCAG 2.1 A/AA (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`), light and dark, both browsers. Serious/critical fail (expect.soft, so one run lists every state); moderate/minor go to the test's `a11y-minor` annotations. The brew's own pages (`.hb-canvas .ProseMirror > .page`) are excluded. Idle pages are scanned whole; a menu/dialog/panel state scans only what changed (the portal root `[data-hb-portal-root]`, the panel, the toolbar), which keeps Firefox's scans short. States: idle editor; block type, classes, zoom, spread, Blocks and table menus; column width dialog; Insert menu (results and none); icon picker (searched); link dialog (with a refused address); class picker with suggestions; theme block controls; ':' icon suggestions; outline; style drawer (with CSS completion and the snippet dialog); inspector Element tab (suggestions, a refused class) and Page tab; an object selected (frame, object toolbar, inspector fields) and edited in place; Properties (theme list, tag suggestions, field errors), the delete confirmation, Local history; every navbar panel (Share, New, Recent, Help, Account); a toast; layout warnings and their popover; save status unsaved / failed / conflict and the conflict dialog; the lock banner and a locked brew's Properties; the unsaved-changes offer (a draft left by a closed tab); the share page (Clone, zoom menu, outline); the sign-in dialog (empty and with errors); 390 px with the outline and inspector sheets; 320 px home and account panel. Routes (one test each): home (with a site notice), /new, /share (signed out, own brew, someone else's), 423 and 404 share pages, /login, /register, /account (signed out and in), /edit signed out (sign-in form) and 404, unknown route, and the other lanes' /user (own and other), /vault, /import, /admin (403 and admin).
- keyboard.spec.ts (keyboard only; page.evaluate reads state, stubs window.print, or puts a throwaway element at the top of the page to start a Tab walk there):
  - The walkthrough: / → skip link → navbar New → New brew → type a heading and text → Ctrl+S (POST, URL becomes /edit/:id, same editor, focus kept) → select a word, Ctrl+B, Alt+F10 → Italic → Escape (selection kept) → Insert menu search "note" → Enter (theme block, focus back in the text) → Shift+Tab to the brew toolbar → Inspector → Element tab → Add class "wide" → Page tab → Columns 1 → Blocks menu → Add text object → type → Enter → arrows move it → Escape → Properties (opens on Title) → title → Escape (focus back on Properties) → Ctrl+S (saved, title stored) → Ctrl+P and the Print button. Visible focus is asserted at each stop.
  - Page objects: Blocks menu → "Select Image 1" (behind the text) → arrows / Shift+arrows move, Alt+arrows resize, Ctrl+] reorders, Tab → object toolbar → Delete object → focus back in the text, one Ctrl+Z restores it; the inspector's Page tab objects list selects an object (frame focused), Escape returns to the text.
  - Panels, menus and dialogs: a menu's Escape returns to its button, the next Escape to the text; outline open → heading entry (the caret moves there) → Close outline (focus → toggle); page box (type 3, ArrowUp → 2); style drawer (typed CSS restyles the pages; Escape then Tab leaves CodeMirror; Close → toggle); Local history Escape → its button; navbar Share → Copy link → toast → F8 focuses the notifications region.
  - Structure on /, /new, /edit, /share, /account, /login, 404: one banner, one main, nav "Main", exactly one h1 that comes first, no heading level skipped in the chrome, every toolbar named ('Editing' + 'Brew', or 'Viewing'), the layout status (role status) and save status live regions, the editor's description containing Alt+F10, the read-only "Pages" region focusable; the skip link is the first Tab stop from the top, visible, and moves focus into <main>.
  - Live regions: Ctrl+S → "Saved at …" in save-status-live; a failed save is announced; an oversized block → "1 layout warning" in the layout status.
  - Focus order on /edit from the top: skip link → navbar → editing toolbar (one stop) → brew toolbar (one stop) → the text → (Chromium: the TOC links) → inspector; every stop shows a visible focus (the resize handle included).
  - No keyboard trap: in a list Tab indents and in a table moves between cells, and Alt+F10 still reaches the toolbar (Escape back); outside them Shift+Tab leaves the text.
- layout.spec.ts: 320 × 640 and 640 × 400 (1280 × 800 at 200 %), one test per route: no sideways scrolling of the document, <main> or the header, and no chrome control off screen, on /, /new, /edit, /share, /account, /login and 404; the pages keep ≥ 200 px (320 px wide) / ≥ 120 px (200 % zoom) of height; every item of the editing and brew toolbars, walked with the arrow keys, is fully on screen. Reduced motion: hovering buttons, a menu, a drawer, a navbar panel and a save produce no running animation or transition (spinners excepted), and without the preference the same steps do (the probe sees them). Forced colours (skipped where the browser can't emulate them): the focused control of each toolbar and the navbar has an outline, an unfocused button has none.
- Timeouts (fail-fast rule): no `test.slow`; LOAD_TIMEOUT is 10 s and the tests run within Playwright's defaults. The editor's menu, dialog and panel states run on one loaded editor per scheme (`newSharedPage`, with `closeLayers`/`restorePanels` in beforeEach), as short tests (one per state group); waits use the page's own signals (aria-invalid, suggestion lists through aria-controls, the completion list, page-loading/aria-busy gone via `waitForPage`), and `scan()` waits for running CSS transitions to end (`animationsDone`) instead of sleeping.
- helpers.ts: `scan` (AxeBuilder in legacy mode, see the notes), `audit` (soft), `expectNoSerious`, `WCAG_TAGS`, `BREW_CONTENT`, `PORTAL`, `closeLayers`, `caretIn` (programmatic; axe walks only), `openEditor`, `waitForEditor`, `activeElement`, `focusIsVisible` (outline/box-shadow on the element, a :focus-within wrapper or a pseudo element, a filled pseudo strip ≥ 2 px, or a caret), `tabUntil`, `focusOn`. docs.ts: `richDoc` (headings, a note, a span, a link, a table, a list, a TOC, an image object behind the text and a text object), `oversizeDoc`, `trapDoc`, `TEXTS`. fakeApi.ts: `installFakeApi(page, { me?, notices? })` → FakeApi { me, loginAs, notices, brews, log, conflictNext, failSaves, add, saves }, `ALICE`, `ADMIN`, `docOf`.
- Run: `npx vite --config e2e/a11y/vite.isolated.config.mjs --port 5376 --strictPort`, then `E2E_PORT=5376 E2E_BASE_URL=http://localhost:5376 npx playwright test e2e/a11y` (Firefox: E2E_WORKERS=2 or 3 on a loaded machine). Without E2E_BASE_URL Playwright starts the normal dev server.

### Notes for later phases
- axe in Firefox (all lanes): `@axe-core/playwright`'s default mode finishes every `analyze()` in a NEW BLANK PAGE (`context.newPage()` + `axe.finishRun`). In Firefox on this machine that page took from seconds to over 8 minutes, or never came back ("page.evaluate: Test timeout", "Browser.removeBrowserContext … _maybeDontRestoreTabs" at teardown). With `new AxeBuilder({ page }).setLegacyMode(true)` (axe.run in the page; the app has no iframes, so the results are the same) the same scans took 1–3 s. helpers.ts `scan` uses legacy mode. Other lanes' axe specs (ui-kit, shell, toolbar, panels, inspector, objects, flows, smoke) use the default mode and may gain the same by switching; their notes about minute-long Firefox scans are probably this.
- Firefox makes scrollable elements focusable: the editing canvas's scroll container was an unnamed Tab stop between the brew toolbar and the text. EditorApp now sets tabindex=-1 on it in edit mode (the caret scrolls the pages); in view mode it stays the focusable "Pages" region.
- Results at the end (isolated Vite, 4 workers, both browsers at once): e2e/a11y 184 tests, all passing after the last two test fixes (the full run was 182/184; the two were test bugs, rerun green in both browsers): axe.spec.ts 66, keyboard.spec.ts 7 and layout.spec.ts 19 per browser. Vitest (web project) over src/app, src/ui, src/editor/EditorApp, src/pages/{edit,share,new,home}, src/ported/navbar, src/editor/ui/{inspector,pageNav} and editor/save/appRoutes: 48 files, 348 tests passing.
- Axe found no serious or critical violation in any route or state after the save-status fix, and no moderate or minor one in the chrome either (Chromium run with the JSON reporter: 66 tests, zero `a11y-minor` annotations; the exploration of the same states in Firefox matched).
- Remaining minor issues (documented, not fixed):
  - Editor pages put the caret into the brew on load (autoFocus), so the first Tab from a fresh /new or /edit goes forward to the panels, not to the skip link; Shift+Tab leads back to the toolbars, the navbar and the skip link. On the other pages the skip link is the first stop.
  - In lists Tab indents and in tables it moves between cells (the editor keeps the key). Not a trap: Alt+F10 and the arrow keys leave, and the editor's description says so.
  - The TOC's entries (brew content) are Tab stops after the text in Chromium, not in Firefox (links inside a contenteditable=false island); the outline offers the same navigation in both.
  - A page's "Oversized" badge in the canvas is pointer-only; the "N layout warnings" button in the brew toolbar opens the same list from the keyboard.
  - The object frame's hint (nodeviews/ObjectLayer.ts, objects lane) mentions Alt+click for objects behind the text; the keyboard way is the Blocks menu's "Select …" items. The hint could say so.
  - Spinners and the route-loading bar keep moving under reduced motion (they show progress; the Spinner already slows down).
  - The brew's own pages are excluded from axe (theme colours, author heading levels; e.g. upstream's welcome text skips heading levels).
  - Text spacing (WCAG 1.4.12) and real screen readers were not tested (only the accessible names, descriptions and live regions the DOM exposes).
- Other lanes:
  - Lists lane (web/src/ported/brewItem, web/src/ported/listPage; also check pages/vault): their focus rings are box-shadow only (BrewItem .titleLink, button.tag, .inlineLink, .action; ListPage .sortButton, .tagFilter, .groupToggle), so they vanish in forced colours. Add `@media (forced-colors: active) { X:focus-visible { outline: 2px solid Highlight; } }` like the UI kit. I left those files alone (being edited).
  - Save lane: one rule appended to web/src/editor/save/save.module.css (see Interfaces); it can be folded into the error-tone rule.
  - /user, /vault, /import and /admin (other lanes' pages, as they were at the time of the run) passed the axe audit in light and dark, both browsers (axe.spec.ts "route: …" tests). If they fail later, the owners should look at the named state.
- Process: I edited only my paths plus the one appended rule in save.module.css. No packages were added and no git commands that change the index were run. My runs used an isolated Vite on :5376 (e2e/a11y/vite.isolated.config.mjs, cacheDir node_modules/.vite-isolated-a11y) and no API server.


## Performance: 150-page brew, typing, long sections, theme switch (P8.1, plan §4.10)

### Interfaces
MEASURING (web/src/dev/perf, web/e2e/perf)
- /dev/perf (dev registry page) mounts a document in the real EditorApp (`shell: 'app'`: edit mode, saving none, no navbar) or in EditorCanvas with the app's editing extensions, toolbar and layout status and a switchable theme (`shell: 'canvas'`). `window.__hbPerf` (perfController.ts, typed in e2e/perf/helpers.ts): `mount(doc, {shell, theme, style})` → LoadReport (ms to editor, first paint, ready, settled), `placeCaret(page, 'middle'|'end')`, `startTyping()` / `stopTyping()` → TypingReport, `insertText(text)` → EditReport (dispatch to settle), `setTheme(theme)` → ThemeSwitchReport (canvas shell), `quiet(since, ms)`, `frames(from)`, `json()`, `pageKinds()`, `env()`.
- perfProbe.ts, per keystroke: `handlers` (keydown to the end of its input task, the input event's own task included), `frame` (to the next rAF), `paint` (to the first task after that frame's rendering: event to next paint), `work` = handlers + that frame's work (what has to fit in 16 ms; `paint` adds up to one frame interval of waiting for vsync, so its p95 can't be under ~16 ms even with no work), `dispatch` / `view` (the keystroke's own view.dispatch / updateState, timed by wrapping them while recording), `settle`, `frameSteps` / `frameWork`. Also PerformanceObserver 'event' entries (durationThreshold 16) and 'long-animation-frame' entries where supported. perfStats.ts: nearest-rank percentiles (perfStats.test.ts).
- Pagination profiler (plugin.ts): `setPaginationProfiler(fn | null)`; every scheduler run reports a `PaginationFrameProfile` { start, end, steps, docSteps, stepMs, dispatchMs, actions, settled, forced, detail[] (page, action, stepMs, dispatchMs per step) }. Costs nothing while unset. The probe summarises it per action (`byAction`) with the slowest steps.
- Fixtures, generated (fixtureGen.ts: original lorem-style prose from a seeded PRNG and an invented vocabulary) and stored as the documents after pagination settled in Chromium, auto pages included: e2e/fixtures/perf-150.json (153 pages, 1.6 MB: a cover with the frontCover marker and an image object, a TOC page, twelve 2-column chapter sections with headings, paragraphs, bullet, ordered and definition lists, tables, notes, descriptive boxes, stat blocks, a wide block and images with their natural size, and a 1-column appendix) and perf-50.json (one 2-column section of flowing prose, 51 pages: long paragraphs, a heading every nine paragraphs, so an edit on page 1 moves every boundary). Regenerate with `HB_PERF_GENERATE=1 E2E_PORT=5375 npx playwright test e2e/perf --project=chromium-serial --no-deps -g regenerate`.
- Specs: e2e/perf/perf.spec.ts (the budgets on the big fixtures are tagged @serial: the chromium-serial / firefox-serial projects, one worker, one budget per test, each on a fresh page; the parallel projects have the ≤ 6 s smoke tests on a small generated brew) measures load, typing, the 50-page section and the theme switch, and asserts the targets times `HB_PERF_TOLERANCE` (default 1.5) with expect.soft, so every number is printed (`[perf <project>] <name>: …`) and attached as JSON. e2e/perf/pagination-work.spec.ts (both browsers, parallel) checks the optimisations below functionally. Run the timing spec on its own with `node e2e/perf/run-perf.mjs [--prod] [--set=<n>] [playwright args]` from web/ (three sets: smoke, budgets in Chromium, budgets in Firefox) (an isolated Vite without HMR or file watching, e2e/perf/vite.perf.config.mjs, on E2E_PORT 5375; `--prod` builds with the dev routes into a temp directory and serves it with vite preview), or `E2E_PORT=5375 npx playwright test e2e/perf`. The isolated server doesn't watch files: restart it after changing sources.

PAGINATION CHANGES (web/src/editor/pagination)
- Measure-only steps are batched (plugin.ts runSteps). A step whose transaction changes nothing ('settled', 'oversized' already flagged, 'waiting', 'done') is not dispatched: the next step continues from its progress, and it goes out with the next transaction in `PaginateMeta.batch: PaginateStep[]` ({ page, action }, in order), or on its own when the frame ends or the pass settles. New exports `paginateSteps(meta)` (the batched steps, then the own one) and type `PaginateStep`. applyPagination counts batched steps in the stats and applies their waiting/measured effects. A dispatch runs every plugin, the view update and every editor listener (React selectors); a page that only needed measuring now costs none of that. Anything that reads PAGINATE metas step by step must expand them with paginateSteps.
- A user change dirties the page before it only when it can reach what that page would pull (plugin.ts `reachesPreviousPage`): the change starts at or before the end of the auto page's leading headings plus the block after them, or at a manual page's own start (kind: the section break). Typing in the middle of a page checks one page instead of two. `changedPages` keeps its contract; `changedRange` (positions) is internal.
- Exact partial pulls (measure.ts pullTarget; new export `lineStart(view, el, pos, node, n, lineHeight)`): when only the first lines of a paragraph on the next page fit, and both pages' columns are equally wide, the pull ends at the start of the first line that stays, found with coordsAtPos in the paragraph's current layout (line breaks don't depend on the page then). Before, the whole paragraph was pulled and the rest pushed back by the next step: twice the DOM re-created. Irregular lines (inline images, larger text) or different column widths fall back to the old behaviour. Blank → 5ePHB on the 153-page brew went from 102 push-backs to 44.
- fragments.ts `neighbour()` finds the adjacent page from the page's own position (O(depth)); it summed the sizes of every page before it, so `formerContinuations`, run on every author transaction, was quadratic in pages. The fragment fixes per keystroke on the 51-page section: 1.7 → 0.6 ms (formerContinuations 1.66 → 0.24 ms); 1.5 ms at 153 pages. formerContinuations still walks every page: restricting it to the touched pages broke undo at a seam (e2e/pagination/s2.spec.ts:97 failed 4 of 4: an undo brings a fragment back far from where the history's mapping puts its change).
- layout.ts `markMeasuring(view, index)` / `MEASURING_ATTR = 'data-hb-measuring'`: where offscreen pages skip rendering (below), the page being measured and the one after it carry the attribute and render normally (canvas.css). Without it, Chromium's layout of a just-changed skipped page was a line off right after a push, which cost a pull and a push back per page in long passes (5ePHB → Blank: push, pull, push on most pages instead of push, settled). PageView ignores attribute mutations of the page element and keeps attributes it didn't write. No DOM writes where pages don't skip.

CANVAS CHANGES (web/src/editor/canvas)
- offscreen.ts: `probeSkippedLayout()` (once per page load: in a Chromium-based browser, an offscreen probe element with content-visibility: auto; after the browser reports it skipped (`contentvisibilityautostatechange`), whether a layout query sees its child's new size), `skippedLayoutAnswer()`, `isChromiumEngine()` (navigator.userAgentData lists a Chromium brand), `OFFSCREEN_ATTR = 'data-hb-offscreen'`, `OFFSCREEN_PROBE_TIMEOUT_MS` (2000; no answer = no), `resetOffscreenProbe()` (tests). Tests: offscreen.test.ts, e2e/perf/pagination-work.spec.ts.
- EditorCanvas sets `data-hb-offscreen="skip"` on .hb-canvas once the answer is yes (pages stay visible until then and wherever it is no).
- canvas.css: `.hb-canvas .page { content-visibility: visible !important }` stays the default (plan §4.2); `.hb-canvas[data-hb-offscreen='skip'] .page { content-visibility: auto !important }`; `.hb-canvas .page[data-hb-measuring] { content-visibility: visible !important }` after it; in print media nothing skips. The themes' Blank base already gives .page `contain: strict`, so auto adds no containment; it only skips rendering of offscreen pages until something reads them, as upstream's preview does.
- Why only Chromium: Chromium brings skipped content up to date for layout queries, for whole pages (e2e/canvas/multicol.spec.ts compares every box of every page, skipped ones included, with pages fully laid out: max delta 0 px for the canvas documents in five themes and the paginated harness documents, mixed20 and long30 included). Firefox lays out a small skipped element for a query (a probe alone says yes there), but answers with empty boxes for parts of a skipped page: its column wrapper (0,0,0,0), or its page number and footnote chrome. Pagination would skip or misjudge those pages.

CHANGES IN OTHER LANES' FILES (smallest additive changes)
- src/editor/schema/plugins/headingIds.ts: appendTransaction skips transactions that are all pagination's (meta 'hbPaginate') and keep the page count (`layoutOnly`). Pagination moves whole headings (join + split) and never changes their text, attributes or order; only the page count can change generated ids (they avoid p1…pN). That was a walk over every heading per pagination step (1.4 s of two theme switches on the 153-page brew). Test in pagination/plugin.test.ts.
- src/dev/pagination/harness.ts: the step log expands `meta.batch` before the step itself, so `events()` still lists every step.
- e2e/canvas/multicol.spec.ts: the upstream-structure reference is also forced to content-visibility: visible (`UPSTREAM_PAGE` also matches `.hb-canvas[data-hb-offscreen] .page`, for the specificity of canvas.css's rule). In Chromium a skipped page with upstream's block structure (a column-spanning wrapper inside a multicol page) lays its wrapper out 469 px low; our flex structure doesn't. The spec now compares our pages as rendered (skipped offscreen in Chromium, brought up to date by its layout queries) with upstream's structure fully laid out.

SECOND PASS, QUIET MACHINE (P8.1 re-measured and finished; only this lane running)
- Page ids are no longer decorations (schema/plugins/pageIndexIds.ts): the plugin's view writes `id="p{n}"` on the page elements after every view update, only where it differs, with ProseMirror's DOM observer paused (`view.domObserver.stop()/start()`, the internals ProseMirror brackets its own DOM writes with; pages rendered by toDOM alone would otherwise be re-read and re-rendered). New export `syncPageDomIds(view)`; `pageIndexIdsKey` stays (no plugin state any more). Why: a page decoration whose id changes on every page after an added or removed page defeats ProseMirror's child matching (sameOuterDeco fails; updateNextNode then reuses the removed page's view for the next page, and every later page is re-rendered one element over). A theme switch that removed 32 pages re-created ~2,800 page elements with their whole flow (Firefox: 31 ms per removal to dispatch, 54 ms to lay out again). Tests: nodeviews/PageView.test.ts (a removed page keeps the later pages' elements), e2e/perf/perf.spec.ts smoke 'a theme switch that removes pages keeps the elements of the pages after them' (fails with the old decorations: 23 extra elements on a 30-page brew).
- schema/plugins/stepScope.ts (new): `everyChangedRange(trs, fn)`, `touchesNode(trs, test)` (a node overlapping a changed range before or after the step; attribute and mark steps count their own position/range), `withinPages(trs)` (every change inside one page's content), `inlineOnly(tr)` (text or marks inside one textblock per step). Tests: stepScope.test.ts.
- Per-transaction plugins made incremental: headingIds (walks the headings only when a heading was touched or the page count changed), pageIds (only when a change leaves a page or the page count changed), tables/headerRows.ts (its DecorationSet is mapped unless a table node was touched; test in tables/commands.test.ts compares with a fresh build through typing, a join + split and a header-row change), toc (computeToc.ts caches each page node's numbering markers and headings in a WeakMap: unchanged pages keep their node; tocPlugin.ts caches the theme's --TOC verdicts per page node, index and heading position until the next restyle, and skips a toc whose entries (positions aside) are unchanged, so no offsetHeight read per settle), the pagination plugin's appendFragmentFixes (returns at once when every author transaction is inlineOnly: typing opens, closes, joins and deletes no block).
- ui/blockMenu/BlockMenu.tsx and ui/tableMenu/TableMenu.tsx compute their context (blockMenuContext / tableMenuContext: five and ten dry-run commands) only while the menu is open (`onOpenChange` of MenuButton, uncontrolled); the button is disabled from a cheap `isEditable` selector. TableMenu keeps the column width in the dialog's state (`widthDialog.initial`), taken when the item is chosen.
- nodeviews/PageView.ts `patchChrome`: when the chrome renders the same elements (count and tags, the oversize badge aside), attributes and content are copied onto the current elements instead of re-creating them. Committing an object drag no longer re-creates (and re-loads, re-decodes) the page's images; the object frame (ObjectLayer) keeps its element and its size. Before, in Firefox the frame had the height of an unloaded image (4 px) right after the drag (e2e/objects/objects.spec.ts:123 failed 2 of 3 alone). Test in PageView.test.ts.
- pagination/layout.ts `FailedPulls` (exported; `failedPulls(view)` lists them): a pull whose content all came back (the page after the push-back equals the page before the pull) is remembered with what it was decided on (the page's last block, the next page's first block, the pull's end, the measurement: columns, widths, box height, free space); the same pull is not tried again until a REPAGINATE (new stats field `PaginationStats.repaginations`, counted in applyPagination). Firefox typing on page 120 of the 153-page brew did pull, push, pull, push on every keystroke (a paragraph after a definition list: `dl + * { margin-top: 0.17cm }` in context, 0 at the top of a page; Firefox has no orphans, so a one-line pull was tried). Tests: layout.test.ts.
- pagination/measure.ts pullTarget: paragraphs flow line by line and bullet/ordered lists item by item (items are break-inside: avoid) through the free columns (`flowUnits`, `placeUnits`), when both pages' columns are equally wide: a unit only where it fits whole, the block's margin-top truncated at the top of a column entered by an unforced break, orphans/widows kept at column breaks inside the page and at the page end. A list is pulled up to its last item that fits (a position inside the list; the split makes the continuation), no longer whole. Continuous heights (the previous flowInto) counted the part of a column a line or an item can't use: pulls pushed back afterwards (theme switch Blank → 5ePHB) 40 → 28 in Chromium, 48 → 31 in Firefox; lists 26 → 3. Definition lists keep the old estimate.
- pagination/plugin.ts: offscreen passes go on between frames (`PaginationOptions.requestTask`, default a MessageChannel message in the browser; none when `requestFrame` is given, so unit tests keep controlling frames). When a frame's budget runs out and the next page to check is offscreen, a task runs the next budget (8 ms) and so on (a task doesn't start while Chromium reports input pending, `navigator.scheduling.isInputPending`); pages in view stay with the frames (they settle before paint; MAX_STEPS_PAST_BUDGET unchanged). The plan's 8 ms per frame still holds; the idle rest of each frame interval is used. Tests in plugin.test.ts. Frame profiles (`PaginationFrameProfile`) also report these runs; `detail[]` entries have `pages` (page count after the step).
- /dev/perf: `window.__hbPerf.inspect(index)` (a page's measurement, pull estimate, last block and next page's first block, for debugging estimates) and `failedPulls()`. e2e/perf/helpers.ts `record()` also appends each result as a JSON line to `HB_PERF_OUT` when set. perf.spec.ts: the typing budget runs on the 153-page brew and on a 10-page brew (the first 10 pages of perf-150: cover, contents, 8 pages of chapter 1).
- Profiling recipe (no scratch scripts kept): Chromium CPU profiles through Playwright's CDP session (`Profiler.start/stop` around `__hbPerf` calls) of a production build made with `vite build --minify false` (VITE_HB_DEV_ROUTES=1) and served by `vite preview`; Firefox with the Gecko profiler through environment variables on the launched browser (`test.use({ launchOptions: { env: { MOZ_PROFILER_STARTUP: '1', MOZ_PROFILER_SHUTDOWN: '<file>.json', MOZ_PROFILER_STARTUP_FEATURES: 'js,stackwalk,cpu', MOZ_PROFILER_STARTUP_FILTERS: 'GeckoMain' } } })`, top level in a spec file; the profile is written when the browser closes; `performance.mark()` markers delimit the scenario; label frames such as 'Reflow', 'Styles', 'EventStateManager::PreHandleEvent' and JS function names are readable without symbols).

### Results
Quiet machine (2026-09-26, second pass): 22 logical CPUs (Intel Core Ultra 7 165H), Windows 11, only this lane running, 0–8 % CPU busy before each measurement. Production build (`node e2e/perf/run-perf.mjs --prod`, the budgets in one worker; at the time an opt-in long project, now the serial projects). "Before" is the code as the first pass left it, measured the same way at the start of this pass; "after" is two full runs each.

Chromium

| | Before | After (run 1; run 2) | Target |
|---|---|---|---|
| Typing, 153-page brew (242 keys at ~9/s, pages 40 and 120): work p50 / p95 | 8.9 / 13.8 ms | 6.6 / 10.7; 6.7 / 9.7 ms | p95 < 16 ms: met |
| … event to next paint p50 / p95; the key's own dispatch p50 / p95 | 6.4 / 9.2; 1.9 / 2.5 ms | 4.6 / 6.9; 0.7 / 1.0 ms | |
| Typing, 10-page brew (pages 4 and 8): work p50 / p95 | 6.1 / 8.1 ms | 5.8 / 7.0; 5.5 / 7.1 ms | met |
| 51-page section, typed on page 1: worst key to settled | 200 ms (158 steps) | 101; 102 ms (119 steps) | < 1 s: met |
| … pasted paragraph (11 lines) on page 1: to settled | 126 / 207 / 141 ms | 86 / 75 / 74; 102 / 89 / 80 ms | < 1 s: met |
| Theme 5ePHB → Blank (153 → 184 pages), switch to settled | 1515 ms (389 steps) | 880; 934 ms (417 steps) | < 3 s: met |
| Theme Blank → 5ePHB (184 → 153 pages) | 1923 ms (397 steps) | 1087; 1081 ms (387 steps) | < 3 s: met |
| Load, stored layout (153 pages): editor / first paint / ready / settled | 324 / 446 / 691 / 1543 ms (377 steps, 61 changing) | 318 / 441 / 670 / 1143 ms (380 steps, 33 changing) | no target |

Firefox (lays the brew out on 151 pages)

| | Before | After (run 1; run 2) | Target |
|---|---|---|---|
| Typing, 153-page brew: work p50 / p95 | 17 / 46 ms (max 67; 159 boundary moves) | 11 / 13; 11 / 14 ms (7 boundary moves) | p95 < 16 ms: met |
| … event to next paint; the key's own dispatch p50 / p95 | 13 / 28; 3 / 4 ms | 9 / 11; 1 / 2 ms | |
| Typing, 10-page brew: work p50 / p95 | 7 / 10 ms | 7 / 9; 7 / 9 ms | met |
| 51-page section, typed: worst key to settled | 224 ms (140 steps) | 74; 74 ms (101 steps) | < 1 s: met |
| … pasted paragraph: to settled | 242 / 221 / 235 ms | 78 / 71 / 82; 80 / 79 / 73 ms | < 1 s: met |
| Theme 5ePHB → Blank (151 → 184 pages) | 2665 ms (372 steps) | 2331; 2381 ms (371 steps) | < 3 s: met |
| Theme Blank → 5ePHB (184 → 152 pages) | 4799 ms (550 steps) | 2190; 2223 ms (533 steps) | < 3 s: met (was missed) |
| Load, stored layout: editor / first paint / ready / settled | 287 / 336 / 783 / 1674 ms (417 steps, 120 changing) | 315 / 344 / 997 / 1416; 314 / 344 / 813 / 1229 ms (403 steps, 96 changing) | no target |

The first pass's numbers (loads of 10.7–26 s, theme switches of 8.7–12 s in Chromium and 23–43 s in Firefox, typing p95 of 69–167 ms in Chromium and 409 ms in Firefox, the section in ~1 s) were taken with ten other lanes running (46–64 % CPU busy) and don't describe the code: on the quiet machine the same code already met every target in Chromium, and missed only Firefox typing on the 153-page brew (46 ms p95) and Firefox Blank → 5ePHB (4.8 s). Runs still vary: one Chromium typing run in this pass measured p95 19.4 ms with no pagination behind the slow keys (input handling alone 11–18 ms on 25 keys, no long animation frames); two reruns gave 9.5 and 10.2 ms.

What changed the numbers (profiles: Chromium CPU profiles, Firefox Gecko profiles, the pagination profiler):
- Firefox typing on page 120 (46 → 13 ms p95): every keystroke pulled a line after a definition list and pushed it back, twice (the page's re-check): FailedPulls. The other keystrokes: per-key JavaScript in Firefox was ~9 ms (TOC refresh 2.4 ms: page numbering walked every node of every page twice; header-row decorations 1 ms; heading ids 0.9 ms; fragment fixes 0.75 ms; the block and table menus' contexts 0.8 ms; page-id decorations 0.3 ms): now ~2 ms per key (dispatch p50 3 → 1 ms). In Chromium the same work was ~2.4 ms per key.
- Theme switches: the page-id decorations made ProseMirror re-create every later page on each removed page (Firefox Blank → 5ePHB: 2.7 s of 3.9 s of step work); offscreen passes waited for a frame per 8 ms budget (Chromium idled through half of each frame interval: −20 to −30 % with the between-frames tasks); pulled lists came back item by item.
- Section and load: the between-frames tasks (the cascade through a 51-page section is offscreen after the first two pages).

Where the time goes now:
- Typing (Firefox, 153 pages, ~11 ms p50 per key): ~9 ms of input handling, of which the key's dispatch ~1 ms (view update 0.4 ms incl. scrollToSelection's layout read, plugins, listeners) and the rest Firefox's own editing and event work, which grows with the size of the editing host (5–6 ms on the 10-page brew); the frame after it ~2 ms (pagination measures one page ~0.5 ms, style, layout, paint). A Gecko profile also shows EventStateManager::PreHandleEvent inside the refresh tick, ~1.8 ms per key (Firefox-internal). Chromium: ~5 ms input handling (dispatch 0.7 ms) and ~2 ms frame.
- Theme switch, Firefox Blank → 5ePHB (~2.2 s): 300 ms is the plan's repagination debounce (§4.7, theme or CSS change, debounced 300 ms; `REPAGINATE_DELAY_MS`), ~1.8 s of steps: measuring a page after a boundary move is its reflow (Gecko profile: 'Reflow' ~65 % of the pass; ~3 ms per 'settled' measure, ~5 ms for a page that received content); the 32 page removals cost ~25 ms each in the measure after them (756 ms: the themes' `.page:nth-child(even)` rules and page-number counters change for every later page, and Firefox can't skip offscreen pages); 31 pulls still come back (margin or text-indent in context: `dl + *`, `p + p { text-indent }`; definition lists). 5ePHB → Blank (~2.3 s): 33 page inserts (94 ms to dispatch, 512 ms of later-page restyle), 196 'settled' measures at ~8.6 ms (the reflow of the page that received the pushed content).
- Theme switch, Chromium (~0.9–1.1 s incl. the 300 ms debounce): ~0.7 s of steps, ~90 ms between frames.

What would close more (not needed for the targets):
- Firefox theme switch: add or remove the pages of a section once, at the end of its pass (keep emptied auto pages, or add the new ones after the section's last page, in one transaction), so the later pages restyle once per section instead of once per page (~0.5–0.7 s per switch); repaginate a section in bulk (lay it out once, take the cuts from its overflow columns, one join + split transaction, then verify page by page) so each page is reflowed about twice instead of three to five times.
- Pull estimates: the margin and text-indent a block gets after the page's last block (a context probe: a shallow clone after the page's last block, read, removed with the DOM observer paused), and definition-list groups (their line heights).
- Visible pages first (for how soon the user sees a settled view, not for the settle): the pass could take the section in view first; sections are independent except for parity, which the pass already handles by continuing to the end.

### Notes for later phases
- Integration: e2e/perf/perf.spec.ts budgets are @serial (chromium-serial / firefox-serial, one worker; one budget per test, the slowest the typing ones at ~33 s, since they type at a person's pace; ~2 min per browser with the development build, 2026-09-26); all pass on this machine in both browsers, with the development build too. The section budget is two tests (typed, pasted), each on a fresh page; the fixtures regenerate one test per fixture. The default run has four smoke tests (each ≤ 6 s) and e2e/perf/pagination-work.spec.ts. HB_PERF_TOLERANCE (default 1.5) still widens the budgets for slower hardware; the numbers above are below the untolerated targets.
- Checked in this pass: `npm test` (187 files, 2,637 tests), `npx tsc -b`, eslint on the changed files; e2e in both browsers: pagination, sections, matrix (and the serial projects), canvas, perf, toolbar, objects, snippets, inspector, panels, export, snippets-editor, a11y, import/toc.spec.ts, dev-schema, smoke, and flows (run-flows.mjs, private API on :5436, database hb_e2e_perf_flows). Flaky, not reproduced alone: e2e/inspector/inspector.spec.ts:209 (keyboard) failed once in a parallel Chromium run (3/3 alone); two Firefox axe dark-scheme tests hit 'Target crashed' about 700 tests into an accidental whole-suite run (86/86 when rerun).
- The page ids and the chrome patch are general: anything that adds or removes pages (commands, paste, undo of a page break) no longer re-renders the pages after it, and any object attribute change keeps the object's element.
- Pre-existing pull-estimate misses (first pass): the stored 153-page layout still has 5–7 pages whose re-check pulls and pushes back (a definition list or list after a paragraph, `p + dl` margins); FailedPulls now makes each cost one pull per REPAGINATE instead of one per check.
- A 1-line-per-keystroke cascade stops at the first page with room (a page that ends before a heading or at a paragraph's last lines), so typed cascades in real brews are usually short; the section fixture is the long worst case.
- No packages needed.


## Test matrix, fuzz, CI and test robustness (P4.9, P0.5, plan §4.11, §12)

### Interfaces
THE §4.11 MATRIX (web/e2e/matrix: one spec per row, Chromium and Firefox, in the app's real editor)
- Every case runs on /edit/:editId: EditorApp with toolbars, panels, autosave, pagination, seam editing and objects. The brew API is stubbed by pathname (`stubBrewApi`, no server). GET returns the document as stored (not paginated), so every load paginates from scratch; PUT answers a new version and is counted.
- The dev harness's test API is attached to the app's editor in the page (`attachHarness`: `new PaginationHarness({ paginate: true }).attach(window.__hbEditorApp.editor)`, imported from the dev server). So `window.__hbPagination` (texts, pages, domTruth/overflowing, flowText, frameWatch, events, fuzz …) reads the real editor. Zoom goes through the toolbar's zoom menu, not the harness's setZoom (EditorApp gives the harness no controls).
- Rows → specs:
  - typing: a frame watch checks every painted frame (none overflows); the caret follows to page 2 in the model, in the DOM selection and on screen.
  - delete: pull-back; emptied auto pages go; one undo step.
  - undo: insert at the seam, undo and redo (keyboard and toolbar): same texts per page each time.
  - splitParagraph: head edits re-join and re-split at a line start.
  - orderedList: the continuation's `start` in the model and the rendered `<ol start>`; the visible numbers run 1…N through Enter, undo, and a list pushed item by item onto the next page.
  - heading: typed text pushes a heading down; it is never left last on a page, and it moves while there is still room for it.
  - oversized: the stat block moves whole to the top of page 2, which is flagged; badge plus "1 layout warning"; a full re-check makes no push or pull; "Allow splitting" from the warning clears it; one undo brings it back.
  - sections: a 1-column section, then a 2-column one: shrink, grow, undo. Nothing crosses the manual page; measured columns are 1 and 2.
  - cover: a front cover is measured in 1 column and filled, its auto pages in 2. Blocks menu › Front cover re-lays the section out (page 1 full once the cover fonts have arrived); back to 2 columns gives the same flow text and page count (the seam may differ by a line: a one-line tail is not pulled back, pulls need two lines).
  - wide: the flow below the spanner fills both columns; typing above pushes the spanner to page 2 whole.
  - ime: Chromium does a real composition through CDP. Both browsers get compositionstart/update/input/end dispatched, with the text written into the DOM between them. There is no pagination step while composing, even with page 1 overflowing; at compositionend there is a push, and the caret is on page 2.
  - lateFont: brew CSS @font-face whose file is held past the 10 s fonts gate. The pages are laid out with the fallback first; then a repaginate from 0 checks every page and moves the boundaries; after the settle, 500 ms of frames show no overflow and no further step.
  - zoom: 50 % and 200 % from the zoom menu. A full re-check keeps every boundary; reloaded at that zoom, the stored 20-page document paginates to the same boundaries.
  - fuzz: 1,000 edits per browser as 20 tests of 50 edits (seeds 20260926 + k), in the parallel projects.
- helpers.ts:
  - `test` and `expect`: import them from './helpers'. The page fixture lets autosave come to rest before the page closes (see the notes).
  - `openEditor(page, { doc, style?, theme?, title? }) → ApiLog { saves }`, `attachHarness`, `settled`, `texts`, `pages`, `flowText`, `stats`, `events`, `stepsOf`, `repaginationsOf`, `select(anchor, head?)`, `watchErrors` (page errors and `[pagination]` console errors).
  - `expectClean`: no overflow (DOM truth), no continuation that starts with a space, no loop-guard hit, no failed step, no errors. Also `expectNoEmptyAutoPages` and `expectNoStrandedHeadings`.
  - Builders: `sectionDoc(pages)`, `mixed20()`, and re-exports of the pagination harness's (`doc`, `pg`, `h`, `p`, `ol`, `ul`, `li`, `block`, `filler`).
- Fuzz (fuzz.spec.ts: 1,000 edits per browser as 20 short tests of 50 edits, each on a fresh document with its own seed; ~4 s in Chromium, ~8 s in Firefox under a full set): the harness's seeded mix of edits on mixed20 (3 sections, 20 pages) in the app's editor: text and block inserts and deletes, splits, joins, undo and redo, sometimes several edits before one settle. It asserts: no overflow after any settle (DOM truth), the flow text unchanged by pagination, 0 loop-guard hits, 0 failed steps, and the edits saved afterwards (Mod-S). HB_FUZZ_SEED (default 20260926) moves every seed.

PLAYWRIGHT CONFIG (web/playwright.config.ts)
- Projects: `chromium` and `firefox` (everything except @serial); `chromium-serial` and `firefox-serial` (grep @serial, `workers: 1` each: the S2 30-page budget and the perf budgets). Tag a test `@serial` when it measures time. There is no long tier: a test that would run for minutes is split into short tests (docs/testing.md, "Splitting a slow test").
- The serial projects depend on the parallel ones only in a bare full run: `npx playwright test` with no file, --grep, --project, --shard, --last-failed … filter. They then run last and alone, and a failure in the parallel projects skips them.
  - With any filter there are no dependencies. Reason: Playwright runs a dependency project unfiltered. A filtered run that selected one @serial test (say `npx playwright test e2e/pagination/s2.spec.ts`) would first run the whole suite in both browsers.
  - The config my previous attempt left had unconditional dependencies. Nothing was tagged yet, so it never bit.
- `testIgnore: ['**/_*']` under CI or E2E_SUITE=1: scratch specs (`_explore.spec.ts`, `_probe.spec.ts` …) never run in CI or in a suite run. Lanes can still run their own directly.
- CI settings: workers 2 (E2E_WORKERS overrides), retries 2, reporters github + blob (web/blob-report) + list.

SUITE RUNNER (web/e2e/matrix/run-suite.mjs; what CI runs)
- `node e2e/matrix/run-suite.mjs [playwright args…]` from web/. It starts (or reuses) two servers:
  - The API on SUITE_API_PORT (5474): `dotnet run --configuration HB_API_CONFIGURATION (Debug) --artifacts-path HB_ARTIFACTS (<tmp>/hb-artifacts-suite)`, with `--no-build` when HB_API_NO_BUILD=1. Database SUITE_API_DB (hb_e2e_suite) on HB_E2E_DB_HOST:HB_E2E_DB_PORT (default localhost:5432), migrated on start. Admin__Emails: flows-admin@e2e.test, shell-admin@e2e.test and HB_E2E_ADMIN_EMAILS. Spa__DevServerUrls is the Vite origin.
  - Vite on E2E_PORT (5374) with e2e/matrix/vite.isolated.config.mjs (no HMR or file watching, one cacheDir per port).
  - Then it runs Playwright with E2E_BASE_URL, HB_API_URL, FLOWS_ADMIN_EMAIL and E2E_SUITE=1.
- Without --project it runs two phases, both with `--pass-with-no-tests`, and exits non-zero when either failed:
  - Phase 1: `--project=chromium --project=firefox`.
  - Phase 2: `--project=chromium-serial --project=firefox-serial --workers=1 --output=test-results/<port>-serial`.
  - With --project it runs once, as given (the CI shards do this). Pass options as `--opt=value`.
- Readiness checks try localhost, 127.0.0.1 and [::1]. In the Playwright Linux image, Node resolves localhost to ::1 first and fetch doesn't fall back, while Vite listens on 127.0.0.1 only.

CI (.github/workflows/ci.yml; actionlint 1.7.12 with shellcheck: clean, pr-check.yml's checkout@v2 bumped to v7)
- `web` (ubuntu-latest, node 24): npm ci, lint, typecheck, unit tests, `npm run schema -- --check`, build.
- `e2e`: matrix chromium/firefox × shards 1–4.
  - Runs in container mcr.microsoft.com/playwright:v1.63.0-noble with --ipc=host and HOME=/root, with service postgres:18 as `db`.
  - Steps: setup-node, setup-dotnet 10.0.x, npm ci, `dotnet build src/Homebrewery.Api --artifacts-path .artifacts`, then `run-suite.mjs --project=<browser> --shard=N/4 --grep-invert "S3 import fidelity"`.
  - Uploads the blob report, and test-results on failure.
- `e2e-serial`: matrix chromium/firefox, same container and service. Runs `run-suite.mjs --project=<browser>-serial` (the S2 30-page budget and the perf budgets). No nightly or long jobs: the e2e job has 8 Chromium and 16 Firefox shards (one short Playwright run each), and the `snippet-fidelity` job runs every snippet fixture in 2 shards per browser. Uploads the blob report and test-results.
- `fidelity`: matrix chromium/firefox, same image, no API. Runs the fidelity smoke subset (fidelity.spec.ts without FIDELITY=all), then writes scripts/fidelity-report.ts output to the job summary. Uploads the report, the images and the blob report.
- `e2e-report` (after those three, unless cancelled): merges every blob report into one HTML report (artifact playwright-report).
- `dotnet`: unchanged.
- The e2e jobs run in the same Playwright image the Linux screenshot baselines were recorded in (same fonts and browsers).

LINUX SCREENSHOT BASELINES
- web/e2e/canvas/baseline/s1-p1-chromium-linux.png and s1-p1-firefox-linux.png. They were recorded in mcr.microsoft.com/playwright:v1.63.0-noble (HB_UPDATE_BASELINE=1, "regression baseline" test of e2e/canvas/screenshot.spec.ts), so CI compares instead of skipping. Checked by a second run, --repeat-each=2, in both browsers.
- screenshot.spec.ts is the only platform-specific spec.

PAGINATION FIX (pagination core, found by the matrix in Linux; files outside my paths, additive)
- The bug: a hanging space was left at the start of a continuation. With white-space: pre-wrap, the spaces of a soft wrap hang at the end of the line. coordsAtPos can place such a space past the column's edge, so firstPosOutside cut before it, and the continuation on the next page started with a space (a visible indent). A redo at a seam could also leave a space, or a page holding only a space, there.
  - In Linux this failed e2e/pagination/cut.spec.ts ("paragraph …", Chromium), s2.spec.ts's undo test (Chromium) and e2e/matrix/undo.spec.ts (both browsers).
  - On Windows the fonts' metrics hid it, but the redo case was there too.
- cut.ts `afterHangingSpaces(doc, at, max)`: a line cut that falls on spaces moves past them, when a word follows in the paragraph.
- cut.ts `hangingSpacesPull(page, next)`: a pull target that takes the spaces a continuation paragraph at the top of an auto page starts with back to its head. A continuation of nothing but spaces goes back whole. It is wired in layout.ts domLayout (`pullTarget(view…) ?? hangingSpacesPull(page.node, next)`), DOM layouts only: the line model gives spaces a width.
- Test changes:
  - Unit tests: src/editor/pagination/hangingSpaces.test.ts.
  - e2e/pagination/cut.spec.ts: the two "cut is the start of its first line" tests now also assert that the text after the cut doesn't start with a space. They accept that the character before the cut is a hanging space placed outside the box.

ROBUSTNESS OF TIMING-SENSITIVE SPECS (assertions unchanged)
- e2e/pagination/s2.spec.ts:
  - The 30-page budget (500 ms per edit) is tagged @serial; the 1,000 fuzzed edits are 20 tests of 50 (seeds 20260924 + k), ~2 s each.
  - The budget is measured with performance marks in the page, from right before the edit to the first frame that sees the settle.
  - The undo test inserts its sentence as one input event: typed key by key, the 500 ms history grouping split it under load.
  - Timeouts: the defaults (fail-fast rule). The /dev/pagination and /dev/sections specs share one loaded page per worker (the harness's `test` with a `harnessVariant` worker option; `useHarness()` resets it in place), and waits use `READY_TIMEOUT` / `SETTLE_TIMEOUT` (10 s).
- e2e/pagination/measure.spec.ts: the defaults (the earlier 120 s file timeout, `navigationTimeout: 90_000` and 300 s zoom test are gone).
- e2e/import/hbfmToDoc.spec.ts:
  - "Not the 10 s timeout" now measures the import alone, in the page (performance.measure around hbfmToDoc). The old wall clock included loading /dev/import.
  - The defaults; the dev page is loaded with `waitUntil: 'domcontentloaded'`, then its own data-render-status signal.
- e2e/matrix/splitParagraph.spec.ts: the seam check reads the head's last line box (its last fragment), not coordsAtPos's glyph box. It allows for orphans/widows: less than two lines left below the head, and the head ends at a soft wrap.
- e2e/matrix/cover.spec.ts: after choosing a cover type it waits for document.fonts and the repagination that follows (a cover page's theme rules load other fonts; Firefox measured the page 5 lines short before that pass). "Full" is measured against the page's own line height (2 lines plus the paragraph gap), not a fixed 60 px.
- e2e/matrix/delete.spec.ts waits 600 ms between its two deletions. prosemirror-history merges adjacent edits made less than 500 ms apart into one undo step, and on a quiet machine one Ctrl+Z undid both.

RESULTS (this lane's runs)
- Linux, in the CI image (tree snapshot of about 10:00 plus this lane's files; run-suite.mjs, CI=true, 3–4 workers, retries 0):
  - e2e/matrix + e2e/pagination + e2e/sections: 148 passed, 2 skipped, 2 failed. The failures are seams.spec Ctrl+Backspace/Delete, a pre-existing Linux difference; see the notes.
  - Serial phase: both fuzzes pass in both browsers (0 overflow, 0 text changes, 0 guard hits, 0 errors). The S2 30-page budget passed in Firefox (307/240/365 ms) and failed in Chromium (573/694/574 ms) while the container shared the loaded host.
  - API-backed specs through run-suite (flows, shell/auth, save/autosave-api, panels/metadata-api; migrations on a fresh postgres:18 database): 50 passed, 1 skipped, 1 failed (home.spec.ts "the welcome brew is editable and never saved", Firefox, a toBeAttached timeout).
  - Fidelity smoke plus report: 12/12 passed. merge-reports and the Release build of Homebrewery.slnx also ran.
  - The web job's steps on that snapshot: lint and typecheck failed only in other lanes' in-progress files (export, import-ui, a11y, perf, save); vitest 2518/2530 (12 failures in 5 files of those lanes); schema --check and build passed.
  - Final Linux run with every change (quiet machine): e2e/matrix + cut.spec + s2.spec: 71 passed, 1 skipped (the CDP IME test in Firefox). Serial phase: 6 passed, including the S2 30-page budget in Chromium (43/50/91 ms) and Firefox (226/200/356 ms) and both fuzzes in both browsers.
- Windows (host, isolated Vite, 5 workers, e2e/matrix + s2 + cut + measure + hbfmToDoc, both browsers): 112 passed, 1 skipped, 1 failed. The failure was cover.spec in Firefox (fixed since: cover.spec 12/12 and delete.spec 4/4 over --repeat-each).
  - Earlier runs on the overloaded host had Firefox teardown timeouts, and failures from the perf lane's mid-edit tree; see the notes.
- Fidelity (e2e/fixtures/fidelity-report.md, full documented run `--browsers chromium,firefox --variants keep,trailing-break`): Chromium 309/309 under 2%, Firefox 309/309, variables=keep 309/309, trailing-break proposal 309/309. 333 pages; median 0.00 %, 90th percentile 0.04 %, max 1.42 %.
  - Nine Firefox fixtures failed with harness errors (timeouts on the overloaded machine). They were run again with FIDELITY_FILTER on a quieter machine (all passed), their JSON results were copied into test-results/fidelity-runs/firefox, and the report was rebuilt with `--report-only`.
- Serial projects on the Windows host (quiet machine, one worker): 6/6 passed. Matrix fuzz: Chromium 1,000 edits in 24 s, Firefox in 48 s. S2 fuzz is clean in both. S2 30-page budget per edit (line/paragraph/delete): Chromium 54/58/61 ms, Firefox 200/148/172 ms. Under the 11-lane load, Firefox took 225 s for the fuzz and 20 min for the test (the teardown note), and Chromium's S2 delete took 516 ms once.

### Notes for later phases
- Sections / seam lane (P4.7, commands/continuation.ts): e2e/sections/seams.spec.ts "Ctrl+Backspace and Ctrl+Delete at the seam delete a word, as the browser does in one paragraph (PGR-7)" fails on Linux in both browsers, with and without the hanging-space fix, so CI will report it. At a seam "…year the |cellar", native Ctrl+Backspace in the unsplit paragraph leaves "year cellar"; the seam command leaves "year  cellar" (it keeps a space). Match the Linux word-delete behaviour, or make the expectation platform-aware.
- Perf lane:
  - The perf budgets are @serial. @serial tests run in chromium-serial/firefox-serial: last in a bare full run and in run-suite's last two sets. With a file or grep filter they run next to the other tests; use `--project=chromium-serial --project=firefox-serial --workers=1` to run them alone.
  - Around 13:30–14:10 the tree's in-progress content-visibility change (canvas.css, layout.ts, measure.ts) made measurePage return null for pages in Firefox on a fresh Vite: many pagination specs failed (texts had 2 pages instead of 3, `measuredColumns: null`). A Vite started at 14:15 no longer showed it.
- Save lane: on the Windows host under load, Firefox context teardown after an /edit test sometimes took minutes ("Tearing down context exceeded the test timeout"). The logs showed useAutosave's pagehide flush (gzipSync of the document, fflate) killed by Firefox's slow-script timeout, re-entering performSave via afterAttempt → runQueued. The matrix's page fixture now waits for autosave to rest before the page closes, which avoided it. Worth checking whether the pagehide flush can loop when the request fails immediately (context closing).
- App pages lane: e2e/flows/home.spec.ts "the welcome brew is editable and never saved" failed once in Linux Firefox in the CI image (toBeAttached at line 78); not investigated.
- Repo hygiene: add `.artifacts/` to .gitignore (CI builds the API with `--artifacts-path .artifacts`, relative to the repository root).
- The whole suite was not run twice at 6 workers by this lane (the integration step does it; the machine ran 11 lanes at once). Canonical command: `node e2e/matrix/run-suite.mjs` (needs `docker compose up -d db`); or `npx playwright test` (the serial projects then run after the parallel ones).
- The shared scratchpad directory is the same for every lane (one session id): a generic name like notes-section.md was overwritten by another lane. Use lane-prefixed names.
- Admin accounts for new API-backed specs: add them to run-suite.mjs's list (flows-admin@e2e.test, shell-admin@e2e.test) or pass HB_E2E_ADMIN_EMAILS.
- CI hardware: GitHub's ubuntu-latest has 4 vCPUs. The e2e jobs use 2 workers (E2E_WORKERS) × 4 shards per browser. If the S2/perf budgets fail there, look at the runner's load before loosening anything.
- No packages needed.



## Integration after phase 4 (routes, production CSP walk, migrations, docs, full runs)

### Interfaces
No new interfaces. Routes, navbar and editor wiring were already in place: /import, /user/:handle, /vault and /admin/* are the lanes' real pages (web/src/app/routes.tsx), the navbar links Vault (bar), Import (New panel) and the user page and Admin (Account panel), and EditorApp renders Export HTML after Print (editor, /new, /edit, /share) and the Snippets toggle in the Panels group (editable only).

Fixes in other lanes' files (all minimal):
- web/src/editor/canvas/EditorCanvas.tsx: `onReady` is called only for a live editor (`!editor.isDestroyed`). @tiptap/react's useEditor (immediatelyRender) schedules the destruction of a new editor 1 ms after rendering it and cancels that from its effect. When a concurrent render yields before its commit (a lazy route rendering in a transition), the timer fires first: the commit's editor is already destroyed and a new one follows in the next render. /dev/inspector's onReady read `editor.view.dom` and crashed on every load (all e2e/inspector specs failed); other onReady callbacks (EditorApp, the dev pages) could get the dead editor before the live one. Regression coverage: e2e/inspector (deterministic in Chromium without the guard).
- web/e2e/inspector/helpers.ts clickIn waits two animation frames after scrolling. Chromium skips offscreen pages (content-visibility: auto, the perf lane's offscreen.ts): a page just scrolled into view is hit-tested as an empty box until the next frame, so the click landed on the page and ProseMirror put the caret in a heading.
- Chromium test races on its late selectionchange (about 10 ms after Playwright's click or key press resolves; ProseMirror takes the caret from it): e2e/snippets/themeBlocks.spec.ts clickInto polls until the editor's selection is in the clicked text; e2e/a11y/keyboard.spec.ts polls the selection after Ctrl+End (trap test) and after Ctrl+Shift+ArrowLeft (walkthrough), and waits for the share-link toast before F8 (the toast list is mounted only while a toast shows). Not user-facing: nobody presses a key within 10 ms of a click.
- Forced colours in the lists lane's modules (web/src/ported/brewItem/BrewItem.module.css, web/src/ported/listPage/ListPage.module.css, web/src/pages/vault/VaultPage.module.css, web/src/pages/user/UserPage.module.css): the always-on transparent outlines showed as rings on every control and the box-shadow focus ring vanished, so the focused control could not be told apart (the a11y lane's finding 4, left open for these files). Only :focus-visible draws a 2px Highlight outline now. New test: e2e/a11y/layout.spec.ts "forced colours › list pages (user page, vault)" (fails in both browsers without the CSS).
- web/src/pages/import/ImportPage.tsx: the delayed (300 ms) session write is skipped once the brew is created. When the create came back within 300 ms of the last session change and the editor route was still loading (the import page still mounted), that write put the cleared session back, so the next /import restored the imported text. Found as an intermittent ImportPage.test.tsx failure; new test "a session write still pending when the brew is created does not bring the session back" (fails 3 of 3 without the fix).
- web/e2e/snippets-editor/snippetsEditor.spec.ts: the Insert-menu checks right after an edit poll. The panel reports to the page at most every SNIPPETS_REPORT_MS (120 ms), and Chromium opened the menu before that (deterministic in one run).
- web/e2e/security/csp.spec.ts: a walk step for the Snippets drawer and Export HTML (the export chunk, its probe iframe, inlined fonts and images, the download) in the editor and on the share page.
- Deleted: web/src/pages/HomePage.tsx (the original placeholder, imported by nothing) and an empty root TestResults/. .gitignore: `.artifacts/` (CI's dotnet --artifacts-path).
- Docs: README (shared/ row, host-only steps 2 and 3, the suite and CSP runners, the OpenAPI regeneration commands, a security-headers bullet), CLAUDE.md (suite and CSP runner lines, operations and security docs).

### Results
RESULTS_PLACEHOLDER

### Notes for later phases
NOTES_PLACEHOLDER

## PDF export: downloads and exports are PDF (issue #2)

Deviation from P6.4: the app no longer saves `.html` (editor "Export HTML") or `.json` (brew item "Download") files. Both give a PDF. `exportBrewHtml` stays: the HTML it builds is what the server renders. The plan's "Later: server-side PDF with Microsoft.Playwright for .NET" is done with that package.

### Interfaces
API (src/Homebrewery.Api/Pdf, Endpoints/ExportEndpoints.cs)
- `POST /api/export/pdf` (operationId ExportPdf, tag Export): body `PdfExportRequest { html }` (JSON; gzip allowed; 20 MB cap before and after decompression, `ExportEndpoints.MaxRequestBytes`). 200 `application/pdf`, `Cache-Control: no-store`, header `X-Pdf-Missing-Files` (`ExportEndpoints.MissingFilesHeader`: files the page asked for that are not in the PDF). 400 (`errors.html`) for empty html, 413, 429 (`RateLimits:Pdf`, per user, or per client address when signed out), 503 with `Retry-After: 5` when every render slot stays busy for `Pdf:QueueTimeout` ("PDF export is busy"), 503 without it when Chromium can't start ("PDF export is unavailable"), 500 "Couldn't make the PDF" (render failed or took longer than `Pdf:RenderTimeout`; the detail says which). No account needed (`.AllowAnonymous()`): it stores nothing, so EndpointAuditTests lists it in `AnonymousWrites` and checks that it is rate limited. SameOriginWriteGuard still applies.
- `IPdfRenderer.RenderAsync(html, ct) → PdfRenderResult(byte[] Pdf, int RemoteFiles, int MissingFiles)`; throws `PdfRendererBusyException`, `PdfRendererUnavailableException`, `PdfRenderFailedException`. `PdfRenderer` (singleton, IAsyncDisposable): one Chromium (Microsoft.Playwright 1.63, headless shell), started on the first render and again after a crash; a fresh context per render with JavaScript off, service workers blocked, downloads off. The HTML is served as `PdfRenderer.DocumentUrl` (https://export.homebrewery.invalid/) through the route handler, once, to the main frame. The route handler passes GET requests for https `image`, `font` and `stylesheet` resources of other hosts to `IRemoteFileFetcher` (fulfilled with `access-control-allow-origin: *`, since fonts need CORS) and aborts everything else, including the document's own host. Launch flags make Chromium's own network dead: `--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback> --host-resolver-rules=MAP * ~NOTFOUND`, plus `--disable-dev-shm-usage`. After `load` it waits for `document.fonts.ready` (evaluate works with JavaScript off), then `PdfAsync { PreferCSSPageSize, PrintBackground, Tagged, Outline }`.
- `IRemoteFileFetcher.FetchAsync(uri, userAgent, budget, ct) → RemoteFile(byte[] Body, string? ContentType)?` (`RemoteFileFetcher`, named HttpClient `pdf-remote-files`): https only; `SocketsHttpHandler.ConnectCallback = RemoteFileFetcher.ConnectToPublicAddressAsync`, which resolves the host and connects only to addresses that `PublicAddress.IsPublic` accepts, on every connection, redirects included (at most 3; SocketsHttpHandler never follows https to http, so that redirect comes back as a 3xx and is left out). No proxy, no cookies, decompression on (the cap counts decompressed bytes). Chromium's user agent is forwarded, because Google Fonts answers by browser. Null for non-2xx, over `MaxRemoteFileBytes`, over what the render's `RemoteByteBudget` has left, over `RemoteFileTimeout`, or connection failures (logged at Information with the host). `RemoteByteBudget` (one per render, `MaxRemoteBytes`, shared by its concurrent fetches) is taken chunk by chunk as a file arrives, so parallel fetches never hold more than the budget between them; a file that is left out gives its bytes back.
- `PublicAddress.IsPublic(IPAddress)`: IPv4 minus RFC 6890 special ranges, multicast and reserved; IPv6 only 2000::/3 minus documentation, 2001::/23 (Teredo) and 6to4 of a non-public IPv4. IPv4-mapped addresses are judged by their IPv4 address.
- `PdfOptions` (section `Pdf`): MaxConcurrentRenders 2, QueueTimeout 10 s, RenderTimeout 60 s (includes the browser launch and remote files), MaxRemoteFiles 100, MaxRemoteFileBytes 10 MB, MaxRemoteBytes 50 MB, RemoteFileTimeout 10 s. Validated at startup. `PdfSetup.AddPdfExport()` registers all of it. `RateLimits:Pdf` defaults to 10/min per user (Development 100).

WEB
- `renderPdf(html, { client?, signal? }) → { pdf: Blob, missingFiles }` (web/src/api/exportPdf.ts; `PDF_MISSING_FILES_HEADER`). The JSON body is gzipped from 8 KB (jsonBodyOptions).
- `exportBrewPdf(source, options) → PdfExportResult { pdf, filename ('<title>.pdf'), report (the HTML export's), missingFiles }` and `exportStoredBrewPdf(brew: BrewForEdit, { title?, signal?, loadChain?, render? })` (migrateDoc, loadThemeChain(meta.theme), style, lang) in web/src/editor/export/exportPdf.ts. `exportFileName(title, 'html' | 'pdf')`.
- `downloadFile(blob, filename)` replaces downloadHtml. `exportSummary(result, formatBytes)`: toast "Downloaded “<file>”", "N pages, size.", plus "K images, fonts or stylesheets couldn't be included." (warning) with K = max(missingFiles, report.failed.length). `exportFailure(error)`: "Couldn't make the PDF", with messages for 413 and 429, else the problem detail. `EXPORT_TOAST_ID` is 'editor-export-pdf'.
- `DownloadPdfButton({ editor, chain, userCss, lang, title, exportBrew?, download? })` replaces ExportHtmlButton: label "Download PDF", data-testid `download-pdf`, the same place (EditorAppBar exportAction, after Print) on /, /new, /edit and /share. It works signed in or not.
- Brew items (user page): the action is labelled "PDF", accessible name "Download <title> as PDF". useBrewActions fetches the brew for edit, loads '@/editor/export' on first use, runs exportStoredBrewPdf with the list's display title, then downloads and toasts as the editor does (`errorPolicy: 'manual'`). Removed: brewFile, BREW_FILE_FORMAT/VERSION, fileNameFor, saveTextFile.
- /dev/export renders DownloadPdfButton; `window.__hbExport.exportHtml` still returns the HTML export for the export specs.

CONTAINERS
- Dockerfile stages: restore → playwright (copies the pinned package's Node driver for this architecture and its CLI to /playwright) → api (publish) → dev-api (SDK + Chromium, for docker-compose.yml's `api` service) → runtime (aspnet + `cli.js install --with-deps --only-shell chromium` before the app files, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`). The browser layer changes only when Directory.Packages.props' Microsoft.Playwright version changes.
- docker-compose.yml `api` builds the `dev-api` target (image `homebrewery-dev-api:local`). After a Microsoft.Playwright upgrade: `docker compose build api`.
- Host runs (dotnet run, dotnet test, the e2e lanes' private APIs) use the Playwright browser cache (%LOCALAPPDATA%\ms-playwright, ~/.cache/ms-playwright). web's @playwright/test 1.63 installs the same Chromium build (revision 1243), so `npx playwright install chromium` in web/ is enough.

TESTS
- tests/Homebrewery.Api.Tests/Pdf: PdfRendererTests (real Chromium, about 6 s for the class: sheets and MediaBox from @page, outline, JavaScript off, other sites' image and font through the fetcher with the font embedded, nothing reaching a local listener on its own (preconnect, dns-prefetch, stylesheet, image, iframe, video, @import, background, the document host), busy and timeout then recovery), PdfExportEndpointTests (fake renderer: 200 with headers, gzip, anonymous 200, another Origin 403, 400, 413 via gzip bomb, 503 busy with Retry-After, 503 unavailable, 500), RemoteFileFetcherTests (the real client never connects to 127.0.0.1, localhost, ::1 or ::ffff:127.0.0.1; https only; size cap with and without Content-Length; timeout; user agent), PublicAddressTests. RateLimitTests covers the Pdf policy per user and, signed out, per client address. EndpointAuditTests checks the anonymous-write list. PdfFile.cs reads just enough PDF (pages, MediaBoxes, images, font names, outline).
- Vitest: api/exportPdf.test.ts, editor/export/exportPdf.test.ts, DownloadPdfButton.test.tsx (disabled until ready, busy, download and toast, no account needed, error toast, cancel on unmount, summary and failure wording), download.test.ts, userPage.test.tsx (download via a mocked '@/editor/export'), BrewItem.test.tsx.
- Playwright: e2e/export/app.spec.ts stubs POST /api/export/pdf with `stubPdfEndpoint(page, browser)` (helpers.ts: it renders the posted HTML with the test's Chromium, JavaScript off and offline, as the server does): share page download by a signed-out reader (file name, toast, no sign-in prompt, one Letter sheet per page, the posted HTML has no script and its page 1 matches the share page), and the home page signed in (keyboard path and axe). e2e/lists/user.spec.ts "Download gives the stored brew as a PDF" uses the lane's real API, so the server's Chromium renders it (2 pages). e2e/security/csp.spec.ts walks Download PDF in the editor and on the share page under the production CSP.

### Notes for later phases
- The PDF is rendered from the browser's HTML export, so it matches what the reader sees (unsaved edits included). A server-only path (for example a `GET /api/brews/{shareId}/pdf` link) would need the export pipeline on the server; it is not built.
- Chromium runs without its own sandbox (Playwright's default, which Docker needs without a seccomp profile). JavaScript is off and the network is closed, which removes most of the attack surface; see security.md R-9.
- Image size: the runtime image grows by about 750 MB: 608 MB for the headless shell with its system libraries and fonts, and about 140 MB for Playwright's Node driver in the app folder (`.playwright/node/linux-*`, which `Playwright.CreateAsync` starts). The Dockerfile bind-mounts the CLI for the install step (a copied file would stay in its layer) and makes the published driver executable for the app user (it comes out of the package as 744, owned by root).
- Measured in the production image: the first PDF about 1.9 s (Chromium start included), then 0.3–0.7 s for the 3-page inn export, 2.5 s for the 4-page chrome export (24 MB of images). The container used about 280 MB after its first PDFs.

## Local brews: anonymous brews in the browser, uploaded later (issue #4)

Access model (the user's): sign-in is needed only to save brews to the cloud, to publish, and to share a private brew. The share link needs a brew in the cloud; anyone with the link can open it, as before. Anyone can create brews in the browser, keep any number of them, download them as PDF, and upload them to an account later. Nothing is uploaded without the user choosing it.

Deviation from P7.2: a signed-out /new no longer keeps its brew in the 'new' draft to save it at sign-in. The signInHandoff.ts module and its "Sign in to save" notice are gone.

### Interfaces
LIBRARY (web/src/editor/local/localBrews.ts; small: the navbar, the prompt and the import page import it)
- IndexedDB `hb-local-brews` (store `brews`: id → `LocalBrew { v: 1, id, createdAt, updatedAt, docSchemaVersion, doc, style, snippets, meta: LocalBrewMeta { title, description, tags, lang, theme }, sourceMarkdown? }`) and `hb-local-brew-index` (store `summaries`: id → `LocalBrewSummary { id, title, theme, pages, createdAt, updatedAt }`). localStorage was not used: it holds about 5 MB per site. Each store is a `fallbackStore` (memory when IndexedDB fails: `persistent()` false).
- `LocalBrewLibrary { list() (newest first; reads summaries; repairs the index from the brews' keys: missing summaries rebuilt, orphans dropped), count() (keys only), get(id) (null when missing or malformed: isLocalBrew), save(brew), remove(id), persistent() }`. `defaultLocalBrews()` (memory only without IndexedDB, as in jsdom), `setDefaultLocalBrews(lib | null)` for tests, `createLocalBrewLibrary(brews, index)`.
- `onLocalBrewsChanged(listener)` (in-tab; save and remove). `newLocalBrewId()` (16 [A-Za-z0-9]), `LOCAL_BREW_ID` (/^[\w-]{1,64}$/), `localMeta(partial)` (defaults: lang 'en', theme '5ePHB'), `countPages(doc)`, `summaryOf(brew)`.
- `requestPersistentStorage(storage?)`: `navigator.storage.persist()` once per storage object, after the first brew is stored. It resolves true, false, or null when the API is missing.
- `migrateAnonymousNewDraft(drafts, lib?)`: the 'new' draft with no ownerId and no createKey (the anonymous /new brew of earlier versions) becomes local brew `draft-<updatedAt base36>` (so two tabs write one brew) and the draft is deleted. /new (both states) and /local run it.
- `KeyValueStore.keys()` is new (idb-keyval `keys`; fallbackStore merges both stores; memoryStore).

SAVING (EditorApp saving 'local'; web/src/editor/local/useLocalSave.ts)
- `EditorAppSaving = 'server' | 'local' | 'none'`. `EditorApp` prop `local: EditorAppLocalBrew { id (null for a new brew), createdAt?, updatedAt?, sourceMarkdown?, onCreated?(id), onUpload?(id) }`. `appBrewForLocal(brew?)` in editorAppModel.ts.
- `useLocalSave({ editor, enabled, localId, createdAt?, sourceMarkdown?, lastSavedAt?, getContent: () => { style, snippets, meta }, watch, onCreated?, library?, delayMs = 1000 })` returns `{ status: 'idle'|'dirty'|'saving'|'saved'|'error', localId, lastSavedAt, error, persistent, saveNow(), stop(), resume() }`.
  - What is dirty: author transactions (dirty.ts `isDirtyDispatch`) and changes of the watched values (EditorApp watches style, snippets and the metadata draft's title, description, tags, lang and theme).
  - When it writes: 1 s after the last change, on Mod-S, on pagehide or visibilitychange → hidden, and on unmount (with the editor's last state if it is already destroyed). One write at a time.
  - `settleNow` runs before each write, so stored pages match the editor. The PDF of a listed brew is made from them.
  - A new brew gets its id on its first write; then `requestPersistentStorage()` and `onCreated(id)` run.
- `LocalSaveStatus` (toolbar, data-testid `save-status`; wording in `localStatus.ts` `localStatusInfo`): "Not saved yet", "Unsaved changes", "Saving…", "Saved on this device", "Couldn’t save" + Retry, "Not kept" (warning) when `persistent` is false. Actions: "Upload" (`local-upload`) when signed in and stored, "Sign in to upload" (`local-sign-in`) when signed out.
- Upload from the editor (EditorApp `uploadLocal`): `saveNow()`, then `stop()` and `editor.setEditable(false)`, then `local.onUpload(id)`. If that throws, `resume()` and editable again.
- The Properties dialog opens for local brews too: `MetadataDialog`/`MetadataEditor` prop `local` hides Authors, Published and Delete, and shows a note (`meta-local-note`). The dialog description is "Changes are saved on this device."

PAGES AND ROUTES
- `paths.local` ('/local'), `paths.localBrew(id)`. The editor layout route has a new child `local/:localId`. `editorSessionKey(sessions, editId, locationKey, localId?)` keys it `local:<id>` (`localSessionId(id)`). A signed-out /new brew adopts that key when its first write stores it, so the move to /local/:localId keeps the editor mounted. BrewSession picks LocalBrewSession, NewBrewSession or EditBrewSession from the URL it mounted with.
- `LocalBrewSession` (/local/:localId): loads the brew. If it is missing: `local-brew-missing` page. If its schema version is newer: NewerVersionPage.
- `LocalBrewEditor({ brew, onStored? })`: EditorApp in 'local' mode.
  - `onUpload` calls `uploadLocalBrew`, seeds the cloud brew's query (`seedCreatedBrew`), shows the toast "Uploaded to your account" and goes to /edit/:editId (replace).
  - A 401 opens the sign-in prompt; other errors toast "Couldn’t upload the brew", and the brew stays.
  - Signed out, a dismissible (per tab, sessionStorage `hb-local-notice-dismissed`) `local-notice` explains where the brew is kept, with Sign in (`local-notice-sign-in`), Create an account and a link to /local.
- NewBrewSession (/new):
  - Every visit runs the migration first.
  - Signed out: a migrated draft is opened at /local/:id. Otherwise `LocalBrewEditor brew={null}`.
  - Signing in before anything is typed reloads the page as a signed-in /new. Once the author has typed (EditorAppLocalBrew `onEdited`, from the local save leaving 'idle'), the page stays local even if the first write hasn't landed yet (review fix).
  - Signed in: as before (the 'new' draft, SAVE-8, SAVE-12), except a loaded draft is always saved on its next edit (`saveOnLoad` is gone). A migrated draft gets an info toast with "Open".
- /local, "Brews on this device" (web/src/pages/local/index.tsx, `local-brews-page`):
  - The list: `local-brew-item` rows (data-local-id) with a title link, "N pages · edited <relative>", PDF (exportStoredBrewPdf from the stored brew), Upload (signed in; `local-brew-upload`) and Delete (confirm; `local-brew-delete`).
  - "Upload all to my account" (`local-upload-all`), the empty state (`local-empty`), the not-kept warning (`local-not-kept`), and a sign-in hint when signed out (`local-page-sign-in`).
  - It refreshes on library changes, window focus and visibility.
- `LocalBrewsSignInPrompt` (in AppShell): `me` going from null to a user in this tab, with local brews present, opens the dialog "You have N brews on this device" (`local-brews-prompt`). Its buttons are Later, Review (/local) and Upload all (`uploadLocalBrews`, then a summary toast). If the library can't be read, a toast says so and the dialog stays open. A page loaded while already signed in is not asked.
- Import page: signed out, "Create brew on this device" saves a local brew (doc, style, snippets, cleaned metadata, sourceMarkdown) and opens /local/:id. The upstream-link download still needs sign-in.
- Navbar New panel: "Brews on this device" (`nav-local-brews`). User page (own list): `user-local-brews` note "N brews are only on this device" with a link.
- `exportStoredBrewPdf(brew: StoredBrew)`: `StoredBrew` is `{ doc, docSchemaVersion, style, meta: { title, lang, theme } }`, so both BrewForEdit and LocalBrew fit.

UPLOAD (web/src/editor/local/upload.ts)
- `uploadRequest(brew)`: POST /api/brews body with doc, docSchemaVersion, style, snippets, meta (published: false), and sourceMarkdown when present.
- `uploadKey(brew)` is `local-brew-<id>-<updatedAt base36>`. A retry of the same content gets the brew the first request created (SAVE-8 idempotency). An edit since then gets a new key, because the API answers 422 to a reused key with another body.
- `uploadLocalBrew(id, { library?, client?, signal? })` removes the local copy after the create. An editor that has the brew open in this tab (`registerActiveLocalEditor` in activeEditors.ts; EditorApp registers a stored local brew) gets `prepareUpload()` first: it stores pending changes, stops writing and turns read-only. Resolving false aborts the upload. Afterwards the editor gets `uploaded(created)` (EditorAppLocalBrew `onUploaded`: LocalBrewEditor opens /edit/:editId) or `uploadFailed()` (writes and edits again). This covers the editor's Upload, the sign-in prompt's Upload all and /local (review fix: Upload all over an open editor with unsaved changes). Other tabs are not coordinated. `uploadLocalBrews(ids, options)` uploads one at a time and returns `{ uploaded, failed }`. `uploadProblem(error)` gives the message.
- Icons: `upload`, `device` (ui/iconPaths.ts).

TESTS
- Vitest:
  - localBrews.test.ts: library, index repair, listeners, ids, meta, persist request, migration.
  - upload.test.ts: body, key, removal, failure keeps the brew, partial "upload all".
  - localStatus.test.ts.
  - editorSession.test.ts: local keys.
  - pages/local/localPage.test.tsx: list order, signed-out hint, empty state, delete, upload one and all with a failure.
  - MetadataDialog.test.tsx: local mode.
  - appRoutes.test.tsx, the whole app:
    - signed-out /new stores a local brew with the same editor, the URL moves, nothing is POSTed, sign-in shows the prompt, and "Upload all" creates the brew;
    - signing in before typing gives a signed-in /new;
    - the earlier anonymous draft is migrated and opened at /local/:id, not uploaded.
  - ImportPage.test.tsx: signed-out create makes a local brew.
- Playwright:
  - e2e/flows/pages.spec.ts, real API and IndexedDB:
    - a signed-out brew survives a reload at /local/:localId, is listed, and downloads as a 1-page PDF rendered by the API;
    - two signed-out brews, then signing in through the navbar: the prompt, nothing uploaded until "Upload all", then both in the account and /local empty;
    - the editor's Upload opens /edit/:editId, and the old /local URL says the brew is gone;
    - signed in, "Start over" discards a draft whose POST was aborted.
  - e2e/save/recovery.spec.ts: IndexedDB blocked; the signed-out brew is kept in memory across in-app navigation, and the status says "Not kept".
  - e2e/save/idempotent-create.spec.ts: `local-notice`.
  - e2e/a11y/axe.spec.ts: /local signed out and signed in, and the sign-in dialog opened from `local-notice-sign-in`.
  - e2e/security/csp.spec.ts: /new stores a local brew and /local lists it under the production CSP.

### Notes for later phases
- Local brews are per browser profile: no sync between devices. Two tabs on the same local brew: the last write wins (no conflict detection).
- The editor keeps no local history snapshots for local brews (LocalHistoryDialog is for cloud brews).
- Upstream-link import stays sign-in only (plan §8.3); opening it to anonymous users would need the proxy's rate limit per client address.
- Recent brews (navbar) don't list local brews; /local does.
