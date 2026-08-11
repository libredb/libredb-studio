#!/usr/bin/env bash
# ==============================================================================
# Build the LibreDB Studio desktop Linux artifacts (issues #232, #241).
#
# The desktop shell (desktop/src-tauri, Tauri v2) is a thin native window that
# runs the SAME standalone server payload every other channel ships as a sidecar
# process. This script assembles the three pieces the bundler needs and renames
# the results to the repo's release-asset convention:
#
#   desktop/src-tauri/payload/            <- standalone payload (server.js + .next)
#   desktop/src-tauri/bin/libredb-studio-node-<triple>
#                                         <- pinned, checksum-verified Node runtime
#   desktop/src-tauri/target/.../*.AppImage
#     -> <out>/libredb-studio-desktop-<version>-linux-<arch>.AppImage (+ .sha256)
#   desktop/src-tauri/target/.../*.deb
#     -> <out>/libredb-studio-desktop_<version>_<debarch>.deb (+ .sha256)
#
# Both come out of one bundler run. The GUI .deb exists because FlatPark
# (issue #241) repackages a vendor download as Flatpak extra-data and rejects
# AppImages outright - its runtime has no libfuse, so an AppImage cannot be
# unpacked at install time. It is also the natural package for Debian/Ubuntu
# desktop users; the similarly named libredb-studio_<version>_<arch>.deb is the
# headless systemd server and is built by packaging/linux/nfpm.yaml instead.
#
# The script name still says "appimage": it is referenced by name from
# .github/workflows/flatpak-smoke.yml path filters and release-artifacts.yml,
# and renaming it silently disarms those gates. Read it as "the desktop Linux
# bundler".
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
#   --deb-only           bundle only the .deb, skipping the AppImage. The
#                        AppImage bundler drives linuxdeploy and its gtk plugin,
#                        which needs the GTK/librsvg -dev packages installed on
#                        the build host; the .deb needs none of them. Lets
#                        someone working on the FlatPark package (issue #241)
#                        build what they need without that toolchain. Release CI
#                        never passes this - both artifacts are required assets.
#
# Requirements: bun, node, cargo (Rust >= 1.88), and the Tauri Linux system deps
# (libwebkit2gtk-4.1-dev, libgtk-3-dev, libayatana-appindicator3-dev, librsvg2-dev,
# patchelf, file). See desktop/README.md.
# ==============================================================================

set -euo pipefail

# Prebuilt Tauri CLI (npm), pinned. Matches the tauri crate minor in
# desktop/src-tauri/Cargo.toml - bump both together.
TAURI_CLI_VERSION="2.11.4"

# Name the bundled Node sidecar ships under. Must match `externalBin` in
# desktop/src-tauri/tauri.conf.json and NODE_BIN in
# desktop/src-tauri/src/layout.rs.
NODE_BIN="libredb-studio-node"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <output-dir> [--payload <tarball>] [--smoke] [--keep-stage] [--deb-only]" >&2
  exit 1
fi

OUT_DIR="$1"
shift
PAYLOAD_TARBALL=""
RUN_SMOKE=false
KEEP_STAGE=false
DEB_ONLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --deb-only)
      DEB_ONLY=true
      shift
      ;;
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
    DEB_ARCH=amd64
    TRIPLE=x86_64-unknown-linux-gnu
    ;;
  aarch64 | arm64)
    ARCH=arm64
    DEB_ARCH=arm64
    TRIPLE=aarch64-unknown-linux-gnu
    ;;
  *)
    echo "Unsupported architecture '$(uname -m)' (expected x86_64 or aarch64)" >&2
    exit 1
    ;;
esac

ASSET="libredb-studio-desktop-${VERSION}-linux-${ARCH}.AppImage"
# Debian arch naming, and an underscore-separated name, because that is what
# dpkg tooling and every downstream resolver expect. Distinct from the headless
# server package libredb-studio_<version>_<arch>.deb in both file name and
# dpkg package name, so the two can coexist in one release and on one machine.
ASSET_DEB="libredb-studio-desktop_${VERSION}_${DEB_ARCH}.deb"

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

# better-sqlite3 13 is N-API and ships a prebuild for EVERY platform in the one
# package (darwin/win32 binaries plus Linux ELFs for the other arch and for
# musl), where v12 shipped a single binding compiled for the build host. That
# reintroduces the failure above from a second direction: prebuilds/
# linuxmusl-x64.node needs libc.musl-x86_64.so.1, which is not resolvable in a
# glibc AppDir. Keep only the one this bundle can actually load.
BETTER_SQLITE3_PREBUILDS="$STAGE_PAYLOAD/node_modules/better-sqlite3/prebuilds"
if [ -d "$BETTER_SQLITE3_PREBUILDS" ]; then
  find "$BETTER_SQLITE3_PREBUILDS" -maxdepth 1 -type f -name '*.node' \
    ! -name "linux-${ARCH}.node" -delete
  if [ ! -f "$BETTER_SQLITE3_PREBUILDS/linux-${ARCH}.node" ]; then
    echo "better-sqlite3 ships no linux-${ARCH} prebuild - the bundle would have no SQLite storage" >&2
    exit 1
  fi
fi

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
#
#    It ships as libredb-studio-node, not node: the GUI .deb installs it into
#    the real /usr/bin, where node belongs to the distro's nodejs package, and
#    dpkg refuses to unpack a second package claiming that path (issue #241).
#    desktop/src-tauri/src/layout.rs probes this name first and still falls back
#    to the old one for AppDirs built before the rename.
# ------------------------------------------------------------------------------
echo "==> Bundling the pinned Node runtime as bin/${NODE_BIN}-${TRIPLE}"
rm -rf "$STAGE_BIN"
mkdir -p "$STAGE_BIN"
"$ROOT_DIR/packaging/linux/fetch-node.sh" "$WORK_DIR" "$ARCH"
install -m 0755 "$WORK_DIR/node/bin/node" "$STAGE_BIN/${NODE_BIN}-${TRIPLE}"

# ------------------------------------------------------------------------------
# 3. Bundle. Tauri reads the app version from the repo-root package.json (see
#    tauri.conf.json "version"), so the AppImage version always matches the
#    release version without a second place to bump.
# ------------------------------------------------------------------------------
if [ "$DEB_ONLY" = "true" ]; then
  echo "==> Bundling the GUI .deb only (tauri-cli ${TAURI_CLI_VERSION}, ${TRIPLE})"
else
  echo "==> Bundling the AppImage and the GUI .deb (tauri-cli ${TAURI_CLI_VERSION}, ${TRIPLE})"
fi
# linuxdeploy and appimagetool are themselves AppImages, so they mount
# themselves with FUSE - which neither the GitHub ubuntu runners nor most
# containers provide (no libfuse2). This tells them to self-extract instead;
# without it the bundler dies with a bare "failed to run linuxdeploy".
export APPIMAGE_EXTRACT_AND_RUN=1
BUNDLE_DIR="$TAURI_DIR/target/release/bundle/appimage"
DEB_BUNDLE_DIR="$TAURI_DIR/target/release/bundle/deb"
# Resources are copied next to the built binary, then into a staging tree
# (bundle/appimage_deb), then into the AppDir - and none of those copies is ever
# pruned, so a file removed from payload/ survives in all of them and keeps being
# bundled. linuxdeploy walks every ELF file it finds in the AppDir, so one stale
# copy can fail the build for content that is no longer staged. Start clean.
rm -rf "$TAURI_DIR/target/release/bundle" "$TAURI_DIR/target/release/payload" \
  "$TAURI_DIR/target/release/node"
# The deb is bundled first: Tauri's AppImage bundler builds a Debian tree as its
# own intermediate step, so asking for both targets costs one extra archive, not
# a second compile. Ordering it first also means a host missing the AppImage
# bundler's GTK toolchain still gets the .deb before anything can fail.
BUNDLES="deb,appimage"
if [ "$DEB_ONLY" = "true" ]; then
  BUNDLES="deb"
fi
(cd "$TAURI_DIR" && bunx "@tauri-apps/cli@${TAURI_CLI_VERSION}" build --bundles "$BUNDLES")

if [ "$DEB_ONLY" != "true" ]; then
  BUILT=$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.AppImage' -print -quit)
  if [ -z "$BUILT" ]; then
    echo "No AppImage was produced in $BUNDLE_DIR" >&2
    exit 1
  fi

  install -m 0755 "$BUILT" "$OUT_DIR/$ASSET"
  (cd "$OUT_DIR" && sha256sum "$ASSET" > "${ASSET}.sha256")
  echo "==> Wrote $OUT_DIR/$ASSET ($(du -h "$OUT_DIR/$ASSET" | cut -f1))"
fi

BUILT_DEB=$(find "$DEB_BUNDLE_DIR" -maxdepth 1 -name '*.deb' -print -quit)
if [ -z "$BUILT_DEB" ]; then
  echo "No .deb was produced in $DEB_BUNDLE_DIR" >&2
  exit 1
fi

install -m 0644 "$BUILT_DEB" "$OUT_DIR/$ASSET_DEB"
(cd "$OUT_DIR" && sha256sum "$ASSET_DEB" > "${ASSET_DEB}.sha256")
echo "==> Wrote $OUT_DIR/$ASSET_DEB ($(du -h "$OUT_DIR/$ASSET_DEB" | cut -f1))"

# ------------------------------------------------------------------------------
# 4. Smoke: boot the bundled payload with the bundled node from the extracted
#    AppDir. Display-free, so it runs on any CI runner.
# ------------------------------------------------------------------------------
if [ "$RUN_SMOKE" = "true" ]; then
  # The .deb is what FlatPark repackages, so it gets its own structural check
  # (issue #241). Cheap - no boot, no extraction of the payload's 200 MB - and
  # it catches the two things that would only surface on a user's machine: a
  # missing sidecar and a path that collides with a distro package.
  echo "==> Smoke: inspecting $ASSET_DEB"
  DEB_PATHS="$WORK_DIR/deb-paths.txt"
  # dpkg-deb prints member paths with or without a leading "./" depending on the
  # version; normalise so the assertions below do not depend on the build host.
  dpkg-deb -c "$OUT_DIR/$ASSET_DEB" | awk '{ sub(/^\.\//, "", $6); print $6 }' > "$DEB_PATHS"
  for required in \
    "usr/bin/libredb-studio-desktop" \
    "usr/bin/${NODE_BIN}" \
    "usr/lib/libredb-studio-desktop/payload/server.js" \
    "usr/share/applications/libredb-studio-desktop.desktop"; do
    if ! grep -qxF "$required" "$DEB_PATHS"; then
      echo "Smoke test FAILED: the .deb is missing $required" >&2
      exit 1
    fi
  done
  # A .deb owning /usr/bin/node cannot be installed alongside the distro nodejs
  # package - dpkg refuses to overwrite a path another package owns.
  if grep -qxF "usr/bin/node" "$DEB_PATHS"; then
    echo "Smoke test FAILED: the .deb ships /usr/bin/node, which collides with the distro nodejs package" >&2
    exit 1
  fi
  echo "==> Smoke: .deb layout is correct and claims no conflicting path"

  if [ "$DEB_ONLY" = "true" ]; then
    echo "==> Smoke: skipping the server boot (--deb-only)"
    echo "==> Done: $OUT_DIR/$ASSET_DEB"
    exit 0
  fi

  echo "==> Smoke: extracting the AppImage"
  (cd "$WORK_DIR" && "$OUT_DIR/$ASSET" --appimage-extract > /dev/null)
  APPDIR="$WORK_DIR/squashfs-root"

  APPDIR_NODE=$(find "$APPDIR/usr" -maxdepth 3 -type f -name "$NODE_BIN" -print -quit)
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
