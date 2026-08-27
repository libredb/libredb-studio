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
#                                      (self-contained since v13: N-API
#                                      prebuilds live inside the package)
#   - node_modules/@libredb/libredb -> lazy-imported, not seen by file tracing
#   - node_modules/@duckdb          -> the DuckDB driver, all of it: the API
#                                      package, the binding loader and the
#                                      per-platform bindings package holding
#                                      duckdb.node + libduckdb.so
#   - node_modules/detect-libc      -> what the DuckDB binding loader uses to
#                                      pick between a glibc and a musl package
#   - seed-assets/                  -> vendored sample DB templates (fs-read
#                                      at runtime, not seen by file tracing)
#   - data/                         -> default SQLite storage directory
#
# Usage: scripts/build-standalone-payload.sh <output-dir> [--smoke]
#
#   <output-dir>  where the archive is written:
#                 libredb-studio-standalone-<version>-<os>-<arch>.tar.gz
#                 (.zip on win32, issue #114).
#                 Tarball entries are rooted under a top-level
#                 libredb-studio-<version>/ directory (issue #133) - extract
#                 with --strip-components=1 (scripts/lib/pack-standalone-tarball.sh).
#                 The win32 zip is FLAT (no versioned root) so winget's
#                 NestedInstallerFiles paths stay stable across versions
#                 (scripts/lib/pack-standalone-zip.sh).
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
  win32) OS=win32 ;;
  *)
    echo "Unsupported platform '$(node -p 'process.platform')' (expected linux, darwin, or win32)" >&2
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

if [ "$OS" = "win32" ] && [ "$ARCH" != "x64" ]; then
  echo "Unsupported Windows architecture '$ARCH' (only win32-x64 is released, issue #114)" >&2
  exit 1
fi

# POSIX targets ship a tar.gz rooted under libredb-studio-<version>/ (issue
# #133); win32 ships a FLAT .zip (issue #114) - winget extracts it in place
# and NestedInstallerFiles.RelativeFilePath must stay stable across versions,
# so the zip has no versioned root directory.
if [ "$OS" = "win32" ]; then
  ARCHIVE="libredb-studio-standalone-${VERSION}-${OS}-${ARCH}.zip"
else
  ARCHIVE="libredb-studio-standalone-${VERSION}-${OS}-${ARCH}.tar.gz"
fi

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
# Output file tracing sweeps the repo root, dragging non-runtime extras
# (docs/, charts/, e2e/, tests/, CLAUDE.md, bun.lock, deploy manifests) into
# .next/standalone (issue #124) - prune them before anything downstream
# consumes the payload.
"$ROOT_DIR/scripts/lib/prune-standalone-payload.sh" "$PAYLOAD_DIR"
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

if [ ! -d "node_modules/better-sqlite3" ]; then
  echo "node_modules/better-sqlite3 not found - run 'bun install --frozen-lockfile' first" >&2
  exit 1
fi

# Probe the native binding with an actual Database construction (a bare require
# does not dlopen it). better-sqlite3 v13 is N-API, so this no longer guards an
# ABI mismatch between the installing runtime and `node` - that class of failure
# is gone. What it still catches is a tree with no loadable prebuild for this
# platform: an incomplete install, or a target the package does not cover.
#
# There is deliberately no automatic rebuild here. Under v12 the fallback was
# `npm rebuild better-sqlite3`, which worked because the package declared
# `install: prebuild-install || node-gyp rebuild`. v13 declares no install
# lifecycle and sets `gypfile: false`, so npm queues no node-gyp command and the
# same call now reports "rebuilt dependencies successfully" while building
# nothing - a silent no-op that would hide this failure behind a bare Node stack
# trace on the next line. Automating a real source build instead would put
# python3 and a C++ toolchain on the macOS and Windows release runners to
# recover a case that cannot arise on a complete install: v13 prebuilds every
# target this script accepts (linux/darwin x64+arm64, win32-x64). So: fail with
# the diagnosis and hand over the one-off command.
if ! node -e "require('./node_modules/better-sqlite3')(':memory:').close()" 2>/dev/null; then
  TARGET="$(node -p 'process.platform')-$(node -p 'process.arch')"
  echo "better-sqlite3 has no loadable prebuild for ${TARGET} under $(node --version)." >&2
  echo "Since v13 the package ships an N-API prebuild for every target this script accepts," >&2
  echo "so this normally means an incomplete node_modules - reinstall with 'bun install --frozen-lockfile'." >&2
  echo "On a target the package genuinely does not cover, build the binding once by hand:" >&2
  echo "  npm exec node-gyp -- rebuild --directory node_modules/better-sqlite3" >&2
  exit 1
fi

rm -rf "${PAYLOAD_DIR:?}/node_modules/better-sqlite3"
cp -R "node_modules/better-sqlite3" "$PAYLOAD_DIR/node_modules/better-sqlite3"

if [ ! -d node_modules/@libredb/libredb ]; then
  echo "node_modules/@libredb/libredb not found - run 'bun install --frozen-lockfile' first" >&2
  exit 1
fi
mkdir -p "$PAYLOAD_DIR/node_modules/@libredb"
rm -rf "$PAYLOAD_DIR/node_modules/@libredb/libredb"
cp -R node_modules/@libredb/libredb "$PAYLOAD_DIR/node_modules/@libredb/libredb"

# The DuckDB driver: the whole @duckdb scope, never one directory of it.
# @duckdb/node-bindings resolves the addon with a bare top-level
# `require('@duckdb/node-bindings-<platform>-<arch>/duckdb.node')` executed at
# module load - there is no lazy path and no graceful degradation - and that
# addon has NEEDED libduckdb.so with RUNPATH $ORIGIN, so the ~70 MB library has
# to travel in the same directory. Copying the scope wholesale is also the
# arch-safe form: the install picks whichever optional bindings package matches
# this platform. detect-libc is the loader's own dependency (see the Dockerfile
# runner stage, which this mirrors).
if [ ! -d node_modules/@duckdb/node-api ]; then
  echo "node_modules/@duckdb/node-api not found - run 'bun install --frozen-lockfile' first" >&2
  exit 1
fi
# Stat-ing the directory proves nothing here: the failure mode is a scope with
# no bindings package for this platform, which only shows up on require.
if ! node -e "require('@duckdb/node-api')" 2>/dev/null; then
  TARGET="$(node -p 'process.platform')-$(node -p 'process.arch')"
  echo "@duckdb/node-api does not load for ${TARGET} under $(node --version)." >&2
  echo "The binding lives in a separate optional package (@duckdb/node-bindings-${TARGET}), so this" >&2
  echo "normally means an incomplete node_modules - reinstall with 'bun install --frozen-lockfile'." >&2
  exit 1
fi
rm -rf "${PAYLOAD_DIR:?}/node_modules/@duckdb"
cp -R node_modules/@duckdb "$PAYLOAD_DIR/node_modules/@duckdb"
rm -rf "${PAYLOAD_DIR:?}/node_modules/detect-libc"
cp -R node_modules/detect-libc "$PAYLOAD_DIR/node_modules/detect-libc"

# Vendored sample database templates (seed-assets/): read at runtime relative
# to the payload root, so output file tracing never includes them — copy
# explicitly (mirrors the Dockerfile runner stage COPY).
if [ ! -f seed-assets/sqlite/employee.db ]; then
  echo "seed-assets/sqlite/employee.db not found - the repo checkout is incomplete" >&2
  exit 1
fi
rm -rf "$PAYLOAD_DIR/seed-assets"
cp -R seed-assets "$PAYLOAD_DIR/seed-assets"

echo "==> Packing $ARCHIVE"
if [ "$OS" = "win32" ]; then
  # Flat zip (issue #114): entries at the archive root, no versioned wrapper.
  "$ROOT_DIR/scripts/lib/pack-standalone-zip.sh" "$PAYLOAD_DIR" "$OUT_DIR/$ARCHIVE"
else
  # Wraps PAYLOAD_DIR in a top-level libredb-studio-<version>/ root instead of
  # a tarbomb (issue #133); consumers extract with --strip-components=1.
  "$ROOT_DIR/scripts/lib/pack-standalone-tarball.sh" "$PAYLOAD_DIR" "$VERSION" "$OUT_DIR/$ARCHIVE"
fi
echo "==> Wrote $OUT_DIR/$ARCHIVE ($(du -h "$OUT_DIR/$ARCHIVE" | cut -f1))"

# ------------------------------------------------------------------------------
# Smoke test: extract the tarball we just produced (not the staging dir), boot
# the server, and require GET /api/db/health to answer 200 within ~30s.
# ------------------------------------------------------------------------------
if [ "$RUN_SMOKE" = "true" ]; then
  SMOKE_DIR="$STAGE_DIR/smoke"
  STORAGE_DIR="$STAGE_DIR/storage"
  mkdir -p "$SMOKE_DIR" "$STORAGE_DIR"
  # The native node.exe on Windows cannot resolve Git Bash's POSIX-style
  # mktemp paths (/tmp/... would land on the current drive root), so every
  # path handed to node goes through cygpath there; NODE_STORAGE_DIR stays
  # the plain POSIX path everywhere else.
  NODE_STORAGE_DIR="$STORAGE_DIR"
  if [ "$OS" = "win32" ]; then
    NODE_STORAGE_DIR="$(cygpath -w "$STORAGE_DIR")"
    # Flat zip: nothing to strip. Use the System32 bsdtar explicitly - it
    # reads zip natively, while Git Bash's own `tar` is GNU tar (no zip).
    # Env-var casing differs between shells (SystemRoot vs SYSTEMROOT).
    "${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}/System32/tar.exe" -xf "$OUT_DIR/$ARCHIVE" -C "$SMOKE_DIR"
  else
    tar -xzf "$OUT_DIR/$ARCHIVE" -C "$SMOKE_DIR" --strip-components=1
  fi

  echo "==> Smoke: better-sqlite3 native binding loads"
  (cd "$SMOKE_DIR" && NODE_PROBE_DB="$NODE_STORAGE_DIR/probe.db" node -e "const db = require('better-sqlite3')(process.env.NODE_PROBE_DB); db.exec('CREATE TABLE t (id INTEGER)'); db.close();")

  # Same probe for the second native module, run against the EXTRACTED tarball
  # rather than the staging dir: a copy that dropped libduckdb.so, or an archive
  # step that dropped the platform bindings package, fails here and nowhere else
  # until a user opens a DuckDB connection.
  echo "==> Smoke: @duckdb/node-api native binding loads"
  (cd "$SMOKE_DIR" && node -e "const { DuckDBInstance } = require('@duckdb/node-api'); DuckDBInstance.create(':memory:').then((i) => i.connect()).then((c) => c.runAndReadAll('SELECT 42 AS a')).then((r) => { if (r.getRowObjectsJson()[0].a !== 42) { throw new Error('unexpected DuckDB result'); } });")

  PORT=$(( (RANDOM % 20000) + 20001 ))
  echo "==> Smoke: booting node server.js on port $PORT"
  (
    cd "$SMOKE_DIR" && exec env \
      NODE_ENV=production \
      NEXT_TELEMETRY_DISABLED=1 \
      HOSTNAME=127.0.0.1 \
      PORT="$PORT" \
      STORAGE_PROVIDER=sqlite \
      STORAGE_SQLITE_PATH="$NODE_STORAGE_DIR/storage.db" \
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

  # The embedded SQLite sample seeds asynchronously after boot: the vendored
  # template must have shipped in the payload and the copy must land in the
  # data dir. This catches a payload missing seed-assets/ on every platform
  # without needing a browser (the full Playwright gate is
  # scripts/channel-embedded-sample-e2e.sh).
  SAMPLE_SEEDED=false
  for _ in $(seq 1 30); do
    if [ -f "$STORAGE_DIR/sample-employees.db" ]; then
      SAMPLE_SEEDED=true
      break
    fi
    sleep 1
  done
  if [ "$SAMPLE_SEEDED" != "true" ]; then
    echo "Smoke test FAILED: embedded SQLite sample was not seeded within 30s" >&2
    echo "---- server.log ----" >&2
    cat "$STAGE_DIR/server.log" >&2 || true
    exit 1
  fi
  echo "==> Smoke: embedded SQLite sample seeded"
fi

echo "==> Done: $OUT_DIR/$ARCHIVE"
