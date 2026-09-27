## WYSIWYG rewrite (fork)

- Plan of record: [https://claude.ai/artifact/1X5nXZesTgEWWRCTuCXEgt](https://claude.ai/artifact/1X5nXZesTgEWWRCTuCXEgt) ("Homebrewery WYSIWYG Plan").
Local text copy: docs/wysiwyg-plan.md (same content; section numbers and task IDs match).
Before starting a task, read the plan section for its ID (e.g. P4.3) and meet its "Done when".
What was actually built (interfaces, conventions, deviations): docs/implementation-notes.md.
- Run: docker compose up → [http://localhost:8080](http://localhost:8080) (db, API under dotnet watch, Vite, Caddy; README  
"Running locally"). Production image: docker compose -f docker-compose.yml -f compose.prod.yml up --build
- User secrets: every project shares UserSecretsId "homebrewery" (set once in Directory.Build.props). e.g. dotnet user-secrets set <key> <value> --project src/Homebrewery.Api
- Backend: src/ (.NET 10, ASP.NET Core minimal APIs, EF Core + Npgsql, PostgreSQL 18).
Host-only run: docker compose up -d db, then dotnet run --project src/Homebrewery.Api (:5080)
- PDF export: POST /api/export/pdf renders the web client's HTML export with headless Chromium (Microsoft.Playwright).
Host runs and dotnet test need that Chromium: npm --prefix web exec playwright install chromium (the same build).
The Docker images install it; after a Microsoft.Playwright upgrade, docker compose build api. docs/implementation-notes.md "PDF export".
- Frontend: web/ (React 19, TypeScript, Vite, TipTap 3). Host-only run: npm --prefix web run dev (:5173, proxies /api to :5080).
- themes/ is shared with upstream. Only edit theme LESS to fix bugs. The editor must emit the
HTML listed in the plan's "CSS contract" so theme CSS keeps working unchanged.
- legacy/ holds the original Node/React code for reference. Never import from it at runtime.
- Pagination: transactions set addToHistory=false and move page boundaries only with
join + split (never delete + insert). See plan section 4.
- Tests: npm --prefix web test (dotnet test for src/) + only the e2e specs of the area you change (npm --prefix web run e2e -- <spec or folder>) + npm --prefix web run e2e:smoke; the full e2e suite runs in CI only (docs/testing.md).
Production build under the enforced CSP: node e2e/security/run-csp.mjs (from web/); new pages need a step in web/e2e/security/csp.spec.ts.
- Operations (image, configuration, migrations, backups, logs, health): docs/operations.md. Security (CSP and headers, review, rules for new code): docs/security.md.

## Development guidelines (beyond the plan)

- Container-first: running the app on a developer machine means `docker compose up`, which starts
every required resource (Postgres, API, web dev server, Caddy). Host-only runs stay possible but
are secondary.
- Postgres always comes from the official Docker image (postgres:18), in compose and in tests
(Testcontainers). Never assume a locally installed Postgres.
- Caddy does local routing: one origin for the browser, /api, /share, /openapi and /healthz go to
the API, everything else to the Vite dev server (including the HMR websocket).
- Tests fail or succeed fast. There are NO long tests and no long test runs — no exceptions, no
  opt-in "long" tier, no nightly long jobs.
  - Per test: Playwright 15 s default (5 s expect/action, 10 s navigation), Vitest 5 s. Explicit
    overrides are hard-capped at 60 s (e2e) and 15 s (unit) by web/scripts/testTimeouts.test.ts, which
    also rejects any @long tag or E2E_LONG/HB_LONG switch. Never raise a timeout to make a slow test
    pass: fix the slowness, or split the test (a 1,000-edit fuzz = many short tests with different seeds).
  - Per set: every Playwright invocation is capped at 5 minutes (globalTimeout) and bails after 5
    failures; a bigger suite runs as several short sets. dotnet test is capped at 5 minutes per run.
  - Runner scripts kill a set that makes no progress for 60 s and print what was running.
  - Agents: run tests in the foreground with a hard command timeout (≤ 5 min); never sleep-poll a log,
    never start a run you expect to take long. If a run stalls, kill it, find the stuck test, fix it.

