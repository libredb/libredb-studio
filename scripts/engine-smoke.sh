#!/usr/bin/env bash
# ==============================================================================
# Engine-matrix smoke: boot the standalone payload through the npx launcher
# (bin/studio.js --archive) on the CURRENT `node` and assert the runtime tier
# behaves as documented. This is what makes the package.json engines floor
# (>=20.9.0) a tested claim instead of a hope:
#
#   tier legacy20 (Node 20.9 - 22.12): server + login + embedded sample work;
#     launcher warns that all SQLite features are unavailable; a sqlite
#     connection fails with the node:sqlite guidance error.
#   tier node22 (Node 22.13 - 23.x): sqlite connections work (node:sqlite);
#     launcher warns about server-side SQLite storage; STORAGE_PROVIDER=sqlite
#     fails with the better-sqlite3 Node-24-ABI guard message.
#   tier node24 (Node >= 24): no launcher warning; everything works,
#     including STORAGE_PROVIDER=sqlite.
#
# Usage: scripts/engine-smoke.sh <payload-tarball> <legacy20|node22|node24>
#   PORT (default 3105) and PORT+1 must be free.
#
# Used by the engine-smoke job in .github/workflows/ci.yml; runs locally too
# (e.g. inside `docker run node:20.9` with the repo and tarball mounted).
# ==============================================================================
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <payload-tarball> <legacy20|node22|node24>" >&2
  exit 1
fi

TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
TIER=$2
case "$TIER" in legacy20 | node22 | node24) ;; *)
  echo "Unknown tier '$TIER' (expected legacy20|node22|node24)" >&2
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
LAUNCHER_LOG=$(cat "$LOG")

case "$TIER" in
  legacy20)
    check "launcher warns that SQLite features are unavailable" "$LAUNCHER_LOG" "SQLite features are unavailable"
    check "sqlite connection fails with node:sqlite guidance" "$SQLITE_BODY" "node:sqlite"
    check_absent "sqlite query returns no rows" "$SQLITE_BODY" '"a":42'
    ;;
  node22)
    check "launcher warns about server-side SQLite storage only" "$LAUNCHER_LOG" "server-side SQLite storage"
    check_absent "launcher does not claim SQLite features are unavailable" "$LAUNCHER_LOG" "SQLite features are unavailable"
    check "sqlite connection works via node:sqlite" "$SQLITE_BODY" '"a":42'
    ;;
  node24)
    check_absent "launcher prints no runtime warning" "$LAUNCHER_LOG" "SQLite features are unavailable"
    check_absent "launcher prints no storage warning" "$LAUNCHER_LOG" "server-side SQLite storage"
    check "sqlite connection works" "$SQLITE_BODY" '"a":42'
    ;;
esac

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ------------------------------------------------------------------------------
# Server 2: STORAGE_PROVIDER=sqlite exercises the bundled better-sqlite3
# binding (Node 24 ABI) - the guard must translate the ABI mismatch on older
# runtimes into the actionable message from src/lib/storage/providers/sqlite.ts.
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

if [ "$TIER" = "node24" ]; then
  check "server-side SQLite storage works" "$STORAGE_BODY" '"ok":true'
else
  check "storage guard explains the Node 24 ABI requirement" "$STORAGE_BODY" "requires Node.js 24+"
  check "storage guard suggests alternatives" "$STORAGE_BODY" "STORAGE_PROVIDER=postgres"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "==> engine-smoke FAILED (${FAILURES} assertion(s)) for tier ${TIER}" >&2
  exit 1
fi
echo "==> engine-smoke OK for tier ${TIER} on node $(node --version)"
