#!/usr/bin/env bash
# ==============================================================================
# Build the LibreDB Studio desktop AppImage (issue #232).
#
# The desktop shell (desktop/src-tauri, Tauri v2) is a thin native window that
# runs the SAME standalone server payload every other channel ships as a sidecar
# process. This script assembles the three pieces the bundler needs and renames
# the result to the repo's release-asset convention:
#
#   desktop/src-tauri/payload/            <- standalone payload (server.js + .next)
#   desktop/src-tauri/bin/node-<triple>   <- pinned, checksum-verified Node runtime
#   desktop/src-tauri/target/.../*.AppImage
#     -> <out>/libredb-studio-desktop-<version>-linux-<arch>.AppImage (+ .sha256)
#
# Usage: scripts/build-desktop-appimage.sh <output-dir> [options]
#
#   --payload <tarball>  reuse an existing standalone tarball
#                        (libredb-studio-standalone-<version>-linux-<arch>.tar.gz)
#                        instead of building one. This is what release CI does:
#                        the tarball is already built by the `build` job.
#   --smoke              after bundling, extract the AppImage and boot the
#                        payload's server from inside the extracted AppDir with
#                        the bundled node, requiring GET /api/db/health to return
#                        200. Proves the bundle is complete WITHOUT needing a
#                        display (the GUI itself is verified by hand / by the
#                        Flatpak E2E in docs/DISTRIBUTION.md).
#   --keep-stage         do not delete payload/ and bin/ afterwards (local dev:
#                        makes `bunx tauri dev` runnable straight after).
#
# Requirements: bun, node, cargo (Rust >= 1.88), and the Tauri Linux system deps
# (libwebkit2gtk-4.1-dev, libgtk-3-dev, libayatana-appindicator3-dev, librsvg2-dev,
# patchelf, file). See desktop/README.md.
# ==============================================================================

set -euo pipefail

# Prebuilt Tauri CLI (npm), pinned. Matches the tauri crate minor in
# desktop/src-tauri/Cargo.toml - bump both together.
TAURI_CLI_VERSION="2.11.4"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <output-dir> [--payload <tarball>] [--smoke] [--keep-stage]" >&2
  exit 1
fi

OUT_DIR="$1"
shift
PAYLOAD_TARBALL=""
RUN_SMOKE=false
KEEP_STAGE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --payload)
      PAYLOAD_TARBALL="${2:-}"
      if [ -z "$PAYLOAD_TARBALL" ]; then
        echo "--payload needs a tarball path" >&2
        exit 1
      fi
      shift 2
      ;;
    --smoke)
      RUN_SMOKE=true
      shift
      ;;
    --keep-stage)
      KEEP_STAGE=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
if [ -n "$PAYLOAD_TARBALL" ]; then
  PAYLOAD_TARBALL=$(cd "$(dirname "$PAYLOAD_TARBALL")" && pwd)/$(basename "$PAYLOAD_TARBALL")
fi

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

TAURI_DIR="$ROOT_DIR/desktop/src-tauri"
STAGE_PAYLOAD="$TAURI_DIR/payload"
STAGE_BIN="$TAURI_DIR/bin"

VERSION=$(node -p "require('./package.json').version")

case "$(uname -m)" in
  x86_64)
    ARCH=x64
    TRIPLE=x86_64-unknown-linux-gnu
    ;;
  aarch64 | arm64)
    ARCH=arm64
    TRIPLE=aarch64-unknown-linux-gnu
    ;;
  *)
    echo "Unsupported architecture '$(uname -m)' (expected x86_64 or aarch64)" >&2
    exit 1
    ;;
esac

ASSET="libredb-studio-desktop-${VERSION}-linux-${ARCH}.AppImage"

WORK_DIR=$(mktemp -d)
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
  if [ "$KEEP_STAGE" != "true" ]; then
    rm -rf "$STAGE_PAYLOAD" "$STAGE_BIN"
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------------------
# 1. Payload: reuse the release tarball when given, otherwise build one.
# ------------------------------------------------------------------------------
if [ -z "$PAYLOAD_TARBALL" ]; then
  echo "==> Building the standalone payload (no --payload given)"
  "$ROOT_DIR/scripts/build-standalone-payload.sh" "$WORK_DIR/dist"
  PAYLOAD_TARBALL="$WORK_DIR/dist/libredb-studio-standalone-${VERSION}-linux-${ARCH}.tar.gz"
fi
if [ ! -f "$PAYLOAD_TARBALL" ]; then
  echo "Payload tarball not found: $PAYLOAD_TARBALL" >&2
  exit 1
fi

echo "==> Staging payload from $(basename "$PAYLOAD_TARBALL")"
rm -rf "$STAGE_PAYLOAD"
mkdir -p "$STAGE_PAYLOAD"
tar -xzf "$PAYLOAD_TARBALL" -C "$STAGE_PAYLOAD" --strip-components=1
for required in server.js .next/BUILD_ID; do
  if [ ! -e "$STAGE_PAYLOAD/$required" ]; then
    echo "Staged payload is incomplete: $required is missing" >&2
    exit 1
  fi
done

# linuxdeploy walks every ELF file in the AppDir and treats an unresolvable
# dependency as fatal. sharp ships an Alpine build of libvips next to the glibc
# one, so the bundler dies on "Could not find dependency: libc.musl-x86_64.so.1".
# The musl variants can never load in a glibc bundle - drop them (also ~17 MB
# smaller). The release tarball keeps them; only this bundle is pruned.
rm -rf "$STAGE_PAYLOAD"/node_modules/@img/*musl*

# Turbopack resolves the externalized database drivers (pg, mysql2, mongodb,
# ssh2, better-sqlite3) through hashed SYMLINKS under .next/node_modules, and
# Tauri's resource copy silently drops symlinks: the directory is simply absent
# from the bundle and every request dies with
# "Failed to load external module ssh2-<hash>". Materialize them as real
# directories before bundling.
for link in "$STAGE_PAYLOAD"/.next/node_modules/*; do
  [ -L "$link" ] || continue
  target=$(readlink -f "$link")
  if [ ! -d "$target" ]; then
    echo "Staged payload has a dangling symlink: $link -> $target" >&2
    exit 1
  fi
  rm "$link"
  cp -R "$target" "$link"
done

# ------------------------------------------------------------------------------
# 2. Sidecar runtime: the same pinned, checksum-verified Node the .deb/.rpm and
#    snap packages bundle. Tauri's externalBin wants the target triple suffix.
# ------------------------------------------------------------------------------
echo "==> Bundling the pinned Node runtime as bin/node-${TRIPLE}"
rm -rf "$STAGE_BIN"
mkdir -p "$STAGE_BIN"
"$ROOT_DIR/packaging/linux/fetch-node.sh" "$WORK_DIR" "$ARCH"
install -m 0755 "$WORK_DIR/node/bin/node" "$STAGE_BIN/node-${TRIPLE}"

# ------------------------------------------------------------------------------
# 3. Bundle. Tauri reads the app version from the repo-root package.json (see
#    tauri.conf.json "version"), so the AppImage version always matches the
#    release version without a second place to bump.
# ------------------------------------------------------------------------------
echo "==> Bundling the AppImage (tauri-cli ${TAURI_CLI_VERSION}, ${TRIPLE})"
# linuxdeploy and appimagetool are themselves AppImages, so they mount
# themselves with FUSE - which neither the GitHub ubuntu runners nor most
# containers provide (no libfuse2). This tells them to self-extract instead;
# without it the bundler dies with a bare "failed to run linuxdeploy".
export APPIMAGE_EXTRACT_AND_RUN=1
BUNDLE_DIR="$TAURI_DIR/target/release/bundle/appimage"
# Resources are copied next to the built binary, then into a staging tree
# (bundle/appimage_deb), then into the AppDir - and none of those copies is ever
# pruned, so a file removed from payload/ survives in all of them and keeps being
# bundled. linuxdeploy walks every ELF file it finds in the AppDir, so one stale
# copy can fail the build for content that is no longer staged. Start clean.
rm -rf "$TAURI_DIR/target/release/bundle" "$TAURI_DIR/target/release/payload" \
  "$TAURI_DIR/target/release/node"
(cd "$TAURI_DIR" && bunx "@tauri-apps/cli@${TAURI_CLI_VERSION}" build --bundles appimage)

BUILT=$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' -print -quit)
if [ -z "$BUILT" ]; then
  echo "No AppImage was produced in $BUNDLE_DIR" >&2
  exit 1
fi

install -m 0755 "$BUILT" "$OUT_DIR/$ASSET"
(cd "$OUT_DIR" && sha256sum "$ASSET" > "${ASSET}.sha256")
echo "==> Wrote $OUT_DIR/$ASSET ($(du -h "$OUT_DIR/$ASSET" | cut -f1))"

# ------------------------------------------------------------------------------
# 4. Smoke: boot the bundled payload with the bundled node from the extracted
#    AppDir. Display-free, so it runs on any CI runner.
# ------------------------------------------------------------------------------
if [ "$RUN_SMOKE" = "true" ]; then
  echo "==> Smoke: extracting the AppImage"
  (cd "$WORK_DIR" && "$OUT_DIR/$ASSET" --appimage-extract > /dev/null)
  APPDIR="$WORK_DIR/squashfs-root"

  APPDIR_NODE=$(find "$APPDIR/usr" -maxdepth 3 -type f -name node -print -quit)
  APPDIR_PAYLOAD=$(find "$APPDIR/usr" -maxdepth 4 -type d -name payload -print -quit)
  if [ -z "$APPDIR_NODE" ] || [ -z "$APPDIR_PAYLOAD" ]; then
    echo "Smoke test FAILED: the AppImage is missing the node sidecar or the payload" >&2
    find "$APPDIR/usr" -maxdepth 3 >&2
    exit 1
  fi
  echo "==> Smoke: node at ${APPDIR_NODE#"$APPDIR"/}, payload at ${APPDIR_PAYLOAD#"$APPDIR"/}"

  # The payload directory is named after tauri.conf.json "productName". Keeping
  # it space-free is what lets the Flatpak manifest's build commands and these
  # scripts handle the path without quoting gymnastics.
  case "${APPDIR_PAYLOAD#"$APPDIR"/}" in
    *" "*)
      echo "Smoke test FAILED: the bundled payload path contains a space:" >&2
      echo "  ${APPDIR_PAYLOAD#"$APPDIR"/}" >&2
      echo "Keep tauri.conf.json productName free of spaces." >&2
      exit 1
      ;;
  esac

  # .next is a dotfile: resource globbing that drops hidden entries would leave
  # the server unable to boot ("Could not find a production build"). Check it
  # explicitly - the same trap snapcraft's filesets hit (snap/snapcraft.yaml).
  # .next/node_modules holds the externalized database drivers; it is absent when
  # the symlink materialization above is skipped or regresses, and then every
  # request fails with "Failed to load external module <driver>-<hash>".
  for required in server.js .next/BUILD_ID .next/node_modules seed-assets/sqlite/employee.db; do
    if [ ! -e "$APPDIR_PAYLOAD/$required" ]; then
      echo "Smoke test FAILED: bundled payload is missing $required" >&2
      exit 1
    fi
  done

  STORAGE_DIR="$WORK_DIR/storage"
  mkdir -p "$STORAGE_DIR"
  PORT=$(((RANDOM % 20000) + 20001))
  echo "==> Smoke: booting the bundled server on port $PORT"
  (
    cd "$APPDIR_PAYLOAD" && exec env \
      NODE_ENV=production \
      NEXT_TELEMETRY_DISABLED=1 \
      HOSTNAME=127.0.0.1 \
      PORT="$PORT" \
      STORAGE_PROVIDER=sqlite \
      STORAGE_SQLITE_PATH="$STORAGE_DIR/libredb-storage.db" \
      "$APPDIR_NODE" server.js
  ) > "$WORK_DIR/server.log" 2>&1 &
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
    cat "$WORK_DIR/server.log" >&2 || true
    exit 1
  fi
  echo "==> Smoke: /api/db/health returned 200"

  # The desktop shell relies on this file for the auth handoff (no password
  # prompt for a local instance), so the bundle must be able to produce it.
  if [ ! -f "$STORAGE_DIR/auth-bootstrap.json" ]; then
    echo "Smoke test FAILED: zero-config bootstrap did not write auth-bootstrap.json" >&2
    cat "$WORK_DIR/server.log" >&2 || true
    exit 1
  fi
  echo "==> Smoke: auth-bootstrap.json written (desktop auth handoff can read it)"
fi

echo "==> Done: $OUT_DIR/$ASSET"
