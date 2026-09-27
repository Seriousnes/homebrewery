#!/usr/bin/env bash
# One pg_dump backup right away, through the compose `backup` service.
#
#   deploy/scripts/backup-now.sh [label]
#
# Prints the new dump's file name (in the backups volume), e.g. homebrewery-20260926T010203Z-manual.dump.
# label: letters, digits, '.', '_' or '-' (default: manual). Labelled dumps don't postpone the scheduled ones, but they
# count towards BACKUP_KEEP.
#
# Compose files: COMPOSE_FILE / COMPOSE_PROJECT_NAME when set (e.g. COMPOSE_FILE=deploy/compose.external-db.yml),
# otherwise docker-compose.yml + compose.prod.yml. Copy a dump to this machine with
#   docker compose -f docker-compose.yml -f compose.prod.yml cp backup:/backups/<file> .
set -euo pipefail
export MSYS_NO_PATHCONV=1              # Git Bash: pass /opt/... to docker unchanged
cd "$(dirname "$0")/../.."

compose() {
  if [[ -n ${COMPOSE_FILE:-} ]]; then docker compose "$@"; else docker compose -f docker-compose.yml -f compose.prod.yml "$@"; fi
}

label=${1:-manual}
script=/opt/hb-backup/hb-backup.sh
if [[ -n $(compose ps --status running --quiet backup 2>/dev/null) ]]; then
  file=$(compose exec -T backup bash "$script" now "$label")
else
  echo "The backup service is not running; using a one-off container." >&2
  file=$(compose run --rm --no-deps -T backup bash "$script" now "$label")
fi
file=${file//$'\r'/}
basename "$(printf '%s\n' "$file" | tail -n 1)"
