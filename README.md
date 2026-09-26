# Homebrewery WYSIWYG (fork)

[![CI](https://github.com/Seriousnes/homebrewery/actions/workflows/ci.yml/badge.svg)](https://github.com/Seriousnes/homebrewery/actions/workflows/ci.yml)

This is a fork of [naturalcrit/homebrewery](https://github.com/naturalcrit/homebrewery) that rebuilds
the brew editor as a single WYSIWYG canvas. Authors type directly on fixed-size, theme-styled pages,
and text moves to a new page automatically when a page fills. Markdown is kept for importing
existing brews only.

- **Front end:** React 19 + TypeScript SPA built with Vite, editor on TipTap 3 / ProseMirror (`web/`).
- **Back end:** ASP.NET Core minimal APIs on .NET 10 with EF Core + Npgsql (`src/`).
- **Database:** PostgreSQL 18; documents are stored as ProseMirror JSON in `jsonb`.
- **Themes:** the upstream theme CSS and snippet generators (`themes/`) are reused unchanged.

The plan of record is [docs/wysiwyg-plan.md](./docs/wysiwyg-plan.md), a text copy of the
[Homebrewery WYSIWYG Plan](https://claude.ai/artifact/1X5nXZesTgEWWRCTuCXEgt). Work is tracked by task ID
(P0.1–P8.4, spikes S1–S3). The rewrite is in progress; the original app is kept in [legacy/](./legacy)
for reference.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | .NET 10 back end: `Homebrewery.Api` (ASP.NET Core host, endpoints, auth, SPA hosting, share shell), `Homebrewery.Core` (domain services, schema manifest, theme catalog), `Homebrewery.Data` (EF Core `AppDbContext`, configurations, migrations) |
| `tests/` | `Homebrewery.Api.Tests` (xUnit, WebApplicationFactory, Testcontainers.PostgreSql) and `markdown/`, the upstream markdown fixtures used by the import tests |
| `web/` | Vite + React 19 + strict TypeScript SPA: the editor, pagination, import, app pages, Vitest unit tests and Playwright e2e specs. `npm run build` writes into `src/Homebrewery.Api/wwwroot` (git-ignored) |
| `themes/` | Shared with upstream: V3 and Legacy theme LESS, fonts, assets and snippet generators. Edited only to fix bugs |
| `shared/` | Generated and committed files both sides read: `schema-manifest.json` (from the editor schema by `web/scripts/schema-manifest.ts`; the server validates documents against it), `openapi.json` (the API description; `web/src/api/schema.d.ts` is generated from it) and `url-policy-cases.json` (URL policy cases both test suites run) |
| `legacy/` | The original Node/React/MongoDB app (`client/`, `server/`, `shared/`, `server.js`, its build and Docker files). Reference only; nothing imports from it at runtime |
| `docs/` | `wysiwyg-plan.md`, the implementation plan; `operations.md`, running it in production; `security.md`; `testing.md`, the test suites and their fail-fast limits; `implementation-notes.md` |
| `Homebrewery.slnx`, `global.json`, `Directory.*.props` | .NET solution, SDK pin and shared build settings (central package versions) |
| `docker-compose.yml` | Local dev stack: PostgreSQL 18, the API under `dotnet watch`, the Vite dev server and Caddy (see [Running locally](#running-locally)) |
| `compose.prod.yml` | Override that runs the production image behind the same Caddy and database instead of the dev servers, plus the scheduled `backup` service |
| `deploy/caddy/Caddyfile` | Local routing: one origin (http://localhost:8080) for the API and the Vite dev server |
| `deploy/` (the rest) | Operations: `backup/hb-backup.sh` (scheduled `pg_dump`), `scripts/` (backup-now, restore and the operations tests), `compose.external-db.yml` (production against a managed PostgreSQL); see [docs/operations.md](./docs/operations.md) |
| `Dockerfile` | Production image: Vite build, then `dotnet publish`, then the ASP.NET Core runtime |
| `.github/workflows/ci.yml` | CI: web lint, typecheck, unit tests, build and Playwright (in short shards); .NET restore, build and test (see [docs/testing.md](./docs/testing.md)) |

## Running locally

### With Docker (the default)

You need only [Docker](https://www.docker.com/) with Compose 2.24.4 or later (any current Docker Desktop).
From the repository root:

```
docker compose up
```

Then open **http://localhost:8080**. Compose starts every resource the app needs:

| Service | Runs | Notes |
| --- | --- | --- |
| `db` | PostgreSQL 18 (official `postgres:18` image), data in the `pgdata` volume | Also published on `localhost:5432`; user, password and database are all `homebrewery` |
| `api` | The ASP.NET Core API under `dotnet watch` (`mcr.microsoft.com/dotnet/sdk:10.0`) | Applies pending EF Core migrations at startup (`Database__MigrateOnStartup=true`) |
| `web` | The Vite dev server (`node:24`) | Runs `npm ci` on the first start and whenever `web/package-lock.json` changes |
| `caddy` | Caddy 2 with [deploy/caddy/Caddyfile](./deploy/caddy/Caddyfile) | The one origin: `/api`, `/share`, `/openapi` and `/healthz` go to `api`; everything else, including Vite's HMR websocket, goes to `web` |

The repository is bind-mounted into `api` and `web`. When you edit files on the host, `dotnet watch`
hot-reloads the API (or restarts it) and Vite hot-updates the page. Platform-specific outputs
(`src/*/bin`, `src/*/obj`, `web/node_modules`) live in named volumes, so the Linux builds in the
containers never mix with builds on the host. The first start takes a few minutes (NuGet restore,
`npm ci`, first build). `docker compose up -d --wait` returns once every service is healthy.

- `docker compose logs -f api web` follows the dev servers.
- `docker compose restart api` restarts the API, which also applies migrations added since it started.
- `HB_HTTP_PORT=9000 docker compose up` (or `HB_HTTP_PORT=9000` in a `.env` file) serves on another port.
- `docker compose stop` stops everything. `docker compose down -v` also deletes the database and the
  build caches.

Create migrations on the host (needs the .NET SDK; `dotnet tool restore` installs the pinned `dotnet-ef`),
then run `docker compose restart api` to apply them:

```
dotnet tool restore
dotnet ef migrations add <Name> --project src/Homebrewery.Data --startup-project src/Homebrewery.Api
```

To run the production image instead of the dev servers, against the same database and still at
http://localhost:8080:

```
docker compose -f docker-compose.yml -f compose.prod.yml up --build
```

This builds the [Dockerfile](./Dockerfile) (Vite build, `dotnet publish`, ASP.NET Core runtime) and
replaces the dev `api` and `web` containers. It also starts the `backup` service, which dumps the
database daily into the `backups` volume. `docker compose up --remove-orphans` switches back.

### On the host (alternative)

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download), [Node.js 24](https://nodejs.org/) and
Docker for PostgreSQL. The containerised dev servers publish no ports of their own, so they don't
collide with this setup; both use the same database.

1. Start only PostgreSQL 18 (user, password and database are all `homebrewery`, on port 5432):

   ```
   docker compose up -d db
   ```

2. The Development settings (`src/Homebrewery.Api/appsettings.Development.json`) already point at that database.
   To use another one, store its connection string as a user secret for the API:

   ```
   dotnet user-secrets set ConnectionStrings:Homebrewery "Host=localhost;Database=homebrewery;Username=homebrewery;Password=homebrewery" --project src/Homebrewery.Api
   ```

3. Create the schema:

   ```
   dotnet tool restore
   dotnet ef database update --project src/Homebrewery.Data --startup-project src/Homebrewery.Api
   ```

   (`dotnet run --project src/Homebrewery.Api -- migrate` does the same with the app's own `migrate` command.)

4. Install the front-end dependencies:

   ```
   npm --prefix web install
   ```

5. Run the API (http://localhost:5080), then the Vite dev server (http://localhost:5173) in a second terminal.
   Vite proxies `/api`, `/share` and `/openapi` to the API (`HB_API_URL` overrides the target).

   ```
   dotnet run --project src/Homebrewery.Api
   npm --prefix web run dev
   ```

Tests (on the host; the API tests start their own PostgreSQL with Testcontainers). Every suite fails fast: short
per-test timeouts, every Playwright run capped at 5 minutes (a big suite runs as several short sets), and runner
scripts that kill a run making no progress for 60 s. There are no long tests. How to run each suite, the limits,
splitting a slow test and debugging a stall: [docs/testing.md](./docs/testing.md).

The everyday loop is the unit tests, the e2e specs of the area you change, and the smoke set (about 50 e2e tests
tagged `@smoke`, Chromium, under 3 minutes: the plan §12 flow, core pagination in the editor, an import smoke;
`docker compose up -d db` first). The full e2e suite runs in CI only.

```
dotnet test
npm --prefix web test
npm --prefix web run e2e -- e2e/matrix/typing.spec.ts   # the specs of the area you change
npm --prefix web run e2e:smoke                        # the smoke set
```

Before the first e2e run, install the browsers from `web/`: `npx playwright install chromium firefox`.
`npm run e2e` with a file or folder starts its own Vite (under the no-progress watchdog); the specs that need an API
skip without one. Rarely needed locally, from `web/` (`docker compose up -d db` first):

```
node e2e/matrix/run-suite.mjs     # the whole suite as CI runs it: private API (:5474) and Vite (:5374), in short sets
node e2e/security/run-csp.mjs     # the production build under the enforced CSP, every page (docs/security.md)
```

After changing an endpoint or a DTO, regenerate `shared/openapi.json` and `web/src/api/schema.d.ts`
(`OpenApiExportTests` fails while they are stale):

```
HB_UPDATE_OPENAPI=1 dotnet test --project tests/Homebrewery.Api.Tests -- --filter-class Homebrewery.Api.Tests.OpenApiExportTests
npm --prefix web run api:types
```

The production image on its own (serves the built SPA and the API on port 8080; see above for running it with compose,
and [Running in production](#running-in-production) for the rest):

```
docker build -t homebrewery .
docker run -p 8080:8080 -v homebrewery-keys:/var/lib/homebrewery/keys -e Database__MigrateOnStartup=true \
  -e ConnectionStrings__Homebrewery="Host=...;Database=homebrewery;Username=...;Password=..." homebrewery
```

## Running in production

[docs/operations.md](./docs/operations.md) is the operations guide: deploying the image behind a TLS
proxy, every configuration key, secrets, managed PostgreSQL (SSL modes), migrations and upgrades,
backups and restores, logs, health checks, sign-in keys, rate limits and admin accounts. In short:

- The image needs `ConnectionStrings__Homebrewery` and a volume at `/var/lib/homebrewery/keys`
  (the sign-in key ring). It listens on port 8080 and logs one JSON object per line.
- Migrations: set `Database__MigrateOnStartup=true`, or run `docker compose ... run --rm app migrate`
  as a release step (the app refuses to start while migrations are pending).
- Health: `/healthz` (includes the database), `/healthz/live`, `/healthz/ready`.
- Security headers: every response carries a Content-Security-Policy (enforced outside Development) and the
  other headers described in [docs/security.md](./docs/security.md), with the threat model and the review.
- Against a managed PostgreSQL: [deploy/compose.external-db.yml](./deploy/compose.external-db.yml) with
  [deploy/external-db.env.example](./deploy/external-db.env.example).
- Backups: the `backup` service runs `pg_dump` on a schedule (`HB_BACKUP_INTERVAL`, default daily; keeps
  `HB_BACKUP_KEEP`, default 7). `deploy/scripts/backup-now.sh` takes one now, and
  `deploy/scripts/restore.sh <dump|latest>` restores (PowerShell: the `.ps1` scripts).
- `deploy/scripts/test-restore.sh` proves a restore end to end; `deploy/scripts/test-external-db.sh`
  runs the image against a TLS-only PostgreSQL on another network.

## Upstream

This fork is based on [naturalcrit/homebrewery](https://github.com/naturalcrit/homebrewery), which runs
at [homebrewery.naturalcrit.com](https://homebrewery.naturalcrit.com). The upstream README follows,
kept for its credits, license and contribution notes. Its installation steps describe the original
Node/MongoDB app, which now lives in [legacy/](./legacy): run its `npm` commands from that folder.

---

## Upstream README

[![Homebrewery](https://circleci.com/gh/naturalcrit/homebrewery/tree/master.svg?style=svg)](https://app.circleci.com/pipelines/github/naturalcrit/homebrewery?branch=master)

The Homebrewery is a tool for making authentic looking [D&D content][dnd-content-url]
using [Markdown][markdown-url]. It is distributed under the terms of the [MIT License](./license).

[dnd-content-url]: https://dnd.wizards.com/products/tabletop-games/rpg-products/rpg_playershandbook
[markdown-url]: https://github.com/adam-p/markdown-here/wiki/Markdown-Cheatsheet

### Quick Start
The easiest way to get started using The Homebrewery is to use it
[on our website][homebrewery-url]. The code is open source, so feel free to
clone it and tinker with it. If you want to make changes to the code, you can run
your own local version for testing by following the installation instructions
below.

[homebrewery-url]: https://homebrewery.naturalcrit.com

#### Installation
First, install three programs that The Homebrewery requires to run and retrieve
updates:

1. install [node](https://nodejs.org/en/), version v16 or higher.
1. install [mongodb](https://www.mongodb.com/try/download/community) (Community version)

    For the easiest installation, follow these steps:
    1. In the installer, uncheck the option to run as a service.
    1. You can install MongoDB Compass if you want a GUI to view your database documents.
    1. If you install any version over 6.0, you will have to install [MongoDB Shell](https://www.mongodb.com/try/download/shell).
    1. Go to the C:\ drive and create a folder called "data".
    1. Inside the "data" folder, create a new folder called "db".
    1. Open a command prompt or other terminal and navigate to your MongoDB install folder (C:\Program Files\Mongo\Server\6.0\bin).
    1. In the command prompt, run "mongod", which will start up your local database server.
    1. While MongoD is running, open a second command prompt and navigate to the MongoDB install folder.
    1. Search in Windows for "Advanced system settings" and open it.
    1. Click "Environment variables", find the "path" variable, and double-click to open it.
    1. Click "New" and paste in the path to the MongoDB "bin" folder.
    1. Click "OK" three times to close all the windows.
    1. In the second command prompt, run "mongo", which allows you to edit the database.
    1. Type `use homebrewery` to create The Homebrewery database. You should see `switched to db homebrewery`.
    1. Type `db.brews.insertOne({"title":"test"})` to create a blank document. You should see `{
acknowledged: true,
insertedId: ObjectId("63c2fce9e5ac5a94fe2410cf")
}`
   
1. install [git](https://git-scm.com/downloads) (select the option that allows Git to run from the command prompt).

Checkout the repo ([documentation][github-clone-repo-docs-url]):
```
git clone https://github.com/naturalcrit/homebrewery.git
```

[github-clone-repo-docs-url]: https://docs.github.com/en/free-pro-team@latest/github/creating-cloning-and-archiving-repositories/cloning-a-repository

Second, you will need to add the environment variable `NODE_ENV=local` to allow
the project to run locally.

You can set this **temporarily** (until you close the terminal) in your shell of choice with admin privileges:
* Windows Powershell: `$env:NODE_ENV="local"`
* Windows CMD: `set NODE_ENV=local`
* Linux / macOS: `export NODE_ENV=local`

If you want to add this variable **permanently** the steps are as follows:
    1. Search in Windows for "Advanced system settings" and open it.
    1. Click "Environment variables".
    1. In System Variables, click "New"
    1. Click "New" and write `NODE_ENV` as a name and `local` as the value.
    1. Click "OK" three times to close all the windows.
  This can be undone at any time if needed.

Third, you will need to install the Node dependencies, compile the app, and run
it using the two commands (in this fork, run them from the `legacy/` folder):

1. `npm install`
1. `npm start`

When the Homebrewery server is started for the first time, it will modify the database to create the indexes required for better Homebrewery performance. This may take a few moments to complete for each index, dependent on how much content is in your local database - a brand new, empty database should be done in seconds.

On completion, you should be able to go to [http://localhost:8000](http://localhost:8000) in your browser and use The Homebrewery offline.

If you had any issue at all, here are some links that may be useful:
- [Course](https://learn.mongodb.com/courses/m103-basic-cluster-administration) on cluster administration, useful for beginners
- [Mongo community forums](https://www.mongodb.com/community/forums/)
- Useful Stack Overflow links for your most probable errors: [1](https://stackoverflow.com/questions/44962540/mongod-and-mongo-commands-not-working-on-windows-10), [2](https://stackoverflow.com/questions/15053893/mongo-command-not-recognized-when-trying-to-connect-to-a-mongodb-server/41507803#41507803), [3](https://stackoverflow.com/questions/51224959/mongo-is-not-recognized-as-an-internal-or-external-command-operable-program-o)

If you still have problems, post in [Our Subreddit](https://www.reddit.com/r/homebrewery/) and we will help you.

#### Running the application via Docker

Please see the docs here: [README.DOCKER.md](./legacy/README.DOCKER.md)

#### Running the application on FreeBSD or FreeNAS

Please see the docs here: [README.FreeBSD.md](./legacy/install/README.FREEBSD.md)

#### Standalone PHB Stylesheet
If you just want the stylesheet that is generated to make pages look like they
are from the Player's Handbook, you will find it in the
[phb.standalone.css](./legacy/phb.standalone.css) file.

If you are developing locally and would like to generate your own, follow the
above steps and then run `npm run phb`.

### Issues, Suggestions, and Bugs
If you run into any issues using The Homebrewery or have suggestions for
improvement, please submit an issue [on GitHub][repo-issues-url].
You can also get help for issues on the subreddit [r/homebrewery][subreddit-url]

[repo-issues-url]: https://github.com/naturalcrit/homebrewery/issues
[subreddit-url]: https://www.reddit.com/r/homebrewery

### Changelog

You can check out the [changelog](./changelog.md).

### License

This project is licensed under the [MIT license](./license), which means you
are free to use The Homebrewery in any way that you want, except for claiming
that you made it yourself.

If you wish to sell, or in some way gain profit for, what's created on this site,
it's your responsibility to ensure you have the proper licenses/rights for any
images or resources used.

### Contributing

You are welcome to contribute to the development and maintenance of the
project! There are several ways of doing that:
- At the moment, we have a huge backlog of [issues][repo-issues-url] and some
  of them are outdated, duplicates, or don't contain any useful info. To help, you can [mark duplicates][github-mark-duplicate-url], try to
  reproduce some complex or weird issues, try finding a workaround for a
  reported bug, or just mention our issue managers team to let them know about
  outdated issues via `@naturalcrit/issue-managers`.
- Our [subreddit][subreddit-url] is constantly growing and there are number of
  bug reports. Any help with sorting them out is very welcome.
- And of course you can contribute by fixing a bug or implementing a new
  feature by yourself, we are waiting for your
  [pull requests][github-pr-docs-url]!

Anyway, if you would like to get in touch with the team and discuss/coordinate
your contribution to the project, please join our [gitter chat][gitter-url].

[github-mark-duplicate-url]: https://docs.github.com/en/free-pro-team@latest/github/managing-your-work-on-github/about-duplicate-issues-and-pull-requests
[github-pr-docs-url]: https://docs.github.com/en/free-pro-team@latest/github/collaborating-with-issues-and-pull-requests/creating-a-pull-request
[gitter-url]: https://gitter.im/naturalcrit/Lobby

