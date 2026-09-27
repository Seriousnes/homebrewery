#!/usr/bin/env bash
# Restore test (plan P8.4 "a restore from backup is tested"; docs/operations.md "Backups and restore").
#
#   deploy/scripts/test-restore.sh [--keep] [--no-build]
#
# Starts the production stack (docker-compose.yml + compose.prod.yml: db, app, Caddy, backup) as its own compose project
# (default hb-ops-restore-test, Caddy on 127.0.0.1:5478, no database port), then through the API: creates an account and
# a brew, backs up with deploy/scripts/backup-now.sh, changes data after the backup (a second account and brew), and
# restores with deploy/scripts/restore.sh, which drops and re-creates the database. Afterwards the API must show exactly
# the backed-up state: the first account signs in, its brew is back, the later account and brew are gone, and the
# sign-in cookie from before the restore still works. It also checks the app's JSON logs. Exit code 0 when every check
# passed. The project and its volumes are removed at the end unless --keep.
#
# Environment: HB_TEST_PROJECT (hb-ops-restore-test), HB_TEST_PORT (5478), HB_TEST_IMAGE (homebrewery:ops-test; built
# from the repository unless --no-build). In a linked worktree the project gets -<slot> and the port + 1000 × slot
# (deploy/test/lib.sh), so worktrees can run it at the same time.
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

export COMPOSE_PROJECT_NAME=${HB_TEST_PROJECT:-hb-ops-restore-test$HB_SLOT_SUFFIX}
export COMPOSE_PATH_SEPARATOR=:
export COMPOSE_FILE=docker-compose.yml:compose.prod.yml:deploy/test/compose.restore-test.yml
export HB_HTTP_PORT=${HB_TEST_PORT:-$HB_SLOT_TEST_PORT}
export HB_TEST_IMAGE=${HB_TEST_IMAGE:-homebrewery:ops-test}
export BASE_URL=http://localhost:$HB_HTTP_PORT
refuse_human_port "$HB_HTTP_PORT"

work=$(mktemp -d)
cleanup() {
  local status=$?
  if ((keep)); then
    echo "Kept compose project $COMPOSE_PROJECT_NAME (docker compose -p $COMPOSE_PROJECT_NAME down -v to remove it)."
  else
    docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step "Start the production stack ($COMPOSE_PROJECT_NAME, $BASE_URL, image $HB_TEST_IMAGE)"
docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
if ((build)); then docker compose build app; fi
docker compose up -d --wait --wait-timeout 300 db app caddy backup
check "/healthz answers 200 through Caddy" wait_healthy "$BASE_URL/healthz" 60
expect_eq "/healthz reports the database" ok "$(curl -s "$BASE_URL/healthz" | json checks.database)"
expect_eq "/healthz/ready reports the database" ok "$(curl -s "$BASE_URL/healthz/ready" | json checks.database)"
expect_eq "/healthz/live answers" ok "$(curl -s "$BASE_URL/healthz/live" | json status)"

run=$(random_id)
alice="restore-a-$run@example.test" bob="restore-b-$run@example.test" password='Restore-Test-1!'
title_kept="Restore test $run"
title_lost="Written after the backup $run"

step "Create data through the API"
check "register and sign in $alice" register_and_sign_in "$work/alice" "$alice" "$password"
http "$work/alice" GET /api/account/me
handle=$(json handle <<<"$HTTP_BODY")
http "$work/alice" POST /api/brews "{\"meta\":{\"title\":\"$title_kept\",\"description\":\"Kept by the backup\",\"tags\":[\"restore-test\"]}}"
created=$HTTP_BODY
expect_eq "create brew" 201 "$HTTP_STATUS"
edit_id=$(json editId <<<"$created") share_id=$(json shareId <<<"$created")
echo "account $handle, brew edit $edit_id share $share_id"
if [[ -z $handle || -z $edit_id || -z $share_id ]]; then fail "no account or brew to back up"; summary; fi

step "Back up (deploy/scripts/backup-now.sh)"
dump=$(deploy/scripts/backup-now.sh restore-test)
echo "dump: $dump"
check "the dump exists in the backups volume" docker compose exec -T backup test -s "/backups/$dump"
docker compose exec -T backup bash /opt/hb-backup/hb-backup.sh list

step "Change data after the backup"
check "register and sign in $bob" register_and_sign_in "$work/bob" "$bob" "$password"
http "$work/bob" POST /api/brews "{\"meta\":{\"title\":\"$title_lost\"}}"
lost=$HTTP_BODY
expect_eq "create a brew after the backup" 201 "$HTTP_STATUS"
lost_share_id=$(json shareId <<<"$lost")
http "$work/alice" DELETE "/api/brews/$edit_id" >/dev/null
expect_eq "delete the backed-up brew" 200 "$HTTP_STATUS"
http "$work/anon" GET "/api/brews/share/$share_id" >/dev/null
expect_eq "the backed-up brew is gone before the restore" 404 "$HTTP_STATUS"

step "Restore (deploy/scripts/restore.sh: safety dump, stop app, drop and re-create the database, restore, start app)"
deploy/scripts/restore.sh "$dump" --yes
check "/healthz answers 200 after the restore" wait_healthy "$BASE_URL/healthz" 60
docker compose exec -T backup bash /opt/hb-backup/hb-backup.sh list
check "a pre-restore safety dump was taken" bash -c "docker compose exec -T backup bash /opt/hb-backup/hb-backup.sh list | grep -- '-pre-restore.dump' >/dev/null"

step "Verify the restored data through the API"
check "$alice signs in with her password" sign_in "$work/alice-again" "$alice" "$password"
http "$work/alice-again" GET "/api/brews/edit/$edit_id"
restored=$HTTP_BODY
expect_eq "GET /api/brews/edit/{editId}" 200 "$HTTP_STATUS"
expect_eq "restored title" "$title_kept" "$(json meta.title <<<"$restored")"
expect_eq "restored description" "Kept by the backup" "$(json meta.description <<<"$restored")"
expect_eq "restored tags" '["restore-test"]' "$(json meta.tags <<<"$restored")"
expect_eq "restored owner" "$handle" "$(json authors.0.handle <<<"$restored")"
http "$work/anon" GET "/api/brews/share/$share_id"
shared=$HTTP_BODY
expect_eq "GET /api/brews/share/{shareId}" 200 "$HTTP_STATUS"
expect_eq "share title" "$title_kept" "$(json meta.title <<<"$shared")"
http "$work/alice" GET /api/account/me >/dev/null
expect_eq "the sign-in cookie from before the restore still works" 200 "$HTTP_STATUS"
http "$work/anon" GET "/api/brews/share/$lost_share_id" >/dev/null
expect_eq "the brew written after the backup is gone" 404 "$HTTP_STATUS"
http "$work/bob-again" POST '/api/auth/login?useCookies=true' "{\"email\":\"$bob\",\"password\":\"$password\"}" >/dev/null
expect_eq "the account registered after the backup is gone" 401 "$HTTP_STATUS"

step "Structured logs (docker compose logs app)"
docker compose logs --no-log-prefix --no-color app >"$work/app.log"
read -r lines bad nonutc requests pathscopes < <(json_lines_report <"$work/app.log")
echo "$lines log lines, $requests request entries"
check "the app logged something" test "$lines" -gt 0
expect_eq "log lines that are not one JSON object" 0 "$bad"
expect_eq "timestamps that are not UTC ISO 8601" 0 "$nonutc"
check "request entries (method, route template, status, duration)" test "$requests" -gt 0
expect_eq "entries with the raw RequestPath scope" 0 "$pathscopes"
check "no share id, edit id or e-mail address in the logs" \
  bash -c "! grep -q -e '$share_id' -e '$edit_id' -e '$alice' '$work/app.log'"
grep -m 2 '"RequestFinished"\|responded' "$work/app.log" || true
docker compose logs --no-log-prefix --no-color backup | tail -n 3

summary
