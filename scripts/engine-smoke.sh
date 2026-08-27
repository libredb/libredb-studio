#!/usr/bin/env bash
# ==============================================================================
# Engine-matrix smoke: boot the standalone payload through the npx launcher
# (bin/studio.js --archive) on the CURRENT `node` and assert the runtime tier
# behaves as documented. This is what makes the package.json engines floor
# (>=24.0.0, issue #326) a tested claim instead of a hope:
#
#   tier node24 (Node 24 LTS, the reference runtime the payload is built on)
#   tier node26 (the current upper release)
#
# Both tiers assert the SAME outcome - no launcher warning, everything works,
# including STORAGE_PROVIDER=sqlite. That is the point of the node26 leg: the
# payload is built on Node 24, so a green node26 run proves the payload's two
# native modules - better-sqlite3 (N-API since v13) and the DuckDB driver's
# @duckdb/node-bindings addon - are genuinely ABI-independent. Under
# better-sqlite3 v12's per-ABI binding this leg could not have passed.
#
# Both are exercised, not just asserted in prose: STORAGE_PROVIDER=sqlite drives
# the first and a DuckDB query drives the second.
#
# Runtimes below the floor are not a tier here: `npx` never reaches this script
# on them. npm's version picker silently resolves the newest ENGINE-COMPATIBLE
# release instead, so a Node 22 user lands on the last <24 release rather than
# on a preflight error. npx-engine-smoke.yml asserts that pinning behaviour
# against the live registry; the launcher's own refusal path is unit-tested in
# tests/unit/launcher-utils.test.ts.
#
# Usage: scripts/engine-smoke.sh <payload-tarball> <node24|node26>
#   PORT (default 3105) and PORT+1 must be free.
#
# Used by the engine-smoke job in .github/workflows/ci.yml; runs locally too
# (e.g. inside `docker run node:26-trixie-slim` with the repo and tarball
# mounted).
# ==============================================================================
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <payload-tarball> <node24|node26>" >&2
  exit 1
fi

TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
TIER=$2
case "$TIER" in node24 | node26) ;; *)
  echo "Unknown tier '$TIER' (expected node24|node26)" >&2
  exit 1
  ;;
esac

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-3105}
STORAGE_PORT=$((PORT + 1))
BASE="http://127.0.0.1:${PORT}"
STORAGE_BASE="http://127.0.0.1:${STORAGE_PORT}"

WORK=$(mktemp -d)
SERVER_PID=""
STORAGE_SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$STORAGE_SERVER_PID" ] && kill "$STORAGE_SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> engine-smoke: node $(node --version), tier ${TIER}"

FAILURES=0
check() { # check <description> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 - expected to find '$3' in:" >&2
    printf '%s\n' "$2" | head -8 >&2
    FAILURES=$((FAILURES + 1))
  fi
}
check_absent() { # check_absent <description> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    echo "FAIL: $1 - did not expect '$3' in:" >&2
    printf '%s\n' "$2" | head -8 >&2
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $1"
  fi
}

# Isolate the launcher cache and force the zero-config path: HOME points into
# the temp dir and no auth/storage env leaks in from the CI job environment.
LAUNCH_ENV=(env -u JWT_SECRET -u ADMIN_PASSWORD -u USER_PASSWORD -u AUTH_BOOTSTRAP -u STORAGE_PROVIDER -u STORAGE_SQLITE_PATH -u HOSTNAME "HOME=$WORK")

start_server() { # start_server <log> <port> [extra env KEY=VALUE...]
  local log=$1 port=$2
  shift 2
  "${LAUNCH_ENV[@]}" "$@" node "$ROOT_DIR/bin/studio.js" --archive "$TARBALL" --port "$port" --host 127.0.0.1 >"$log" 2>&1 &
}

wait_health() { # wait_health <base-url> <log>
  for _ in $(seq 1 90); do
    if curl -sf -o /dev/null "$1/api/db/health"; then return 0; fi
    sleep 1
  done
  echo "FAIL: server on $1 never became healthy; log:" >&2
  cat "$2" >&2
  exit 1
}

login() { # login <base-url> <password> <cookie-jar> -> body
  curl -s -c "$3" -X POST "$1/api/auth/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"admin@libredb.org\",\"password\":\"$2\"}"
}

# ------------------------------------------------------------------------------
# Server 1: zero-config boot, login, embedded sample, sqlite connection tier.
# ------------------------------------------------------------------------------
LOG="$WORK/studio.log"
start_server "$LOG" "$PORT"
SERVER_PID=$!
wait_health "$BASE" "$LOG"
echo "PASS: health 200 on Node $(node --version)"

PASSWORD=$(sed -n 's/^ Password: //p' "$LOG" | head -1)
if [ -z "$PASSWORD" ]; then
  echo "FAIL: no zero-config password banner in the launcher log:" >&2
  cat "$LOG" >&2
  exit 1
fi
LOGIN_BODY=$(login "$BASE" "$PASSWORD" "$WORK/cookies.txt")
check "zero-config login succeeds" "$LOGIN_BODY" '"success":true'

SAMPLE_BODY=$(curl -s -b "$WORK/cookies.txt" -X POST "$BASE/api/db/query" -H "Content-Type: application/json" \
  -d '{"connectionId":"seed:libredb-embedded-sample","sql":"prefix users:"}')
check "embedded sample query returns seeded rows" "$SAMPLE_BODY" "Ada"

SQLITE_BODY=$(curl -s -b "$WORK/cookies.txt" -X POST "$BASE/api/db/query" -H "Content-Type: application/json" \
  -d "{\"connection\":{\"id\":\"engine-smoke\",\"type\":\"sqlite\",\"name\":\"engine-smoke\",\"database\":\"$WORK/smoke.db\"},\"sql\":\"SELECT 41+1 AS a\"}")
# The payload's second native module. sqlite above runs on node:sqlite, a
# builtin, so without this the DuckDB binding would only be asserted in prose -
# and the node26 tier is precisely where an ABI-bound addon would fail.
DUCKDB_BODY=$(curl -s -b "$WORK/cookies.txt" -X POST "$BASE/api/db/query" -H "Content-Type: application/json" \
  -d "{\"connection\":{\"id\":\"engine-smoke-duckdb\",\"type\":\"duckdb\",\"name\":\"engine-smoke-duckdb\",\"database\":\"$WORK/smoke.duckdb\"},\"sql\":\"SELECT 41+1 AS a\"}")
LAUNCHER_LOG=$(cat "$LOG")

check_absent "launcher prints no runtime warning" "$LAUNCHER_LOG" "STORAGE_PROVIDER=sqlite"
check "sqlite connection works via node:sqlite" "$SQLITE_BODY" '"a":42'
check "duckdb connection works via @duckdb/node-api" "$DUCKDB_BODY" '"a":42'

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ------------------------------------------------------------------------------
# Server 2: STORAGE_PROVIDER=sqlite exercises the bundled better-sqlite3
# binding. On the node26 tier this is the assertion that carries the weight -
# the binding shipped inside a payload built on Node 24 has to load and serve
# writes on a different Node major.
# ------------------------------------------------------------------------------
LOG2="$WORK/studio-storage.log"
start_server "$LOG2" "$STORAGE_PORT" env "STORAGE_PROVIDER=sqlite" "STORAGE_SQLITE_PATH=$WORK/storage.db"
STORAGE_SERVER_PID=$!
wait_health "$STORAGE_BASE" "$LOG2"

# --archive re-extracts the payload per boot, wiping payload data, so this
# boot generated FRESH credentials (issue #132 tracks that wipe). If #132
# changes --archive to preserve payload data, reuse $PASSWORD here instead -
# the banner parse below would come up empty and abort with a confusing
# "no zero-config password banner".
PASSWORD2=$(sed -n 's/^ Password: //p' "$LOG2" | head -1)
login "$STORAGE_BASE" "$PASSWORD2" "$WORK/cookies2.txt" >/dev/null
STORAGE_BODY=$(curl -s -b "$WORK/cookies2.txt" -X PUT "$STORAGE_BASE/api/storage/connections" \
  -H "Content-Type: application/json" -d '{"data":[]}')

check "server-side SQLite storage works" "$STORAGE_BODY" '"ok":true'

if [ "$FAILURES" -gt 0 ]; then
  echo "==> engine-smoke FAILED (${FAILURES} assertion(s)) for tier ${TIER}" >&2
  exit 1
fi
echo "==> engine-smoke OK for tier ${TIER} on node $(node --version)"
