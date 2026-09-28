## WYSIWYG rewrite (fork)

- Plan of record: [https://claude.ai/artifact/1X5nXZesTgEWWRCTuCXEgt](https://claude.ai/artifact/1X5nXZesTgEWWRCTuCXEgt) ("Homebrewery WYSIWYG Plan").
Before starting a task, read the plan section for its ID (e.g. P4.3) and meet its "Done when".
- Run: ./stack up (PowerShell: .\stack up) → the branch's own stack (compose project hb-<branch>: API under dotnet watch,
Vite; http://<branch>.homebrewery.dev.localhost (master: http://homebrewery.dev.localhost), or localhost:8080 in the
main checkout, 8080 + slot in a worktree; ./stack info) on ONE shared PostgreSQL and router for every branch (compose
project homebrewery-shared). README "Running locally". Production image: ./stack --prod up --build
- User secrets: every project shares UserSecretsId "homebrewery" (set once in Directory.Build.props). e.g. dotnet user-secrets set <key> <value> --project src/Homebrewery.Api
- Backend: src/ (.NET 10, ASP.NET Core minimal APIs, EF Core + Npgsql, PostgreSQL 18).
Host-only run: ./stack db up (the shared PostgreSQL on :5432), then dotnet run --project src/Homebrewery.Api (:5080)
- Access model: sign-in is needed only to save brews to the cloud, publish, and share a private brew. Anyone can create brews
in the browser (the local brew library, issue #4), keep any number, download them as PDF, and upload them to an account
later (never automatically). Don't gate anything else behind sign-in without asking.
- PDF export: POST /api/export/pdf renders the web client's HTML export with headless Chromium (Microsoft.Playwright).
Host runs and dotnet test need that Chromium: npm --prefix web exec playwright install chromium (the same build).
The Docker images install it; after a Microsoft.Playwright upgrade, ./stack build api.
- Frontend: web/ (React 19, TypeScript, Vite, TipTap 3). Host-only run: npm --prefix web run dev (:5173, proxies /api to :5080).
- themes/ is shared with upstream. Only edit theme LESS to fix bugs. The editor must emit the
HTML listed in the plan's "CSS contract" so theme CSS keeps working unchanged.
- legacy/ holds the original Node/React code for reference. Never import from it at runtime.
- Pagination: transactions set addToHistory=false and move page boundaries only with
join + split (never delete + insert). See plan section 4.
- Tests: before every push, npm --prefix web run verify (CI's lint, typecheck, schema check, build, unit tests and .NET Release build + dotnet test, whatever you changed: API tests read web files) + the e2e specs your change can reach, on CI's Linux image (node e2e/run-linux.mjs <spec or folder> [--project=chromium], from web/; npm --prefix web run e2e -- <spec> while iterating; shared styles/tokens also e2e/a11y, e2e/admin, e2e/lists, e2e/shell; navigation/sign-in also e2e/shell, e2e/import-ui) + npm --prefix web run e2e:smoke; the full e2e suite runs in CI only. Never format with bare npx prettier (no repo config: it rewrites whole files).
Production build under the enforced CSP: node e2e/security/run-csp.mjs (from web/); new pages need a step in web/e2e/security/csp.spec.ts.
Tests never share servers or data across worktrees: runners start their own PostgreSQL container and use the
worktree's slot ports and temp folders. Only Docker needs to be running.

## Development guidelines (beyond the plan)

- Container-first: running the app on a developer machine means `./stack up`, which starts
every required resource (Postgres, API, web dev server, the router). Host-only runs stay possible but
are secondary.
- One stack per branch/worktree (compose project hb-<branch>, http://<branch>.homebrewery.dev.localhost, port per
worktree slot), all on one shared PostgreSQL (project homebrewery-shared, volume homebrewery-shared-pgdata). Never mount a
PostgreSQL data volume into a second container. Tests run their own stack: their own PostgreSQL
container and the worktree's ports, never the shared database.
- Postgres always comes from the official Docker image (postgres:18), in compose and in tests
(Testcontainers, the e2e runners' containers). Never assume a locally installed Postgres.
- One origin per stack, the Vite dev server: its proxy sends /api, /share, /openapi and /healthz to the API.
No proxy container per stack. The one shared router (Caddy in deploy/stack/shared.yml) only maps
homebrewery.dev.localhost (master) and <branch>.homebrewery.dev.localhost to the branch's stack.
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

