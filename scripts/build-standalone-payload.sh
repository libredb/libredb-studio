#!/usr/bin/env bash
# ==============================================================================
# Build the standalone Next.js server payload for the current platform.
#
# Single source of truth for release tarballs: used locally and by
# .github/workflows/release-artifacts.yml. The payload mirrors EXACTLY what
# the Dockerfile runner stage copies (keep the two in sync):
#   - .next/standalone/*            -> payload root (server.js + traced deps)
#   - .next/static                  -> .next/static
#   - public                        -> public
#   - node_modules/better-sqlite3   -> native binding for server storage
#   - node_modules/bindings         -> better-sqlite3 runtime dependency
#   - node_modules/file-uri-to-path -> bindings runtime dependency
#   - node_modules/@libredb/libredb -> lazy-imported, not seen by file tracing
#   - data/                         -> default SQLite storage directory
#
# Usage: scripts/build-standalone-payload.sh <output-dir> [--smoke]
#
#   <output-dir>  where the tarball is written:
#                 libredb-studio-standalone-<version>-<os>-<arch>.tar.gz
#   --smoke       after packing, extract the tarball to a temp dir, boot
#                 `node server.js` on a random port with a temp
#                 STORAGE_SQLITE_PATH and require GET /api/db/health to
#                 return 200 within ~30s.
# ==============================================================================

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <output-dir> [--smoke]" >&2
  exit 1
fi

OUT_DIR="$1"
RUN_SMOKE=false
if [ "${2:-}" = "--smoke" ]; then
  RUN_SMOKE=true
elif [ $# -gt 1 ]; then
  echo "Unknown argument: $2" >&2
  exit 1
fi

# Resolve the output dir against the caller's cwd before changing directory.
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

VERSION=$(node -p "require('./package.json').version")

case "$(node -p 'process.platform')" in
  linux) OS=linux ;;
  darwin) OS=darwin ;;
  *)
    echo "Unsupported platform '$(node -p 'process.platform')' (expected linux or darwin)" >&2
    exit 1
    ;;
esac

case "$(node -p 'process.arch')" in
  x64) ARCH=x64 ;;
  arm64) ARCH=arm64 ;;
  *)
    echo "Unsupported architecture '$(node -p 'process.arch')' (expected x64 or arm64)" >&2
    exit 1
    ;;
esac

TARBALL="libredb-studio-standalone-${VERSION}-${OS}-${ARCH}.tar.gz"

STAGE_DIR=$(mktemp -d)
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

# ------------------------------------------------------------------------------
# Build. DOCKER_BUILD=true switches next.config.ts to `output: "standalone"`.
# The placeholder secrets mirror the Dockerfile build args: they only satisfy
# build-time page data collection and are never baked into server behaviour -
# real values are provided at runtime.
# ------------------------------------------------------------------------------
export JWT_SECRET="${JWT_SECRET:-build-time-placeholder-secret-32ch}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-build}"
export USER_PASSWORD="${USER_PASSWORD:-build}"
echo "==> Building standalone server (version ${VERSION}, ${OS}-${ARCH})"
NEXT_TELEMETRY_DISABLED=1 DOCKER_BUILD=true bun run build

if [ ! -f .next/standalone/server.js ]; then
  echo "Standalone output missing (.next/standalone/server.js) - is DOCKER_BUILD=true wired in next.config.ts?" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# Assemble the payload (mirrors the Dockerfile runner stage COPY steps).
# ------------------------------------------------------------------------------
PAYLOAD_DIR="$STAGE_DIR/payload"
mkdir -p "$PAYLOAD_DIR"

cp -R .next/standalone/. "$PAYLOAD_DIR/"
# Ship an empty data/ dir (the default SQLite storage location). Output file
# tracing can pull git-ignored local dev databases (data/*.libredb, *.db)
# into .next/standalone - never leak those into a distributable tarball. A CI
# checkout is clean, so this only affects local builds.
rm -rf "${PAYLOAD_DIR:?}/data"
mkdir -p "$PAYLOAD_DIR/.next" "$PAYLOAD_DIR/data"
rm -rf "$PAYLOAD_DIR/.next/static"
cp -R .next/static "$PAYLOAD_DIR/.next/static"
rm -rf "$PAYLOAD_DIR/public"
cp -R public "$PAYLOAD_DIR/public"

# Never ship local env files (the Docker build excludes them via .dockerignore,
# but `next build` copies any .env* it finds into the standalone output).
rm -f "$PAYLOAD_DIR"/.env "$PAYLOAD_DIR"/.env.*

for pkg in better-sqlite3 bindings file-uri-to-path; do
  if [ ! -d "node_modules/$pkg" ]; then
    echo "node_modules/$pkg not found - run 'bun install --frozen-lockfile' first" >&2
    exit 1
  fi
done

# The payload runs under `node`, so the better-sqlite3 native binding must
# match node's ABI - not the ABI of whatever runtime happened to install it
# (bun-compiled or stale bindings fail with ERR_DLOPEN_FAILED). Probe with an
# actual Database construction (a bare require does not dlopen the binding)
# and rebuild against the current node if it does not load.
if ! node -e "require('./node_modules/better-sqlite3')(':memory:').close()" 2>/dev/null; then
  echo "==> better-sqlite3 binding does not load under $(node --version) - rebuilding"
  npm rebuild better-sqlite3
  node -e "require('./node_modules/better-sqlite3')(':memory:').close()"
fi

for pkg in better-sqlite3 bindings file-uri-to-path; do
  rm -rf "${PAYLOAD_DIR:?}/node_modules/$pkg"
  cp -R "node_modules/$pkg" "$PAYLOAD_DIR/node_modules/$pkg"
done

if [ ! -d node_modules/@libredb/libredb ]; then
  echo "node_modules/@libredb/libredb not found - run 'bun install --frozen-lockfile' first" >&2
  exit 1
fi
mkdir -p "$PAYLOAD_DIR/node_modules/@libredb"
rm -rf "$PAYLOAD_DIR/node_modules/@libredb/libredb"
cp -R node_modules/@libredb/libredb "$PAYLOAD_DIR/node_modules/@libredb/libredb"

echo "==> Packing $TARBALL"
tar -czf "$OUT_DIR/$TARBALL" -C "$PAYLOAD_DIR" .
echo "==> Wrote $OUT_DIR/$TARBALL ($(du -h "$OUT_DIR/$TARBALL" | cut -f1))"

# ------------------------------------------------------------------------------
# Smoke test: extract the tarball we just produced (not the staging dir), boot
# the server, and require GET /api/db/health to answer 200 within ~30s.
# ------------------------------------------------------------------------------
if [ "$RUN_SMOKE" = "true" ]; then
  SMOKE_DIR="$STAGE_DIR/smoke"
  STORAGE_DIR="$STAGE_DIR/storage"
  mkdir -p "$SMOKE_DIR" "$STORAGE_DIR"
  tar -xzf "$OUT_DIR/$TARBALL" -C "$SMOKE_DIR"

  echo "==> Smoke: better-sqlite3 native binding loads"
  (cd "$SMOKE_DIR" && node -e "const db = require('better-sqlite3')('$STORAGE_DIR/probe.db'); db.exec('CREATE TABLE t (id INTEGER)'); db.close();")

  PORT=$(( (RANDOM % 20000) + 20001 ))
  echo "==> Smoke: booting node server.js on port $PORT"
  (
    cd "$SMOKE_DIR" && exec env \
      NODE_ENV=production \
      NEXT_TELEMETRY_DISABLED=1 \
      HOSTNAME=127.0.0.1 \
      PORT="$PORT" \
      STORAGE_PROVIDER=sqlite \
      STORAGE_SQLITE_PATH="$STORAGE_DIR/storage.db" \
      node server.js
  ) >"$STAGE_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  HEALTHY=false
  for _ in $(seq 1 30); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/db/health" || true)
    if [ "$CODE" = "200" ]; then
      HEALTHY=true
      break
    fi
    sleep 1
  done

  if [ "$HEALTHY" != "true" ]; then
    echo "Smoke test FAILED: /api/db/health did not return 200 within 30s" >&2
    echo "---- server.log ----" >&2
    cat "$STAGE_DIR/server.log" >&2 || true
    exit 1
  fi

  echo "==> Smoke: /api/db/health returned 200"
fi

echo "==> Done: $OUT_DIR/$TARBALL"
