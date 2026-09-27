# Security

P8.3 of the plan: a security review against plan §14 ("Upstream behaviour to drop") and the whole app, and the
Content-Security-Policy and other security headers. Review date: 2026-09-26.

How to check everything below again:

- API: `dotnet test --project tests/Homebrewery.Api.Tests -- --filter-namespace Homebrewery.Api.Tests.Security`
  (headers, CSRF guard, cookies, rate limits, error bodies, the §14 endpoint audit, sanitizer/CSP alignment).
- Browser: `node e2e/security/run-csp.mjs` from `web/` (needs `docker compose up -d db`). It builds the SPA into a
  temporary directory, starts the API in the Production environment on :5477 serving that build, and walks every
  page in Chromium with the enforced policy, failing on any CSP violation. CI runs it in the `csp` job.
- Dependencies: `npm --prefix web audit --omit=dev` and
  `dotnet list Homebrewery.slnx package --vulnerable --include-transitive`.

## Threat model (summary)

What is protected:

- Accounts and sessions. The session is an HttpOnly cookie; the SPA never holds a token.
- Brews. A brew is private until it is published. Only its authors can edit it; only the owner can change the
  author list; only admins can lock it.
- Admin functions: locks, notifications, user and brew lookups.
- The origin itself. Script running on the site can act as the signed-in user, so XSS is the main risk.

Who attacks, and how:

| Actor | Main vectors |
| --- | --- |
| An author of a malicious brew | Brew content that other people view: document JSON (attributes, links, images), raw HTML, user CSS, user themes, metadata in link previews. Targets: viewers of the share page, the vault and co-authors. |
| Another website | CSRF against the API, clickjacking (framing the editor), reading API responses cross-origin. |
| An anonymous client | Brute force and enumeration on the auth endpoints, abuse of the import proxy, large or deeply nested requests. |
| Anyone sending HTML to the PDF renderer (no account needed) | Server-side request forgery (the server's network, cloud metadata), attacks on the headless browser, resource exhaustion. See [PDF export](#pdf-export). |
| A signed-in non-admin | Mass assignment (setting `lock`, `authors`, `published` through a save), admin endpoints, other people's brews. |
| The network | Session theft over plain HTTP. |

The layers, from outside in:

1. Headers (this task): CSP, HSTS, frame and sniffing protection (see [Headers](#headers)).
2. Requests: SameOriginWriteGuard (CSRF), rate limits, body size caps, JSON depth limits.
3. Endpoints: authorization on every route (the endpoint audit test walks the route table), a whitelist of save
   fields, validated metadata.
4. Content: `DocInspector` (schema, attributes, URL and CSS policies) and `RawHtmlSanitizer` (Ganss.Xss) on the
   server; DOMPurify and the same URL/CSS policies on the client; user CSS scoped to the canvas through the CSSOM.
5. Rendering: React (escaped text), the share shell HTML-encodes every value, TOC HTML is escaped, and imported HTML is
   parsed only in inert documents and script-less sandboxed iframes.

## Headers

`src/Homebrewery.Api/Infrastructure/SecurityHeaders.cs` adds them to every response of the API host (the SPA, its
static files, the share shell, the API, error and rate-limit responses). The middleware runs first in the pipeline
and writes the headers when the response starts. A header that an endpoint set itself is kept.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` (pages) | See [the page policy](#the-page-policy) | Scripts only from this origin: no inline script, no event handler attributes, no eval. |
| `Content-Security-Policy` (`/api`, `/openapi`, `/healthz`) | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | JSON is never a page. |
| `X-Content-Type-Options` | `nosniff` | No MIME sniffing (for example user text served as script). |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Edit URLs (`/edit/{editId}`) never leak to other sites through the Referer. |
| `Permissions-Policy` | camera, microphone, geolocation, payment, USB, … all `()` | The app uses none of them. The list names only features that Chromium knows, because unknown names are console errors. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Pages opened from a brew link cannot reach `window.opener`. |
| `X-Frame-Options` | `DENY` | The same as `frame-ancestors 'none'`, for older browsers. |
| `Cross-Origin-Resource-Policy` (API only) | `same-origin` | Other sites cannot embed API responses (Spectre-style reads). |
| `Cache-Control` (API only, when the endpoint set none) | `no-store` | Private brews, account and admin data are not kept in shared or browser caches. |
| `Strict-Transport-Security` | `max-age=31536000` | Only on HTTPS responses (behind the proxy: `X-Forwarded-Proto`) and never for loopback hosts. |
| `Server` | (removed) | Kestrel's `Server: Kestrel` header is off (`KestrelServerOptions.AddServerHeader`). |

### The page policy

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https:;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

On HTTPS the policy also has `upgrade-insecure-requests`. `SecurityHeaders:CspReportUri` adds `report-uri`.

- `script-src 'self'`. The production `index.html` loads only module files, and the share shell injects only
  `<meta>` tags and the `<title>`. `SecurityHeadersTests` parses both with a real HTML parser. The production bundle
  has no `eval` and no `new Function` (checked on the build; the theme snippet generators that need them are shimmed
  by `vite/themeSnippetShims.ts`). Script-created iframes (the import and export layout probes) are `about:blank`
  documents that inherit this policy, and they are sandboxed without `allow-scripts`.
- `style-src 'self' 'unsafe-inline'`. This is needed. A test run with `'unsafe-inline'` removed (Chromium, the
  editor and the import page) was blocked for all of these:
  - TipTap injects `<style data-tiptap-style>`, and CodeMirror's style-mod adds a `<style>` element where it cannot
    use constructed sheets.
  - ProseMirror renders a node's `style` attribute with `setAttribute('style', …)`. Brew documents have per-node
    styles, the page-object layer uses them (`ObjectLayer.ts`), and so do marks (`marks.ts`).
  - The import layout probe writes `<style>` elements into its iframe (`canvas/probe.ts`), and the export probe
    writes a whole HTML document with `<style>` into its iframe (`export/probe.ts`).
  - Raw HTML blocks keep their `style` attributes.

  Nonces would need a server-rendered `index.html` for every request, and hashes cannot cover style attributes.

  React's `style` prop and CSSOM calls (`el.style.x = …`, constructed stylesheets) are not restricted by CSP. Brew,
  theme and user-theme CSS goes into constructed stylesheets (`document.adoptedStyleSheets`, `cssScope.ts`), so the
  brew CSS itself needs no exception. Arbitrary brew CSS is a feature, so an inline-style ban would protect little.
  Script execution is what the policy must stop, and it does.
- `img-src 'self' https: data: blob:` and `font-src 'self' https: data:`. Brews use images and web fonts from any
  https host. `data:` covers inline images in raw HTML and the imported HBFM, and `blob:` covers local previews.
  Plain `http:` is not allowed. On an HTTPS site, `upgrade-insecure-requests` (and the browsers' mixed-content
  auto-upgrade) turns old `http://` image links into `https://`.
- `connect-src 'self' https:`. A constructed stylesheet cannot follow `@import`, so `cssScope.inlineCssImports`
  fetches the imported CSS itself (typically Google Fonts, with `credentials: 'omit'`), and then scopes it.
  Alternatives considered:
  - A server-side CSS proxy would allow `connect-src 'self'`, but it would add an SSRF surface.
  - Dropping `@import` support would break many existing brews.

  The cost: script that already runs on the page could send data to any https host with `fetch`. But such a script
  would first have to get past `script-src 'self'`, and `img-src https:` already allows the same kind of leak through
  image URLs. So a narrower `connect-src` would buy little.
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'none'` stop plugins, `<base>`
  hijacking, form posts to other sites, and framing. The sanitizers also remove `<object>`, `<embed>`, `<base>`,
  `<form>` and form controls, so stored content never asks for them (`ContentPolicyAlignmentTests`).
- No `worker-src`/`frame-src` exceptions. The app uses no workers and frames only `about:blank`. A feature that adds a
  `blob:` worker or a real iframe must extend the policy in `SecurityHeaders.DocumentPolicy` and its tests.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `SecurityHeaders:Csp` | `Enforce`, or `Off` in Development | `Enforce`, `ReportOnly` (sends `Content-Security-Policy-Report-Only`) or `Off`. Development is off because pages come from the Vite dev server: its React refresh preamble is an inline script, and the dev share shell embeds Vite's `index.html`. |
| `SecurityHeaders:CspReportUri` | none | An absolute https URL or a site path that receives violation reports. It is validated at startup: no spaces, quotes, `;` or `,`, so it cannot add directives. The API has no report endpoint of its own. |
| `SecurityHeaders:HstsMaxAge` | 365 days | The HSTS `max-age`. |
| `SecurityHeaders:HstsIncludeSubDomains` | false | Set it only when every subdomain serves HTTPS. `preload` is never sent. |

The dev stack's Caddy (`deploy/caddy/Caddyfile`) adds no headers. In production-image mode every response already
comes from the app with its headers, and in dev mode the pages come from Vite without a policy.

## PDF export

`POST /api/export/pdf` (issue #2) renders HTML that the client sends, so the HTML is untrusted input to a browser that
runs on the server (`src/Homebrewery.Api/Pdf/PdfRenderer.cs`).

- Access: anyone, signed in or not. Share pages are read without an account, and their readers download PDFs. The
  endpoint is POST only to carry the HTML and stores nothing, so it is one of `EndpointAuditTests.AnonymousWrites`
  (which also checks that it is rate limited). SameOriginWriteGuard still requires the site's Origin, so other sites
  cannot use a visitor's browser to call it, and the response is not readable cross-origin.
- Limits: `RateLimits:Pdf` per user, or per client address when signed out (behind a proxy this needs correct
  forwarded headers, R-3), the global write limit per client address, at most `Pdf:MaxConcurrentRenders` renders at
  once (others wait `Pdf:QueueTimeout`, then 503), `Pdf:RenderTimeout` per render, and a 20 MB body cap after
  decompression. Many addresses together can still keep the render slots busy for everyone (R-11).
- No scripts: each render has a fresh browser context with JavaScript disabled (and service workers blocked). The
  exported HTML also carries a CSP without scripts, and the client strips active content, but the server does not
  rely on that.
- No network of its own: the HTML is served from a route handler as `https://export.homebrewery.invalid/`. Every
  request goes through that handler, which aborts everything except GET requests for https images, fonts and
  stylesheets of other hosts. Chromium is launched with a discard proxy for every host, loopback included, and a
  host resolver that resolves nothing, so requests that bypass the handler (preconnect, DNS prefetch) go nowhere.
  `PdfRendererTests.No_request_reaches_the_network_on_its_own` checks this with a local listener.
- SSRF guard: the allowed files are fetched by the API, not by Chromium (`RemoteFileFetcher`). Its client connects
  only to addresses that `PublicAddress.IsPublic` accepts. That excludes loopback, private, link-local (cloud
  metadata), CGNAT, documentation, benchmark, multicast and reserved ranges, NAT64, Teredo, and 6to4 or
  IPv4-mapped forms of those. The check runs in `ConnectCallback`, after DNS resolution, for every connection,
  redirects included. So a DNS answer that changes between check and connect (rebinding) cannot reach a
  private address. Other rules: https only, no proxy, no cookies, at most 3 redirects, and size, count and time
  caps per file and per render. Tests: `RemoteFileFetcherTests`, `PublicAddressTests`.

## Plan §14 review

| # | Upstream behaviour | Status | Proof |
| --- | --- | --- | --- |
| 1 | `/admin/compress/:id` and `/admin/clean/script/:id` have no admin check | Not repeated. Every `/api/admin` route needs the Admin role. There are no compress/clean endpoints. | `Security/EndpointAuditTests.Every_admin_route_requires_the_admin_role` walks the route table, so routes added later are covered too. `Admin/AdminApiTests` checks 401/403. |
| 2 | Saves copy every client field onto the brew (`_.assign`) | Not repeated. Create and save bind typed records, and `BrewRules` applies a whitelist. `lock`, `views`, ids and versions cannot be set. Only the owner changes `authors`. | `Brews/BrewSaveTests.Fields_outside_the_whitelist_are_ignored`, `Only_the_owner_changes_authors`, `Brews/BrewAuthorizationMatrixTests`, `EndpointAuditTests.Every_write_outside_the_identity_endpoints_requires_a_signed_in_user`. |
| 3 | og meta values and page props written into HTML unescaped | Not repeated. `ShareShell` HTML-encodes every value and injects no page props or scripts. | `Share/ShareShellTests`; `Security/SecurityHeadersTests.A_brews_share_shell_gets_the_document_policy_and_no_inline_script` (a `</script><script>` title and an `onload=` description stay text in attribute values; the parsed page has no inline code). |
| 4 | The whole session, including OAuth tokens, is sent to the browser, and the cookie is not HttpOnly | Not repeated. The cookie sign-in returns an empty body. The cookie is HttpOnly and SameSite=Lax, and Secure over HTTPS (also behind the proxy). `/api/account/me` returns only id, email, handle and roles. | `Security/EndpointAuditTests.Cookie_sign_in_gives_scripts_no_token`, `Security/AuthCookieTests`. |
| 5 | Admin credentials default to admin / password3 | Not repeated. There are no built-in accounts. Admins come from `Admin:Emails` (empty by default), and outside Development they must have a confirmed email. | `Security/EndpointAuditTests.A_fresh_install_has_no_admin_account_and_no_default_password` (fresh database: no users, no admins; `admin`/`password3` gets 401 for both login and Basic auth). |
| 6 | Google Drive brews shared with anyone as writer | Not applicable. There is no Google Drive storage (nothing in `src/` mentions Drive or Google). | `grep -ri "google\|drive" src --include=*.cs` finds nothing. |
| 7 | `/stream` broadcasts every save to every listener and never removes listeners | Not repeated. There is no streaming endpoint. | `Security/EndpointAuditTests.There_is_no_broadcast_stream` (no route containing "stream" and no `text/event-stream` response). |
| 8 | View counts read, modified and saved | Not repeated. One `UPDATE … SET views = views + 1` (`ExecuteUpdateAsync` in `BrewService.GetForShareAsync`). | `Brews/BrewEndpointTests.Views_increment_atomically_under_concurrency`. |
| 9 | Theme inheritance has no cycle detection | Not repeated. The bundle walk keeps a visited set and answers a cycle with 422. Chains are limited to 8 levels. | `Themes/ThemeEndpointTests.User_themes_that_reference_each_other_are_a_cycle_422`, `A_theme_that_is_its_own_parent_is_a_cycle_422`. |
| 10 | safeHTML is a blacklist | Not repeated. The server uses `RawHtmlSanitizer` (Ganss.Xss allow-list: no scripts, handlers, frames, forms or form controls; only http, https and mailto URLs). The client uses DOMPurify for raw HTML and imports. The CSP is the last line of defence. | `Documents/RawHtmlSanitizerTests`, `Security/ContentPolicyAlignmentTests`, `web/src/editor/schema/html.test.ts`, `web/src/editor/import/sanitize.test.ts`. |

## Fresh review

| ID | Area | Finding | Status |
| --- | --- | --- | --- |
| SR-1 | Headers | There was no CSP, HSTS, framing, sniffing or referrer protection. | Fixed: `SecurityHeaders` (above). `SecurityHeadersTests` covers pages, the share shell, the API, errors, 429s, HTTPS and HSTS, the proxy, the configuration, and startup validation. `e2e/security/csp.spec.ts` covers the production walk. |
| SR-2 | Information leak | Kestrel sent `Server: Kestrel`. | Fixed: `AddServerHeader = false` (`SecurityHeadersTests.Kestrel_sends_no_server_header`). |
| SR-3 | Authorization | Every write outside `/api/auth` requires a signed-in user, and every admin route the Admin role. Brew reads follow `AccessPolicy` (edit view for authors only; share view for anyone, blocked by a lock). | OK: `EndpointAuditTests`, `AccessPolicyTests`, `Brews/BrewAuthorizationMatrixTests`. |
| SR-4 | Input validation | Body cap 20 MB on the wire and after decompression, JSON depth limit, document limits (size, depth, node count, style length), a URL policy for `href` and `src`, a CSS policy (no `expression()`, `javascript:`, `behavior`, `-moz-binding`), metadata limits (title 100, description 500, tags 50×100, thumbnail an absolute http(s) URL of at most 256 characters), handle rules. | OK: `Documents/*`, `Brews/*`, `ProblemDetailsTests`. |
| SR-5 | SSRF | The only server-side fetches of outside content are the import proxy and, in Development only, the Vite `index.html`. The import proxy has a fixed host, a share id matching `^[A-Za-z0-9_-]{10,14}$`, no redirects, no cookies, a 2 MB cap and a 20 s timeout. Thumbnails and images are never fetched by the server. | OK: `Import/*` tests. |
| SR-6 | XSS: share view and editor | The document renders through ProseMirror from a validated schema: no unknown nodes, attributes allow-listed (no `on*`, `style`/`class`/`id` smuggling), link and image URLs policy-checked on both ends. TOC HTML is escaped (`toc/renderToc.ts`). | OK. The CSP blocks what gets through. |
| SR-7 | XSS: raw HTML | Sanitized on save (server) and on render (client). Form controls are removed too, so a brew cannot draw a fake sign-in form. | OK: `ContentPolicyAlignmentTests` now includes `input`, `textarea` and `formaction` cases. |
| SR-8 | XSS: user CSS | Scoped to the canvas (`cssScope.ts`). `@import`s are fetched without credentials and scoped. The CSS policy rejects script URLs. | OK. Residual risk R-1 below. |
| SR-9 | CSRF | `SameOriginWriteGuard`: POST/PUT/PATCH/DELETE need an `Origin` (or, without it, `Referer`) equal to the request's scheme, host and port. `Origin: null` and several values are refused. The autosave's `keepalive` fetch is a PUT, so browsers send `Origin` and it passes like any save. The app uses no `sendBeacon`. Cookies are SameSite=Lax, and GET endpoints change nothing except view counts. | OK: `SameOriginWriteGuardTests`. `web/e2e/save/autosave-api.spec.ts` covers the keepalive save. |
| SR-10 | Secrets | No secrets in `appsettings.json` or the image. The Development connection string (the local compose password) is used only in Development. The image runs as a non-root user, and the Data Protection keys live in a 0700 volume directory. | OK. See R-5. |
| SR-11 | Dependencies | `npm audit --omit=dev`: 0 vulnerabilities. `dotnet list package --vulnerable --include-transitive`: none (Api, Core, Data, tests). | OK on 2026-09-26. Re-run before releases; Dependabot is configured. |
| SR-12 | Cookies | HttpOnly, SameSite=Lax, and Secure on HTTPS (`Auth:CookieSecurePolicy`, `Always` possible). Data Protection keys persist, so sign-ins survive restarts. | OK: `AuthCookieTests`, `DataProtectionTests`. See R-4. |
| SR-13 | Rate limits | Auth 20/min per IP, writes 120/min per IP, import 10/min per user, PDF export 10/min per user or (signed out) per IP. Rejected anonymous writes count too. Identity locks an account out after repeated failed sign-ins. | OK: `RateLimitTests`. See R-3. |
| SR-14 | Error leakage | problem+json everywhere. Exception details only in Development. `/register` does not reveal existing accounts. | OK: `ProblemDetailsTests`, `RegisterPrivacy`. |

## Residual risks

- **R-1: Brew CSS can restyle and overlay what viewers see.** For example, `position: fixed` text over the whole
  viewport. This is by design (and the same upstream). Without scripts, forms or form controls, an overlay cannot
  collect input. Links in brews go wherever their author wants.
- **R-2: Brews load images, fonts and CSS from other https sites.** Those sites see the viewer's IP address and
  user agent (tracking pixels). The `Referrer-Policy` limits what they learn to the origin.
- **R-3: Per-IP limits and forwarded headers.** Per-IP rate limits depend on a correct client IP. With
  `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`, forwarded headers are trusted from every peer. That is safe only while
  nothing but the proxy can reach the app, as in the compose files. Otherwise set `ForwardedHeaders:KnownProxies` or
  `ForwardedHeaders:KnownNetworks`.
- **R-4: Hardening not done.** The session cookie has no `__Host-` prefix, and `AllowedHosts` is `*`. The `Host`
  header only affects the share shell's `og:url`, which is not cached (`Cache-Control: no-cache`). Production
  deployments should still set `AllowedHosts` to the site's host name.
- **R-5: `appsettings.Development.json` is part of the image.** It holds only the local compose connection string
  and is ignored outside Development.
- **R-6: Identity bearer tokens.** `POST /api/auth/login` without `useCookies=true` returns bearer tokens (Identity
  API endpoints). The SPA never uses them. Only someone with the password gets one, and writes with a token still
  need an `Origin` header.
- **R-7: Exported HTML.** The HTML export is no longer offered as a file (issue #2). It is sent to the PDF renderer,
  which treats it as untrusted (see [PDF export](#pdf-export)). The export serializer still strips scripts, handlers
  and unsafe URLs (`editor/export/serialize.ts`).
- **R-8: Drafts and local brews on shared devices.** Unsaved work stays in the browser (IndexedDB drafts and local
  snapshots) after sign-out. The save lane scopes the `/new` draft to its signed-in author (`Draft.ownerId`, SAVE-12).
  Brews made without an account (the local brew library, `hb-local-brews`, issue #4) stay until they are uploaded or
  deleted from "Brews on this device"; signing out does not remove them, and uploading always needs the user's choice.
  Whoever uses the same browser profile next can still read what is stored there, as with any local data.
- **R-9: The PDF renderer's Chromium runs without Chromium's own sandbox.** This is Playwright's default. Chromium's
  sandbox needs user namespaces, and Docker's default seccomp profile blocks them. With JavaScript off and no
  network, what remains exposed is HTML, CSS, font and image parsing by a current Chromium. The Chromium build
  follows the Microsoft.Playwright version, so keep that package up to date. The process runs as the image's
  non-root user.
- **R-10: Other sites see the server fetch.** Images and fonts that a brew links on other sites are fetched from the
  server's address when someone exports a PDF (as R-2 describes for viewers).
- **R-11: Anyone can use the PDF renderer.** Without an account, a client can make the server render HTML of its
  own (not only brews) and fetch up to `Pdf:MaxRemoteFiles` public https files per render, within the per-address
  rate limit. Clients on many addresses can keep the render slots busy, so exports queue and then get 503. Lower
  `RateLimits:Pdf` or `Pdf:MaxRemoteFiles`, or put a proxy-level limit in front of `/api/export/pdf`, if that happens.

## Rules for new code

- No inline `<script>`, no `on*=` attributes, no `javascript:` URLs, no `eval`/`new Function`/string `setTimeout`,
  also in dependencies (check the production bundle).
- Fetches to other origins must be https. Workers, real iframes and `<object>` need a policy change first
  (`SecurityHeaders.DocumentPolicy`, its tests and this document).
- Server-rendered HTML must encode every value (`HtmlEncoder.Default`), as `ShareShell` does.
- New endpoints: writes need authorization, and admin routes go under `/api/admin` (the endpoint audit test fails
  otherwise). A write that stores nothing may be anonymous only when it is rate limited and listed in
  `EndpointAuditTests.AnonymousWrites` with its reason (today: `POST /api/export/pdf`).
