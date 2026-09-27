#!/usr/bin/env bash
# Scheduled pg_dump backups for Homebrewery (plan P8.4).
# Runs inside the official postgres:18 image (pg_dump/pg_restore 18 can dump and restore any server from 9.2 up).
#
#   hb-backup.sh schedule            the backup service's command: back up every BACKUP_INTERVAL, keep BACKUP_KEEP
#   hb-backup.sh now [label]         one backup right away; prints the file name on stdout
#   hb-backup.sh list                the dumps in BACKUP_DIR, newest first
#   hb-backup.sh restore <file|latest> [--clean] [--no-owner]
#                                    replace the database with a dump (see "restore" below)
#   hb-backup.sh verify <file|latest>
#                                    check that a dump is a complete pg_dump archive
#   hb-backup.sh health              exit 0 when the newest scheduled dump is younger than BACKUP_INTERVAL + grace
#
# Connection: the standard libpq variables PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD (or PGPASSFILE),
# PGSSLMODE, PGSSLROOTCERT, ... The .NET spellings of sslmode (Require, VerifyCA, VerifyFull) are accepted too.
#
# Settings:
#   BACKUP_DIR               where dumps go (default /backups)
#   BACKUP_INTERVAL          time between scheduled dumps: seconds or a number with s, m, h or d (default 1d)
#   BACKUP_KEEP              how many dumps to keep, newest first; older ones are deleted (default 7, 0 keeps all)
#   BACKUP_PREFIX            file name prefix (default: the database name)
#   BACKUP_RETRY_INTERVAL    wait after a failed scheduled dump before trying again (default 5m)
#   BACKUP_HEALTH_GRACE      how late a scheduled dump may be before `health` fails (default 1h)
#   BACKUP_MAINTENANCE_DB    database to connect to while dropping and re-creating PGDATABASE (default postgres)
#
# Files: <prefix>-<UTC yyyymmddThhmmssZ>.dump for scheduled dumps and <prefix>-<timestamp>-<label>.dump for
# `now <label>` (e.g. pre-restore). pg_dump writes <name>.partial first; it is renamed only after `pg_restore --list`
# has read the whole archive, so a failed or interrupted dump never looks like a backup. Dumps are readable by the
# container user only (umask 077): they hold e-mail addresses and password hashes.
set -Eeuo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL="${BACKUP_INTERVAL:-1d}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_PREFIX="${BACKUP_PREFIX:-${PGDATABASE:-homebrewery}}"
BACKUP_RETRY_INTERVAL="${BACKUP_RETRY_INTERVAL:-5m}"
BACKUP_HEALTH_GRACE="${BACKUP_HEALTH_GRACE:-1h}"
BACKUP_MAINTENANCE_DB="${BACKUP_MAINTENANCE_DB:-postgres}"
LOG_FORMAT=text   # `schedule` switches to json: one object per line, like the app's logs
CURRENT_PARTIAL=  # the dump being written, removed when the service is stopped mid-dump

# ---- helpers -----------------------------------------------------------------------------------------------------

now_iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

json_escape() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037'
}

# log <Information|Warning|Error|Critical> <message>   (stderr, so `now` can print the file name alone on stdout)
log() {
  local level=$1; shift
  local message="$*"
  if [[ $LOG_FORMAT == json ]]; then
    printf '{"Timestamp":"%s","LogLevel":"%s","Category":"hb-backup","Message":"%s"}\n' \
      "$(now_iso)" "$level" "$(json_escape "$message")" >&2
  else
    printf '%s %s %s\n' "$(now_iso)" "$level" "$message" >&2
  fi
}

die() { log Error "$*"; exit 1; }

# seconds <duration>: 90, 90s, 15m, 6h, 1d -> seconds
seconds() {
  local value=$1
  [[ $value =~ ^([0-9]+)([smhd]?)$ ]] || die "Invalid duration '$value' (use seconds or a number with s, m, h or d)."
  local n=$((10#${BASH_REMATCH[1]}))
  case ${BASH_REMATCH[2]} in
    ''|s) echo "$n" ;;
    m) echo $((n * 60)) ;;
    h) echo $((n * 3600)) ;;
    d) echo $((n * 86400)) ;;
  esac
}

# The .NET/Npgsql spellings of SSL Mode (Require, VerifyFull, ...) in libpq's form (require, verify-full).
normalize_sslmode() {
  [[ -n ${PGSSLMODE:-} ]] || return 0
  local mode=${PGSSLMODE,,}
  case $mode in
    verifyca) mode=verify-ca ;;
    verifyfull) mode=verify-full ;;
  esac
  export PGSSLMODE=$mode
}

require_database() {
  [[ -n ${PGDATABASE:-} ]] || die "PGDATABASE is not set."
  [[ -n ${PGHOST:-} ]] || log Warning "PGHOST is not set; connecting through the local socket."
}

# Newest first. Scheduled dumps end in Z.dump; labelled ones in -<label>.dump.
list_dumps() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.dump" -printf '%f\n' 2>/dev/null | sort -r
}

newest_scheduled() {
  list_dumps | grep -E -- "-[0-9]{8}T[0-9]{6}Z\.dump$" | head -n 1 || true
}

resolve_dump() {
  local name=$1
  if [[ $name == latest ]]; then
    name=$(list_dumps | head -n 1)
    [[ -n $name ]] || die "No dumps in $BACKUP_DIR."
  fi
  if [[ $name != /* ]]; then name="$BACKUP_DIR/$name"; fi
  [[ -f $name ]] || die "No such dump: $name"
  printf '%s\n' "$name"
}

wait_for_server() {
  local tries=${1:-60}
  local i
  for ((i = 1; i <= tries; i++)); do
    if pg_isready --quiet --dbname="$BACKUP_MAINTENANCE_DB" >/dev/null 2>&1 || pg_isready --quiet >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ---- commands ----------------------------------------------------------------------------------------------------

# backup [label] -> prints the new file's path. Holds the directory lock while dumping and pruning.
backup() {
  local label=${1:-}
  require_database
  [[ -z $label || $label =~ ^[A-Za-z0-9_.-]+$ ]] || die "Invalid label '$label' (letters, digits, '.', '_' and '-')."
  mkdir -p "$BACKUP_DIR"
  exec 9>"$BACKUP_DIR/.lock"
  flock 9

  local stamp file partial started elapsed size
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$BACKUP_DIR/${BACKUP_PREFIX}-${stamp}${label:+-$label}.dump"
  partial="$file.partial"
  CURRENT_PARTIAL=$partial
  started=$(date +%s%N)
  log Information "Backing up database '$PGDATABASE' on ${PGHOST:-local socket} to $(basename "$file")."

  local error
  if ! error=$(pg_dump --format=custom --file="$partial" 2>&1); then
    rm -f "$partial"
    exec 9>&-
    log Error "pg_dump failed: $error"
    return 1
  fi
  if ! error=$(pg_restore --list "$partial" 2>&1 >/dev/null); then
    rm -f "$partial"
    exec 9>&-
    log Error "The new dump cannot be read back: $error"
    return 1
  fi
  mv "$partial" "$file"
  CURRENT_PARTIAL=
  elapsed=$(( ($(date +%s%N) - started) / 1000000 ))
  size=$(stat -c %s "$file")
  log Information "Wrote $(basename "$file"): $size bytes in $elapsed ms."
  prune
  exec 9>&-
  printf '%s\n' "$file"
}

# Deletes all but the newest BACKUP_KEEP dumps and any leftover .partial file. Caller holds the lock.
prune() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}-*.dump.partial" -delete 2>/dev/null || true
  [[ $BACKUP_KEEP =~ ^[0-9]+$ ]] || die "BACKUP_KEEP must be a whole number (got '$BACKUP_KEEP')."
  ((BACKUP_KEEP > 0)) || return 0
  local old
  while IFS= read -r old; do
    [[ -n $old ]] || continue
    rm -f -- "$BACKUP_DIR/$old"
    log Information "Deleted $old (BACKUP_KEEP=$BACKUP_KEEP)."
  done < <(list_dumps | tail -n +$((BACKUP_KEEP + 1)))
}

schedule() {
  LOG_FORMAT=json
  local interval retry
  interval=$(seconds "$BACKUP_INTERVAL")
  retry=$(seconds "$BACKUP_RETRY_INTERVAL")
  ((interval > 0)) || die "BACKUP_INTERVAL must be positive."
  [[ $BACKUP_KEEP =~ ^[0-9]+$ ]] || die "BACKUP_KEEP must be a whole number (got '$BACKUP_KEEP')."
  require_database
  trap '[[ -n $CURRENT_PARTIAL ]] && rm -f -- "$CURRENT_PARTIAL"; log Information "Stopping."; exit 0' TERM INT
  log Information "Backing up '$PGDATABASE' every ${interval}s into $BACKUP_DIR, keeping $BACKUP_KEEP dumps."

  while true; do
    local newest due now delay
    newest=$(newest_scheduled)
    now=$(date +%s)
    if [[ -n $newest ]]; then
      due=$(( $(stat -c %Y "$BACKUP_DIR/$newest") + interval ))
    else
      due=$now
    fi
    if ((due > now)); then
      delay=$((due - now))
      log Information "Next backup in ${delay}s (newest: $newest)."
      sleep "$delay" & wait $!
      continue
    fi
    if ! wait_for_server 30; then
      log Error "The database server is not answering; trying again in ${retry}s."
      sleep "$retry" & wait $!
      continue
    fi
    if ! backup >/dev/null; then
      log Error "Scheduled backup failed; trying again in ${retry}s."
      sleep "$retry" & wait $!
    fi
  done
}

list() {
  local name
  while IFS= read -r name; do
    [[ -n $name ]] || continue
    printf '%s\t%s bytes\t%s\n' "$name" "$(stat -c %s "$BACKUP_DIR/$name")" \
      "$(date -u -d "@$(stat -c %Y "$BACKUP_DIR/$name")" +%Y-%m-%dT%H:%M:%SZ)"
  done < <(list_dumps)
}

verify() {
  local file entries
  file=$(resolve_dump "${1:?usage: hb-backup.sh verify <file|latest>}")
  entries=$(pg_restore --list "$file" | grep -cv '^;' || true)
  log Information "$(basename "$file") is a readable pg_dump archive with $entries entries."
  printf '%s\n' "$file"
}

# restore <file|latest> [--clean] [--no-owner]
#   default   drop PGDATABASE (disconnecting its sessions), create it again, restore into the empty database.
#             Needs a role that may drop and create the database (its owner with CREATEDB, or a superuser).
#   --clean   keep the database and let pg_restore drop and re-create the dumped objects (--clean --if-exists),
#             for managed services where the database itself cannot be dropped. Tables that a newer migration
#             added after the dump was taken are left in place.
#   --no-owner  do not restore object ownership (restore as the connecting role).
# Either way the restore runs in one transaction: it either completes or changes nothing more.
restore() {
  local target=${1:?usage: hb-backup.sh restore <file|latest> [--clean] [--no-owner]}
  shift
  local mode=recreate options=()
  while (($#)); do
    case $1 in
      --clean) mode=clean ;;
      --no-owner) options+=(--no-owner --no-privileges) ;;
      *) die "Unknown restore option '$1'." ;;
    esac
    shift
  done
  require_database
  local file
  file=$(resolve_dump "$target")
  pg_restore --list "$file" >/dev/null || die "$(basename "$file") is not a readable pg_dump archive."
  wait_for_server 30 || die "The database server is not answering."
  # Wait for a running dump to finish, and keep scheduled dumps out until the restore is done.
  exec 9>"$BACKUP_DIR/.lock"
  flock 9

  local started
  started=$(date +%s%N)
  if [[ $mode == recreate ]]; then
    # DROP DATABASE and CREATE DATABASE cannot share a transaction: make sure the second one will be allowed before
    # running the first (the database owner may drop it without being allowed to create it again).
    local can_create
    can_create=$(psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --dbname="$BACKUP_MAINTENANCE_DB" \
      --command "SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user") \
      || die "Cannot connect to the maintenance database '$BACKUP_MAINTENANCE_DB' (set BACKUP_MAINTENANCE_DB, or use --clean)."
    [[ $can_create == t ]] \
      || die "Role '${PGUSER:-$(id -un)}' may not create databases, so '$PGDATABASE' cannot be dropped and re-created. Use --clean."
    log Warning "Dropping and re-creating database '$PGDATABASE' on ${PGHOST:-local socket}."
    psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="$BACKUP_MAINTENANCE_DB" \
      --set db="$PGDATABASE" <<'SQL'
DROP DATABASE IF EXISTS :"db" WITH (FORCE);
CREATE DATABASE :"db";
SQL
    pg_restore --exit-on-error --single-transaction "${options[@]}" --dbname="$PGDATABASE" "$file"
  else
    log Warning "Restoring over the objects in database '$PGDATABASE' on ${PGHOST:-local socket} (--clean)."
    pg_restore --exit-on-error --single-transaction --clean --if-exists "${options[@]}" --dbname="$PGDATABASE" "$file"
  fi
  # Fresh planner statistics. A non-superuser may not analyze the shared catalogs; skip those warnings.
  PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=error" psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --command 'ANALYZE' >/dev/null
  log Information "Restored $(basename "$file") into '$PGDATABASE' in $(( ($(date +%s%N) - started) / 1000000 )) ms."
}

health() {
  local newest interval grace age
  newest=$(newest_scheduled)
  [[ -n $newest ]] || { echo "no scheduled dump yet"; exit 1; }
  interval=$(seconds "$BACKUP_INTERVAL")
  grace=$(seconds "$BACKUP_HEALTH_GRACE")
  age=$(( $(date +%s) - $(stat -c %Y "$BACKUP_DIR/$newest") ))
  if ((age > interval + grace)); then
    echo "newest scheduled dump $newest is ${age}s old (limit $((interval + grace))s)"
    exit 1
  fi
  echo "ok: $newest (${age}s old)"
}

normalize_sslmode
command=${1:-schedule}
shift || true
case $command in
  schedule) schedule ;;
  now) backup "${1:-}" ;;
  list) list ;;
  verify) verify "$@" ;;
  restore) restore "$@" ;;
  health) health ;;
  *) die "Unknown command '$command' (schedule, now, list, verify, restore, health)." ;;
esac
