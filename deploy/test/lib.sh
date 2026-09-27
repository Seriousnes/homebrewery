# Helpers for the operations tests (deploy/scripts/test-*.sh). Source it; needs bash, curl and perl (JSON::PP is a
# core module; Git for Windows ships both).

# Git Bash: pass /opt/..., /backups/... to docker unchanged (but keep converting paths for curl and friends).
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }
export -f docker

# This worktree's slot (web/scripts/worktree.ts; 0 in the main checkout or without node): the tests' default project,
# container, volume and network names get the suffix -<slot> and their port moves by 1000 per slot, so the ops tests of
# two worktrees never share anything.
HB_SLOT=${HB_SLOT:-$(node deploy/stack/stack.mjs slot 2>/dev/null || echo 0)}
if ((HB_SLOT > 0)); then HB_SLOT_SUFFIX=-$HB_SLOT; else HB_SLOT_SUFFIX=; fi
HB_SLOT_TEST_PORT=$((5478 + HB_SLOT * 1000))

PASSED=0
FAILED=0

step() { printf '\n== %s\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$*"; }

# check <description> <command...>: pass when the command succeeds.
check() {
  local description=$1; shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}

# expect_eq <description> <expected> <actual>
expect_eq() {
  if [[ $2 == "$3" ]]; then pass "$1 ($3)"; else fail "$1: expected '$2', got '$3'"; fi
}

summary() {
  printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
  ((FAILED == 0))
}

# json <field path> <<< '{"a":{"b":1}}'   -> 1   (dot-separated keys; empty when missing)
json() {
  perl -MJSON::PP -0777 -e '
    my $v = eval { JSON::PP->new->decode(scalar <STDIN>) };
    for my $k (split /\./, $ARGV[0]) { $v = ref $v eq "HASH" ? $v->{$k} : ref $v eq "ARRAY" ? $v->[$k] : undef }
    print defined $v ? (ref $v ? JSON::PP->new->canonical->encode($v) : $v) : "";' "$1"
}

# json_lines_report: reads log lines on stdin and prints "<lines> <non-json> <non-utc> <requests> <request-path-scopes>".
json_lines_report() {
  perl -MJSON::PP -ne '
    next unless /\S/;
    $n++;
    my $e = eval { JSON::PP->new->decode($_) };
    if (!$e || ref $e ne "HASH") { $bad++; next }
    $utc++ unless ($e->{Timestamp} // "") =~ /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    $req++ if ($e->{Category} // "") eq "Homebrewery.Api.Infrastructure.RequestLogging";
    for my $s (@{ $e->{Scopes} // [] }) { $path++ if ref $s eq "HASH" && exists $s->{RequestPath} }
    END { printf "%d %d %d %d %d\n", $n, $bad // 0, $utc // 0, $req // 0, $path // 0 }'
}

# HTTP against BASE_URL with a cookie jar per user. Writes send Origin (SameOriginWriteGuard).
# http <jar> <method> <path> [json body]  -> sets HTTP_STATUS and HTTP_BODY (no output, so call it directly, not in $(...))
http() {
  local jar=$1 method=$2 path=$3 body=${4:-}
  local out
  out=$(mktemp)
  local args=(--silent --show-error --max-time 30 --output "$out" --write-out '%{http_code}' --cookie "$jar" --cookie-jar "$jar"
    --request "$method" --header "Origin: $BASE_URL")
  if [[ -n $body ]]; then args+=(--header 'Content-Type: application/json' --data "$body"); fi
  HTTP_STATUS=$(curl "${args[@]}" "$BASE_URL$path") || HTTP_STATUS=000
  HTTP_BODY=$(cat "$out")
  rm -f "$out"
}

# wait_healthy <url> <seconds>
wait_healthy() {
  local url=$1 deadline=$((SECONDS + $2))
  while ((SECONDS < deadline)); do
    if [[ $(curl --silent --output /dev/null --max-time 5 --write-out '%{http_code}' "$url" || true) == 200 ]]; then return 0; fi
    sleep 2
  done
  return 1
}

# register_and_sign_in <jar> <email> <password>: POST /api/auth/register, then /api/auth/login?useCookies=true.
register_and_sign_in() {
  http "$1" POST /api/auth/register "{\"email\":\"$2\",\"password\":\"$3\"}" >/dev/null
  [[ $HTTP_STATUS == 200 ]] || { echo "register $2: HTTP $HTTP_STATUS" >&2; return 1; }
  sign_in "$@"
}

sign_in() {
  http "$1" POST '/api/auth/login?useCookies=true' "{\"email\":\"$2\",\"password\":\"$3\"}" >/dev/null
  [[ $HTTP_STATUS == 200 ]]
}

random_id() { printf '%s%04x%04x' "$(date +%s)" "$RANDOM" "$RANDOM"; }
