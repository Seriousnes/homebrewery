# Operations

How to run the WYSIWYG Homebrewery in production: deploying the image, configuration, secrets, the database
(managed or in compose), migrations, backups and restores, logs, health checks, sign-in keys, rate limits and admin
accounts (plan §11 P8.4). Security headers and the threat model are in [security.md](./security.md).

| Task | Command (from the repository root) |
| --- | --- |
| Build the image | `docker build -t homebrewery .` |
| Production image with the compose database, Caddy and backups | `docker compose -f docker-compose.yml -f compose.prod.yml up -d --build` |
| Production image against a managed PostgreSQL | `docker compose -f deploy/compose.external-db.yml --env-file deploy/external-db.env up -d --wait` |
| Apply migrations as a release step | `docker compose ... run --rm app migrate` |
| Back up now | `deploy/scripts/backup-now.sh` (or `.ps1`) |
| Restore | `deploy/scripts/restore.sh <dump\|latest>` (or `.ps1`) |
| Follow the logs | `docker compose ... logs -f app backup` |
| Health | `GET /healthz`, `/healthz/live`, `/healthz/ready` |
| Test a restore end to end | `deploy/scripts/test-restore.sh` |
| Test against a (simulated) managed server | `deploy/scripts/test-external-db.sh` |

`docker compose ...` stands for the compose files of your setup (the two rows above).

## Deploying

### The image

The root [Dockerfile](../Dockerfile) builds one image: the Vite SPA and the theme assets, then `dotnet publish`, on
the `mcr.microsoft.com/dotnet/aspnet:10.0` runtime.

- It listens on port **8080** (`ASPNETCORE_HTTP_PORTS=8080`), plain HTTP. Put a TLS proxy in front of it.
- It runs as the image's non-root user (`$APP_UID`).
- The environment is **Production** unless `ASPNETCORE_ENVIRONMENT` says otherwise: JSON logs, strict rate limits,
  the CSP enforced, no OpenAPI document.
- It needs **one volume**: `/var/lib/homebrewery/keys` (the sign-in key ring, see [Data Protection keys](#data-protection-keys)).
- It needs **one setting**: `ConnectionStrings__Homebrewery`. Everything else has a default.
- It has no curl or wget. The compose files check health with bash's `/dev/tcp` (see [Health](#health)).
- It contains headless Chromium (`/ms-playwright`, installed by the CLI of the pinned Microsoft.Playwright package
  with its system libraries and fonts) for PDF export: about 750 MB of the image. See [PDF export](#pdf-export).
- `docker run … homebrewery migrate` applies the migrations and exits (see [Migrations and upgrades](#migrations-and-upgrades)).

```
docker run -d --name homebrewery -p 127.0.0.1:8080:8080 \
  -v homebrewery-keys:/var/lib/homebrewery/keys \
  -e ConnectionStrings__Homebrewery="Host=db.example.com;Database=homebrewery;Username=homebrewery_app;Password=…;SSL Mode=VerifyFull" \
  -e ASPNETCORE_FORWARDEDHEADERS_ENABLED=true \
  homebrewery
```

### Three ways to run it

1. **Compose, production image, local database** – `docker compose -f docker-compose.yml -f compose.prod.yml up -d --build`.
   Services: `db` (postgres:18, volume `pgdata`), `app` (the image, `Database__MigrateOnStartup=true`), `caddy`
   (http://localhost:8080, loopback only) and `backup` (scheduled `pg_dump`). This is the setup
   `deploy/scripts/test-restore.sh` tests. For a public server, replace the dev Caddyfile with one that has your
   domain (Caddy then gets certificates itself) and publish ports 80 and 443 instead of the loopback port.
2. **Compose, managed database** – [deploy/compose.external-db.yml](../deploy/compose.external-db.yml): `app` and
   `backup` only, configured by [deploy/external-db.env](../deploy/external-db.env.example). The app publishes
   `${HB_BIND}:${HB_HTTP_PORT}` (default `127.0.0.1:8080`) for your proxy. See [Managed PostgreSQL](#managed-postgresql).
3. **Any container platform** – the image, the connection string, the key volume, a TLS proxy and the probes below.
   Run the backup script (below) as a scheduled job with the `postgres:18` image.

### Behind a proxy

The proxy must pass the `Host` header through and send `X-Forwarded-For` and `X-Forwarded-Proto`.

- Set `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`. The app then takes the client address (rate limits) and the scheme
  (Secure cookies, HSTS, `upgrade-insecure-requests`) from those headers.
- Without further settings every peer is trusted. That is right when only the proxy can reach the app (the compose
  files publish the app on the loopback interface or not at all). Otherwise list the proxy in
  `ForwardedHeaders__KnownProxies` or its network in `ForwardedHeaders__KnownNetworks`.
- If the proxy cannot send `X-Forwarded-Proto` and the site is HTTPS only, set `Auth__CookieSecurePolicy=Always`.
- Writes (POST, PUT, PATCH, DELETE) need an `Origin` (or `Referer`) header equal to the site's own origin, as the
  browser sees it. A proxy that rewrites `Host` breaks every write with 403.
- Request bodies go up to 20 MB (gzip-compressed brew saves and PDF exports). Allow that in the proxy. A PDF export
  can take up to `Pdf:RenderTimeout` (60 s): the proxy's response timeout must be at least that.
- The app serves everything (SPA, `/api`, `/share`, `/healthz`), so one `reverse_proxy` rule is enough, e.g. Caddy:
  `homebrewery.example.com { reverse_proxy 127.0.0.1:8080 }`.

## Configuration reference

ASP.NET Core reads settings from `appsettings.json`, then `appsettings.{Environment}.json`, then environment
variables, then command-line switches. In environment variables `:` becomes `__`
(`ConnectionStrings__Homebrewery`), and list entries are `Key__0`, `Key__1`, … Lists marked "list" also accept one
string separated by commas, semicolons or spaces.

| Key (environment variable) | Default | Meaning |
| --- | --- | --- |
| `ConnectionStrings:Homebrewery` | none; Development: the compose db on localhost | **Required.** Npgsql connection string. Startup fails without it. See [Managed PostgreSQL](#managed-postgresql) for SSL. |
| `Database:MigrateOnStartup` | `false` (compose files: `true`) | `true`: apply pending migrations at startup. `false`: pending migrations stop the app; run `migrate`. |
| `DataProtection:KeysPath` | image: `/var/lib/homebrewery/keys`; else ASP.NET Core's default | Directory of the sign-in key ring. Startup fails if a key cannot be written or read there. |
| `Admin:Emails` (list) | empty | Accounts that get the Admin role (at startup, on registration and on every sign-in). |
| `Admin:RequireConfirmedEmail` | `true` (Development: `false`) | Grant the role only to confirmed addresses. See [Admin accounts](#admin-accounts). |
| `Auth:CookieSecurePolicy` | `SameAsRequest` | `SameAsRequest` or `Always`. `None` is refused. |
| `ASPNETCORE_FORWARDEDHEADERS_ENABLED` | unset (compose files: `true`) | Apply `X-Forwarded-For/-Proto/-Host` (see [Behind a proxy](#behind-a-proxy)). |
| `ForwardedHeaders:KnownNetworks` (list) | empty = any peer | CIDR networks of trusted proxies, e.g. `172.16.0.0/12`. |
| `ForwardedHeaders:KnownProxies` (list) | empty = any peer | Addresses of trusted proxies. |
| `RateLimits:Auth:PermitLimit`, `:Window` | 20 per `00:01:00` (Development 1000) | `/api/auth/*`, per client address. |
| `RateLimits:Import:PermitLimit`, `:Window` | 10 per `00:01:00` (Development 100) | Upstream brew import, per signed-in user. |
| `RateLimits:Pdf:PermitLimit`, `:Window` | 10 per `00:01:00` (Development 100) | PDF export, per signed-in user. |
| `RateLimits:Writes:PermitLimit`, `:Window` | 120 per `00:01:00` (Development 10000) | Every POST/PUT/PATCH/DELETE, per client address. |
| `Pdf:MaxConcurrentRenders` | `2` | PDF renders at the same time (each is a Chromium page). See [PDF export](#pdf-export). |
| `Pdf:QueueTimeout` | `00:00:10` | How long a PDF export waits for a free render slot before it gets 503 with `Retry-After`. |
| `Pdf:RenderTimeout` | `00:01:00` | One render, other sites' files included; then 500. |
| `Pdf:MaxRemoteFiles`, `:MaxRemoteFileBytes`, `:MaxRemoteBytes`, `:RemoteFileTimeout` | `100`, 10 MB, 50 MB, `00:00:10` | Limits on other sites' images, fonts and stylesheets fetched for one render. |
| `PLAYWRIGHT_BROWSERS_PATH` | image: `/ms-playwright`; else the user's `ms-playwright` cache | Where the app looks for Chromium. |
| `SecurityHeaders:Csp`, `:CspReportUri`, `:HstsMaxAge`, `:HstsIncludeSubDomains` | see [security.md](./security.md#configuration) | Content-Security-Policy mode and HSTS. |
| `Logging:LogLevel:<category>` | see [Logs](#logs) | Log levels, e.g. `Logging__LogLevel__Default=Debug`. |
| `Logging:Console:FormatterName` | `json` (Development: `simple`) | `json`, `simple` or `systemd`. |
| `Logging:Console:FormatterOptions:*` | `IncludeScopes=true`, `UseUtcTimestamp=true`, `TimestampFormat=yyyy-MM-dd'T'HH:mm:ss.fff'Z'` | Console formatter options. |
| `Themes:CatalogPath` | `wwwroot/themes/themes.json` | The theme catalog the web build writes. Set it only to use another file; a missing configured file stops startup. |
| `Themes:SourcePath` | a `themes` folder in or above the content root | Development only: theme sources when there is no web build. |
| `Schema:ManifestPath` | `schema-manifest.json` next to the binaries | The editor schema the server validates documents against. Leave it alone. |
| `Spa:DevServerUrls` (list) | Development: `http://localhost:5173`, `http://web:5173` | Development only: where the share page fetches Vite's `index.html`. |
| `ASPNETCORE_HTTP_PORTS` / `ASPNETCORE_URLS` | image: `8080` | Kestrel's listening port(s). |
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` only on a developer machine. |
| `AllowedHosts` | `*` | Host header filter; the proxy normally takes care of this. |

The backup service has its own settings (libpq and `BACKUP_*`), listed under [Backups and restore](#backups-and-restore).

## Secrets

| Secret | Where it lives | Notes |
| --- | --- | --- |
| Database password (app) | `ConnectionStrings__Homebrewery` | Give the app its own role (see below). |
| Database password (backups) | `PGPASSWORD` of the backup service | May be a separate read-only role for dumps; restores need the owner. `PGPASSFILE` works too. |
| Sign-in key ring | the `/var/lib/homebrewery/keys` volume | Whoever has it can forge sign-in cookies. Unencrypted at rest (ASP.NET Core logs a warning at startup). |
| Dumps | the backups volume | Contain e-mail addresses and password hashes. Files are mode 600; encrypt copies you move off the server. |

- Pass secrets as environment variables from your platform's secret store, or from an env file that is not in git
  (`deploy/.gitignore` ignores `deploy/external-db.env`; the root `.env` is for local port settings only). Never put
  them in the image, in `appsettings*.json` or in a committed compose file. The passwords in `docker-compose.yml`
  and `compose.prod.yml` are for the local stack only.
- `dotnet user-secrets` is for development on the host only (every project shares the id `homebrewery`).
- The app never logs connection strings, passwords, cookies, request bodies or query strings (see [Logs](#logs)).

## Managed PostgreSQL

The image needs nothing but the connection string, so a managed server (Amazon RDS, Azure Database for PostgreSQL,
Cloud SQL, Neon, …) works like the compose database. Tested with PostgreSQL 18, which the compose stack, the API
tests and both operations test scripts use.

**Roles.** Create a role for the app that owns the database and is nothing more (no superuser, no CREATEDB):

```sql
CREATE ROLE homebrewery_app LOGIN PASSWORD '…';
CREATE DATABASE homebrewery OWNER homebrewery_app;
```

As the owner it may run the migrations (PostgreSQL 15 and later give the database owner the `public` schema). The
schema uses no extensions.

**Connection string.** Npgsql syntax; the settings that matter on a managed server:

| Setting | Use |
| --- | --- |
| `SSL Mode=VerifyFull` | Encrypt and check the server certificate and host name. Recommended. |
| `SSL Mode=VerifyCA` | Encrypt and check the certificate but not the host name (e.g. when connecting through an address the certificate does not name). |
| `SSL Mode=Require` | Encrypt without checking the certificate: protects against eavesdropping, not against a man in the middle. |
| `Root Certificate=/path/ca.pem` | The provider's CA bundle for VerifyCA/VerifyFull, when the CA is not in the image's trust store. The compose file mounts `deploy/db-certs/` at `/etc/homebrewery/db-certs/`. |
| `Maximum Pool Size=…` | Npgsql keeps up to 100 connections per process by default. Stay below the server's connection limit (small managed tiers allow few), counting every app instance and the backup job. |
| `Timeout=…`, `Command Timeout=…` | Connect timeout (15 s) and command timeout (30 s). |
| `Keepalive=30` | TCP keepalives in seconds, for platforms that drop idle connections. |

Example: `Host=db.example.com;Port=5432;Database=homebrewery;Username=homebrewery_app;Password=…;SSL Mode=VerifyFull;Root Certificate=/etc/homebrewery/db-certs/root.crt`

**With compose.** Copy [deploy/external-db.env.example](../deploy/external-db.env.example) to `deploy/external-db.env`,
put the CA certificate in `deploy/db-certs/root.crt`, fill in the file, then:

```
docker compose -f deploy/compose.external-db.yml --env-file deploy/external-db.env build app   # or set HB_IMAGE
docker compose -f deploy/compose.external-db.yml --env-file deploy/external-db.env run --rm app migrate
docker compose -f deploy/compose.external-db.yml --env-file deploy/external-db.env up -d --wait
```

The backup service connects with libpq variables (`HB_PGHOST`, `HB_PGUSER`, `HB_PGPASSWORD`, `HB_PGSSLMODE`
(default `verify-full`), `HB_PGSSLROOTCERT` (default `/etc/homebrewery/db-certs/root.crt`)). The `postgres:18` image
has no CA bundle of its own, so verify-ca and verify-full need that file. The .NET spellings (`VerifyFull`) are
accepted too.

**Tested by** `deploy/scripts/test-external-db.sh`. It starts a second `postgres:18` container on its own network
(host name `pg.external.test`, port 6543) that accepts TLS connections only (`hostssl` in pg_hba, a certificate from
a throwaway CA), creates an owner role without CREATEDB, and runs this compose file against it. It checks that:

- pending migrations stop the app when `MigrateOnStartup` is false: exit code 1 and a JSON `Hosting failed to start`
  entry that names them, no crash trace;
- `migrate` succeeds with `SSL Mode=VerifyFull` and the CA, and fails with `SSL Mode=Disable` or the wrong CA;
- the app serves the API (register, sign in, create and read a brew), every database connection of the app role is
  encrypted (`pg_stat_ssl`), and `/healthz` includes the database;
- the backup service dumps over verify-full; `restore.sh` refuses to drop a database the role cannot re-create, and
  `restore.sh --clean` restores in place;
- the app's log lines are JSON with UTC timestamps, and the password, ids and e-mail address never appear in them.

Last run (2026-09-26): 30 passed, 0 failed.

## Migrations and upgrades

The schema is EF Core migrations (`src/Homebrewery.Data/Migrations`). There are two ways to apply them:

| | `Database:MigrateOnStartup=true` | `migrate` command |
| --- | --- | --- |
| How | Every start applies pending migrations before the server listens. | `docker compose ... run --rm app migrate` (or `docker run --rm -e ConnectionStrings__Homebrewery=… homebrewery migrate`) applies them and exits: 0 on success, 1 on failure (logged as Critical). Arguments after `migrate` are configuration switches, e.g. `migrate --Logging:LogLevel:Default=Debug`. |
| App setting | `true` | `false` (the default): with pending migrations the app refuses to start and logs which ones are pending. |
| Use when | One instance, and the app's role may change the schema. The compose files do this. | A release step before the new version starts; several instances; or migrations with a stronger role than the app's (`-e ConnectionStrings__Homebrewery=…` on the `run`). |

Both also create the Admin role and grant it to `Admin:Emails`.

**Upgrading:**

1. `deploy/scripts/backup-now.sh before-upgrade`
2. Build or pull the new image.
3. `docker compose ... run --rm app migrate` (skip with `MigrateOnStartup=true`).
4. `docker compose ... up -d --wait`

Migrations only go forward. To go back to an older version, restore the dump from step 1 and run the old image.

## Backups and restore

### The backup service

The `backup` service (in `compose.prod.yml` and `deploy/compose.external-db.yml`) runs
[deploy/backup/hb-backup.sh](../deploy/backup/hb-backup.sh) in the official `postgres:18` image. Every
`BACKUP_INTERVAL` it runs `pg_dump --format=custom` into `/backups`, checks that `pg_restore --list` can read the
whole archive, and only then gives it its final name, so a failed dump never looks like a backup. It then deletes
all but the newest `BACKUP_KEEP` dumps.

- File names: `<database>-<UTC yyyymmddThhmmssZ>.dump` (scheduled), `<database>-<time>-<label>.dump` (manual, e.g.
  `-manual`, `-pre-restore`, `-before-upgrade`). Labelled dumps count towards `BACKUP_KEEP` but do not move the
  schedule.
- The first dump runs when the service starts (or when the newest scheduled dump is older than the interval). A
  restart does not cause an extra dump. A failed dump is retried after `BACKUP_RETRY_INTERVAL`.
- Logs: JSON lines like the app's, with `"Category":"hb-backup"`.
- Health: `hb-backup.sh health` fails when the newest scheduled dump is older than the interval plus
  `BACKUP_HEALTH_GRACE`; `docker compose ps` shows the service as unhealthy.
- What it covers: the whole database (accounts, brews, themes, notifications, locks). Not the sign-in key ring
  (losing it signs everyone out but loses no data; back up that volume too if you want sessions to survive a
  server loss).

| Setting | Compose variable | Default | Meaning |
| --- | --- | --- | --- |
| `BACKUP_INTERVAL` | `HB_BACKUP_INTERVAL` | `1d` | Seconds, or a number with `s`, `m`, `h` or `d`. |
| `BACKUP_KEEP` | `HB_BACKUP_KEEP` | `7` | Dumps to keep, newest first; `0` keeps all. |
| `/backups` volume | `HB_BACKUP_VOLUME` | the `backups` volume | A named volume, or a host folder (e.g. `/srv/homebrewery-backups`) for your off-site sync. |
| `BACKUP_RETRY_INTERVAL` | – | `5m` | Wait after a failed dump. |
| `BACKUP_HEALTH_GRACE` | – | `1h` | How late a dump may be before the service is unhealthy. |
| `BACKUP_MAINTENANCE_DB` | – | `postgres` | Database to connect to while dropping and re-creating the app's database. |
| `BACKUP_PREFIX` | – | the database name | File name prefix. |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`, `PGSSLROOTCERT`, … | `HB_PG*` (external-db file) | the compose db | Standard libpq settings. |

**Keep copies somewhere else.** A dump on the same server does not survive losing the server. Copy dumps off it,
e.g. `docker compose ... cp backup:/backups/<file> .`, or set `HB_BACKUP_VOLUME` to a host folder that your backup
tool syncs, and encrypt them on the way.

### Commands

```
deploy/scripts/backup-now.sh [label]                   # one dump now; prints its file name (default label: manual)
deploy/scripts/restore.sh <dump|latest|./file.dump> [--yes] [--clean] [--no-owner] [--no-safety-backup]
docker compose ... exec backup bash /opt/hb-backup/hb-backup.sh list      # dumps, newest first
docker compose ... exec backup bash /opt/hb-backup/hb-backup.sh verify latest
```

PowerShell: `deploy/scripts/backup-now.ps1 [-Label x]`, `deploy/scripts/restore.ps1 <dump> [-Yes] [-Clean] [-NoOwner] [-NoSafetyBackup]`.
The scripts use `docker-compose.yml` + `compose.prod.yml`, or `COMPOSE_FILE` / `COMPOSE_ENV_FILES` /
`COMPOSE_PROJECT_NAME` when set, e.g. `COMPOSE_FILE=deploy/compose.external-db.yml COMPOSE_ENV_FILES=deploy/external-db.env deploy/scripts/restore.sh latest --clean`.

### What a restore does

`restore.sh` (and `restore.ps1`):

1. copies a local file into the backups volume, if you gave one, and checks the dump is readable (the copy keeps its
   name; `list` and `BACKUP_KEEP` only cover files named `<prefix>-….dump`, so delete a differently named copy
   yourself when you no longer need it);
2. asks for confirmation (`--yes` skips it; without a terminal it is required);
3. takes a safety dump of the current database (`…-pre-restore.dump`; `--no-safety-backup` skips it);
4. stops the app, so nobody writes into a half-restored database;
5. restores, in one transaction:
   - default: drops the database (disconnecting its sessions) and creates it again, then restores into the empty
     database. The role must be allowed to create databases; the script checks that before dropping anything.
   - `--clean`: keeps the database and lets `pg_restore` drop and re-create the dumped objects. Use it on managed
     servers where the app's role cannot create databases. Tables that a newer migration added after the dump are
     left in place, so restore with the image version that made the dump.
   - `--no-owner`: the connecting role owns the restored objects (restoring as a different role than the owner).
6. starts the app and waits until it is healthy. If the restore fails, the app stays stopped: restore the
   pre-restore dump, or fix the problem, then start it.

After a restore, the site is exactly as it was when the dump was taken: accounts and brews created later are gone;
sign-in cookies of accounts in the dump keep working (the key ring is not touched).

Without the scripts (any host with `pg_restore` 18):

```
pg_restore --list homebrewery-….dump > /dev/null                    # readable?
dropdb --force homebrewery && createdb homebrewery                    # as a role that may
pg_restore --exit-on-error --single-transaction --dbname=homebrewery homebrewery-….dump
```

### The restore test

`deploy/scripts/test-restore.sh` runs the whole procedure against the production stack (docker-compose.yml +
compose.prod.yml, as its own compose project `hb-ops-restore-test` with Caddy on 127.0.0.1:5478; it never touches
the dev database). Through the API it creates an account and a brew, backs up with `backup-now.sh`, then registers a
second account, creates a second brew and deletes the first, and restores with `restore.sh` (drop and re-create).
Afterwards: the first account signs in with its password, its brew is back with title, description, tags and owner,
the sign-in cookie from before the restore still works, the later account and brew are gone, `/healthz` is 200, a
pre-restore dump exists, and the app's logs are JSON with no ids or e-mail addresses. Last run (2026-09-26): 30 passed, 0 failed.

Run it after changing anything about backups, and now and then with a real dump copied off the server
(`restore.sh ./file.dump` in a scratch stack) to prove the copies are usable.

## Logs

Outside Development the app writes **one JSON object per line** to stdout (`docker compose logs app`):

```json
{"Timestamp":"2026-09-26T00:13:35.349Z","EventId":1,"LogLevel":"Information","Category":"Homebrewery.Api.Infrastructure.RequestLogging","Message":"POST /api/auth/register responded 200 in 1895.5 ms","State":{"Method":"POST","Route":"/api/auth/register","StatusCode":200,"ElapsedMs":1895.5,"{OriginalFormat}":"{Method} {Route} responded {StatusCode} in {ElapsedMs} ms"},"Scopes":[{"Message":"ConnectionId:0HNORCBS7Q4LT","ConnectionId":"0HNORCBS7Q4LT"},{"Message":"RequestId:0HNORCBS7Q4LT:00000005","RequestId":"0HNORCBS7Q4LT:00000005","{OriginalFormat}":"RequestId:{RequestId}"}]}
```

- `Timestamp` is UTC with milliseconds; `State` holds the message's named values; `Scopes` the context. Errors add
  `Exception` (the full exception text).
- **Requests**: one entry per request from `Homebrewery.Api.Infrastructure.RequestLogging` (event 1,
  `RequestFinished`) with `Method`, `Route`, `StatusCode` and `ElapsedMs`. `Route` is the endpoint's route template
  (`/api/brews/edit/{editId}`, the SPA fallback `/{*path:nonfile}`), never the path itself; only requests that no
  endpoint handles (static files, misses) log their path, without the query string. Levels: Error for 5xx,
  Information otherwise, Debug for successful health probes and static files.
- **Never logged**: query strings, headers, cookies, request or response bodies, client addresses, user ids,
  connection strings.
- **Correlation**: every entry written during a request carries a `RequestId` scope. It is the `traceId` that
  problem+json error responses return, so a user's error report leads to the log entries.
- Startup failures (database unreachable, pending migrations, bad settings) are logged as
  `"Message":"Hosting failed to start"` (Error, with the exception) and the process exits with code 1.
- The backup service logs JSON lines too (`"Category":"hb-backup"`).

**Levels** come from `Logging:LogLevel` (appsettings.json), overridable by environment:

| Category | Production | Why |
| --- | --- | --- |
| `Default` | Information | |
| `Microsoft.AspNetCore` | Warning | Framework chatter. |
| `Microsoft.AspNetCore.Hosting.Diagnostics` | None | At any other level it adds a `RequestPath` scope (the raw path) to every entry. RequestLogging replaces it. |
| `Microsoft.EntityFrameworkCore` | Warning | |
| `Microsoft.EntityFrameworkCore.Database.Command` | None | No SQL command log. |
| `Microsoft.EntityFrameworkCore.Migrations` | Information | Which migrations were applied. |

Examples: `Logging__LogLevel__Default=Debug` (everything, including successful health probes);
`Logging__LogLevel__Homebrewery.Api.Infrastructure.RequestLogging=Warning` (request entries only for 5xx responses);
`Logging__Console__FormatterName=simple` (readable lines instead of JSON). Set levels under `Logging:LogLevel`, not `Logging:Console:LogLevel`: a provider-level rule would override the
`None` above. (For the same reason appsettings.json repeats it under `Logging:EventLog`, the Windows Event Log
provider, which has its own default rule.)

**Collecting**: the compose files leave logs to Docker. `deploy/compose.external-db.yml` rotates them (json-file
driver, 5 × 10 MB per container); with compose.prod.yml or `docker run`, set a logging driver or rotation yourself
(Docker's default json-file driver does not rotate). Any log shipper that reads container stdout can parse the lines
as JSON.

## Health

| Endpoint | Checks | Use it for |
| --- | --- | --- |
| `GET /healthz` | every check (today: the database) | Container health checks (the compose files use it). |
| `GET /healthz/live` | none | Liveness: the process serves HTTP. A database outage is no reason to restart the app. |
| `GET /healthz/ready` | the checks tagged `ready` (the database) | Readiness: whether to send traffic. |

Healthy: `200 {"status":"ok","checks":{"database":"ok"}}`. Unhealthy: `503` with `"unhealthy"` for the failing
checks. The database check runs `SELECT 1` on the app's own connection with a 5 s timeout. Responses carry
`Cache-Control: no-cache` and never include error details (the failure is in the log). Kubernetes: liveness
`/healthz/live`, readiness `/healthz/ready`, startup `/healthz` with enough time for migrations when
`MigrateOnStartup` is on.

The image has no curl; the compose health checks use bash:
`exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /healthz HTTP/1.0\r\n\r\n' >&3 && head -n1 <&3 | grep -q ' 200 '`.
Caddy (`deploy/caddy/Caddyfile`) routes `/healthz` and `/healthz/*` to the app.

## Data Protection keys

ASP.NET Core Data Protection encrypts the sign-in cookies with a key ring. The image keeps it in
`/var/lib/homebrewery/keys` (`DataProtection__KeysPath`), owned by the app user with mode 700.

- **Mount a volume there** (`app-keys` in the compose files). Without one, every new container (`up --build`, an
  image upgrade) makes new keys and signs everyone out. Startup fails if the directory is not writable, so a broken
  mount is noticed at once.
- Several app instances must share one key ring (the same volume or a shared file system), or a cookie issued by one
  is rejected by the others.
- Keys are stored unencrypted (ASP.NET Core warns about this at startup). Treat the volume like the database.
- Losing the keys loses no data: everyone signs in again.

## Rate limits

Fixed windows, kept in memory per app instance (they are not shared between instances):

| Limit | Default | Applies to |
| --- | --- | --- |
| `Auth` | 20 per minute per client address | `/api/auth/*` (register, sign in, …) |
| `Import` | 10 per minute per user | `GET /api/import/homebrewery/{shareId}` |
| `Pdf` | 10 per minute per user | `POST /api/export/pdf` |
| `Writes` | 120 per minute per client address | every POST, PUT, PATCH and DELETE |

A rejected request gets `429` problem+json with a `Retry-After` header. Configure with
`RateLimits__<Name>__PermitLimit` and `RateLimits__<Name>__Window` (a TimeSpan, e.g. `00:01:00`); startup fails on
a limit below 1 or a window that is not positive. Behind a proxy the client address comes from `X-Forwarded-For`, so
forwarded headers must be on; otherwise every user shares the proxy's address and its limits.

## PDF export

"Download PDF" (editor, share page) and a brew item's PDF download (user page) send the brew's self-contained HTML
export to `POST /api/export/pdf`. The app renders it with headless Chromium ([Microsoft.Playwright](https://github.com/microsoft/playwright-dotnet),
Apache-2.0) and answers the PDF. Signed-in users only.

- Chromium starts on the first export (about a second), not with the app, and again after a crash. `/healthz` does
  not check it. A missing or broken Chromium logs `PDF export: Chromium could not be started` (Error) and the
  exports answer 503; everything else keeps working.
- Every render gets a fresh browser context without JavaScript. The app fetches other sites' https images, fonts and
  stylesheets itself, from public addresses only; nothing else leaves the process. See [security.md](./security.md#pdf-export).
- Memory and time: the container used about 280 MB (app and Chromium) after its first PDFs; each render in
  progress adds a Chromium page (`Pdf:MaxConcurrentRenders`, default 2). A 3-page brew takes under a second, the
  first PDF after a start about a second more. More exports at once wait up to `Pdf:QueueTimeout`, then get 503
  with `Retry-After`.
- Logs: one Information line per PDF (`PDF export: <bytes> bytes, <n> files of other sites, <n> left out, <ms> ms`),
  Information lines for other sites' files that were left out (host and reason), Warning for a failed render.
- The image installs the Chromium build of the pinned package version. The development stack's `api` service is
  built from the Dockerfile's `dev-api` stage: after a Microsoft.Playwright upgrade, run `docker compose build api`.
  For a run on the host: `pwsh src/Homebrewery.Api/bin/Debug/net10.0/playwright.ps1 install --only-shell chromium`
  (or `npx playwright install chromium` in `web/`, which installs the same build while the versions match).

## Admin accounts

`Admin:Emails` lists the accounts that get the Admin role, e.g. `Admin__Emails=alice@example.org;bob@example.org`.
The role is granted at startup, on registration and on every sign-in.

- `Admin:RequireConfirmedEmail` (default `true`) grants it only to confirmed addresses, because registration does not
  prove that someone owns the address. The app does not send e-mail yet, so confirm an admin's address in the
  database, then sign in again:

  ```sql
  UPDATE asp_net_users SET email_confirmed = true WHERE normalized_email = upper('alice@example.org');
  ```

- Removing an address from the list does not revoke the role. Revoke it in the database:

  ```sql
  DELETE FROM asp_net_user_roles
  WHERE user_id = (SELECT id FROM asp_net_users WHERE normalized_email = upper('alice@example.org'))
    AND role_id = (SELECT id FROM asp_net_roles WHERE name = 'Admin');
  ```

  The role claim lives in the sign-in cookie until it is refreshed (up to 30 minutes).

## Tests

| What | How |
| --- | --- |
| Restore from backup, end to end | `deploy/scripts/test-restore.sh [--keep] [--no-build]` (needs Docker, bash, curl, perl; Git Bash on Windows) |
| Managed PostgreSQL, SSL modes, migrate command, `--clean` restore | `deploy/scripts/test-external-db.sh [--keep] [--no-build]` |
| Request logging, log format and levels, health probes, the `migrate` command and startup failures (as real processes) | `dotnet test --project tests/Homebrewery.Api.Tests -- --filter-namespace Homebrewery.Api.Tests.Operations` |

Both scripts build the image as `homebrewery:ops-test` (`HB_TEST_IMAGE`) unless `--no-build`, use port 5478
(`HB_TEST_PORT`), and remove their containers, volumes and networks at the end unless `--keep`.
