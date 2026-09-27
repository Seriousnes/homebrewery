#!/usr/bin/env bash
# Replace the database with a pg_dump backup.
#
#   deploy/scripts/restore.sh <dump> [--yes] [--clean] [--no-owner] [--no-safety-backup]
#
# <dump>   a file name in the backups volume (see `hb-backup.sh list`), `latest`, or a .dump file on this machine
#          (copied into the backups volume first).
# Steps: take a safety dump of the current database (<prefix>-<time>-pre-restore.dump), stop the app, restore
# (default: drop and re-create the database; --clean: restore over the existing objects, for managed servers where the
# database cannot be dropped), start the app again and wait until it is healthy. When the restore fails the app stays
# stopped; restore the pre-restore dump or fix the problem, then start it.
#
# --yes skips the confirmation prompt (needed without a terminal). --no-owner restores without object ownership (the
# connecting role owns everything). HB_APP_SERVICE names the app's compose service (default: app).
# Compose files: COMPOSE_FILE / COMPOSE_PROJECT_NAME when set, otherwise docker-compose.yml + compose.prod.yml.
set -euo pipefail
export MSYS_NO_PATHCONV=1              # Git Bash: pass /opt/... to docker unchanged
cd "$(dirname "$0")/../.."

compose() {
  if [[ -n ${COMPOSE_FILE:-} ]]; then docker compose "$@"; else docker compose -f docker-compose.yml -f compose.prod.yml "$@"; fi
}

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

target= yes=0 safety=1 options=()
while (($#)); do
  case $1 in
    --yes|-y) yes=1 ;;
    --clean|--no-owner) options+=("$1") ;;
    --no-safety-backup) safety=0 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option $1" >&2; usage ;;
    *) [[ -z $target ]] || usage; target=$1 ;;
  esac
  shift
done
[[ -n $target ]] || usage

app=${HB_APP_SERVICE:-app}
script=/opt/hb-backup/hb-backup.sh

# The backup service runs the restore (it has the database settings and the volume).
compose up -d backup >/dev/null

if [[ -f $target ]]; then
  name=$(basename "$target")
  echo "Copying $target into the backups volume as $name"
  source_path=$target
  # Git Bash: docker needs a Windows path, and MSYS_NO_PATHCONV (above) stops the automatic conversion.
  if command -v cygpath >/dev/null 2>&1; then source_path=$(cygpath -w "$target"); fi
  compose cp "$source_path" "backup:/backups/$name"
  target=$name
fi
dump=$(compose exec -T backup bash "$script" verify "$target" | tail -n 1)
dump=$(basename "${dump//$'\r'/}")

if ((!yes)); then
  if [[ ! -t 0 ]]; then echo "Refusing to restore without a terminal; pass --yes." >&2; exit 2; fi
  read -r -p "Replace the database with $dump? Everything written since that dump is lost. Type 'yes': " answer
  [[ $answer == yes ]] || { echo "Cancelled."; exit 1; }
fi

if ((safety)); then
  echo "Taking a safety dump of the current database"
  compose exec -T backup bash "$script" now pre-restore >/dev/null
fi

echo "Stopping $app"
compose stop "$app"

echo "Restoring $dump"
if ! compose exec -T backup bash "$script" restore "$dump" ${options[@]+"${options[@]}"}; then
  echo "The restore failed; $app stays stopped. Restore the pre-restore dump or fix the problem, then run:" >&2
  echo "  docker compose ... start $app" >&2
  exit 1
fi

echo "Starting $app"
compose up -d --no-deps --wait "$app"
echo "Restored $dump; $app is healthy."
