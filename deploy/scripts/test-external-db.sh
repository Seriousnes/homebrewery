#!/usr/bin/env bash
# Managed-PostgreSQL test (plan P8.4 "the container runs against a managed Postgres"; docs/operations.md
# "Managed PostgreSQL").
#
#   deploy/scripts/test-external-db.sh [--keep] [--no-build]
#
# Simulates a managed server: a second postgres:18 container on its own network (host name pg.external.test, port
# 6543) that accepts TLS connections only (pg_hba hostssl, a certificate from a throwaway CA), with an application role
# that owns its database but is neither superuser nor allowed to create databases. The app image then runs from
# deploy/compose.external-db.yml, configured by the connection string alone, and the script checks:
#   - pending migrations stop the app when Database:MigrateOnStartup is false;
#   - the one-off `migrate` command applies them (SSL Mode=VerifyFull with the CA), and fails with SSL Mode=Disable
#     or with the wrong CA;
#   - the app serves the API, every one of its database connections is encrypted, /healthz includes the database;
#   - the backup service dumps over verify-full; restore.sh refuses to drop a database the role cannot re-create, and
#     --clean restores in place;
#   - the app's logs are JSON lines.
# Exit code 0 when every check passed. Everything is removed at the end unless --keep.
#
# Environment: HB_TEST_PORT (5478, the app's published port), HB_TEST_IMAGE (homebrewery:ops-test; built unless
# --no-build), HB_TEST_PROJECT (hb-ops-extdb-test).
set -euo pipefail
cd "$(dirname "$0")/../.."
source deploy/test/lib.sh

keep=0 build=1
for arg in "$@"; do
  case $arg in
    --keep) keep=1 ;;
    --no-build) build=0 ;;
    *) echo "usage: $0 [--keep] [--no-build]" >&2; exit 2 ;;
  esac
done

server=hb-ops-extdb network=hb-ops-extdb-net certs_volume=hb-ops-extdb-certs
host=pg.external.test port=6543 app_password='app-Pw-7c1f' admin_password='admin-Pw-93ad'
export COMPOSE_PROJECT_NAME=${HB_TEST_PROJECT:-hb-ops-extdb-test}
export COMPOSE_PATH_SEPARATOR=:
export COMPOSE_FILE=deploy/compose.external-db.yml:deploy/test/compose.external-db-test.yml
export HB_EXTDB_NETWORK=$network
export HB_IMAGE=${HB_TEST_IMAGE:-homebrewery:ops-test}
export HB_HTTP_PORT=${HB_TEST_PORT:-5478} HB_BIND=127.0.0.1
export BASE_URL=http://localhost:$HB_HTTP_PORT
case $HB_HTTP_PORT in 5080|5173|8080) echo "Refusing to use port $HB_HTTP_PORT (the dev stack's)." >&2; exit 2 ;; esac

connection() { # connection <ssl mode> [root certificate file]
  printf 'Host=%s;Port=%s;Database=homebrewery;Username=hb_app;Password=%s;SSL Mode=%s;Root Certificate=/etc/homebrewery/db-certs/%s' \
    "$host" "$port" "$app_password" "$1" "${2:-root.crt}"
}
export HB_CONNECTION_STRING=$(connection VerifyFull)
export HB_MIGRATE_ON_STARTUP=false
export HB_PGHOST=$host HB_PGPORT=$port HB_PGDATABASE=homebrewery HB_PGUSER=hb_app HB_PGPASSWORD=$app_password
export HB_PGSSLMODE=VerifyFull          # the .NET spelling; hb-backup.sh turns it into verify-full
export HB_BACKUP_INTERVAL=1h HB_BACKUP_KEEP=5

work=$(mktemp -d)
mkdir -p "$work/certs"
# docker compose needs a native path for the bind mount (Git Bash: C:/...).
if command -v cygpath >/dev/null 2>&1; then HB_DB_CERTS_DIR=$(cygpath -m "$work/certs"); else HB_DB_CERTS_DIR=$work/certs; fi
export HB_DB_CERTS_DIR

remove_all() {
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$server" >/dev/null 2>&1 || true
  docker volume rm "$certs_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
cleanup() {
  local status=$?
  if ((keep)); then echo "Kept $server, $network and compose project $COMPOSE_PROJECT_NAME."; else remove_all; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
remove_all

step "Simulated managed server: $host:$port on network $network, TLS only"
docker network create "$network" >/dev/null
docker volume create "$certs_volume" >/dev/null
docker run --rm -v "$certs_volume:/certs" postgres:18 bash -euc "
  cd /certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Homebrewery test CA' -keyout ca.key -out ca.crt 2>/dev/null
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Some other CA' -keyout other.key -out wrong-ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj '/CN=$host' -keyout server.key -out server.csr 2>/dev/null
  printf 'subjectAltName=DNS:$host\n' > san.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt 2>/dev/null
  printf 'local all all trust\nhostssl all all all scram-sha-256\n' > pg_hba.conf
  chown postgres:postgres server.key server.crt pg_hba.conf && chmod 600 server.key
"
docker run --rm -v "$certs_volume:/certs:ro" postgres:18 cat /certs/ca.crt >"$work/certs/root.crt"
docker run --rm -v "$certs_volume:/certs:ro" postgres:18 cat /certs/wrong-ca.crt >"$work/certs/wrong-ca.crt"
docker run -d --name "$server" --network "$network" --network-alias "$host" -v "$certs_volume:/certs:ro" \
  -e POSTGRES_USER=hb_admin -e POSTGRES_PASSWORD="$admin_password" postgres:18 \
  -c port=$port -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key -c hba_file=/certs/pg_hba.conf >/dev/null
admin() { docker exec "$server" psql --no-psqlrc -v ON_ERROR_STOP=1 -U hb_admin -p "$port" -d postgres "$@"; }
for _ in $(seq 1 60); do
  # The entrypoint's temporary server listens on no TCP port; wait for the real one.
  if docker exec "$server" pg_isready -h 127.0.0.1 -p "$port" >/dev/null 2>&1; then break; fi
  sleep 1
done
admin -q -c "CREATE ROLE hb_app LOGIN PASSWORD '$app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE" \
  -c "CREATE DATABASE homebrewery OWNER hb_app"
check "the server refuses unencrypted connections" bash -c "! docker run --rm --network '$network' -e PGPASSWORD='$app_password' postgres:18 \
  psql 'host=$host port=$port dbname=homebrewery user=hb_app sslmode=disable' -c 'select 1' >/dev/null 2>&1"

if ((build)); then step "Build $HB_IMAGE"; docker compose build app; fi

step "Migrations: startup check and the one-off migrate command"
set +e
out=$(timeout 180 docker compose run --rm --no-deps -T app 2>&1); status=$?
set -e
expect_eq "with pending migrations and MigrateOnStartup=false the app stops with exit code" 1 "$status"
check "... logs 'Hosting failed to start' as JSON, naming the pending migrations" \
  grep -q '^{.*"Message":"Hosting failed to start".*pending migration' <<<"$out"
check "... without an unhandled-exception crash" bash -c "! grep -q 'Unhandled exception' <<<\"\$1\"" _ "$out"
set +e
out=$(docker compose run --rm --no-deps -T -e "ConnectionStrings__Homebrewery=$(connection Disable)" app migrate 2>&1); status=$?
set -e
check "migrate with SSL Mode=Disable is refused (exit $status)" test "$status" -eq 1
set +e
out=$(docker compose run --rm --no-deps -T -e "ConnectionStrings__Homebrewery=$(connection VerifyFull wrong-ca.crt)" app migrate 2>&1); status=$?
set -e
check "migrate with VerifyFull and the wrong CA is refused (exit $status)" test "$status" -eq 1
set +e
out=$(docker compose run --rm --no-deps -T app migrate 2>"$work/migrate.err"); status=$?
set -e
expect_eq "migrate with VerifyFull and the server's CA" 0 "$status"
check "... logs that the database is up to date" grep -q "The database is up to date" <<<"$out"
read -r lines bad nonutc _ _ < <(json_lines_report <<<"$out")
expect_eq "migrate's output lines that are not JSON (of $lines)" 0 "$bad"

step "Run the app and the backup service"
docker compose up -d --wait --wait-timeout 300 app backup
check "/healthz answers 200" wait_healthy "$BASE_URL/healthz" 60
expect_eq "/healthz includes the database" ok "$(curl -s "$BASE_URL/healthz" | json checks.database)"
expect_eq "/healthz/ready includes the database" ok "$(curl -s "$BASE_URL/healthz/ready" | json checks.database)"

run=$(random_id)
email="extdb-$run@example.test" password='External-Db-1!'
check "register and sign in" register_and_sign_in "$work/user" "$email" "$password"
http "$work/user" POST /api/brews "{\"meta\":{\"title\":\"Managed database $run\"}}"
expect_eq "create brew" 201 "$HTTP_STATUS"
edit_id=$(json editId <<<"$HTTP_BODY") share_id=$(json shareId <<<"$HTTP_BODY")
http "$work/anon" GET "/api/brews/share/$share_id"
expect_eq "read it back" "Managed database $run" "$(json meta.title <<<"$HTTP_BODY")"

ssl=$(admin -tA -c "SELECT count(*) || ' ' || count(*) FILTER (WHERE s.ssl) FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename = 'hb_app'")
read -r total encrypted <<<"$ssl"
check "the app holds database connections ($total)" test "$total" -gt 0
expect_eq "connections of hb_app that use TLS" "$total" "$encrypted"

step "Backups against the managed server"
check "the backup service is healthy (first scheduled dump over verify-full)" \
  bash -c "docker compose exec -T backup bash /opt/hb-backup/hb-backup.sh health"
dump=$(deploy/scripts/backup-now.sh managed-test)
echo "dump: $dump"
http "$work/user" POST /api/brews "{\"meta\":{\"title\":\"After the backup $run\"}}"
lost_share_id=$(json shareId <<<"$HTTP_BODY")
set +e
out=$(deploy/scripts/restore.sh "$dump" --yes --no-safety-backup 2>&1); status=$?
set -e
check "restore without --clean is refused for a role without CREATEDB (exit $status)" test "$status" -ne 0
check "... with a hint to use --clean" grep -q "Use --clean" <<<"$out"
docker compose up -d --no-deps --wait app >/dev/null 2>&1 || true
check "the database was left alone" wait_healthy "$BASE_URL/healthz" 60
http "$work/anon" GET "/api/brews/share/$lost_share_id"
expect_eq "the newer brew is still there" 200 "$HTTP_STATUS"
deploy/scripts/restore.sh "$dump" --yes --clean
http "$work/anon" GET "/api/brews/share/$share_id"
expect_eq "after restore --clean: the backed-up brew" "Managed database $run" "$(json meta.title <<<"$HTTP_BODY")"
http "$work/anon" GET "/api/brews/share/$lost_share_id"
expect_eq "after restore --clean: the brew written after the backup is gone" 404 "$HTTP_STATUS"
check "sign-in works after the restore" sign_in "$work/user-again" "$email" "$password"

step "Structured logs"
docker compose logs --no-log-prefix --no-color app >"$work/app.log"
read -r lines bad nonutc requests pathscopes < <(json_lines_report <"$work/app.log")
echo "$lines log lines, $requests request entries"
expect_eq "log lines that are not one JSON object" 0 "$bad"
expect_eq "timestamps that are not UTC ISO 8601" 0 "$nonutc"
check "request entries" test "$requests" -gt 0
expect_eq "entries with the raw RequestPath scope" 0 "$pathscopes"
check "no password, share id, edit id or e-mail address in the logs" \
  bash -c "! grep -q -e '$app_password' -e '$share_id' -e '$edit_id' -e '$email' '$work/app.log'"

summary
