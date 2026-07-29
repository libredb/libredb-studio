#!/usr/bin/env bash
# ==============================================================================
# Build and install the LibreDB Studio FlatPark package from a LOCAL .deb
# (issue #241).
#
# The descriptor set in packaging/flatpark pins a published release asset as
# Flatpak extra-data. This script renders the same manifest against a .deb you
# just built, so the package can be built, validated and run end to end before
# anything is released:
#
#   scripts/build-desktop-appimage.sh dist-desktop --payload <tarball>
#   scripts/build-flatpark-local.sh dist-desktop/libredb-studio-desktop-<version>_amd64.deb --install
#   flatpak run org.libredb.Studio
#
# Usage: scripts/build-flatpark-local.sh <deb> [--install] [--installation <name>]
#
#   --install               install the built app after building
#   --installation <name>   install into a named Flatpak installation instead of
#                           the per-user one (see packaging/flatpark/README.md;
#                           an isolated installation must be registered in
#                           /etc/flatpak/installations.d, NOT conjured with
#                           FLATPAK_USER_DIR - an unregistered installation
#                           breaks flatpak-spawn and the GNOME image decoder,
#                           which looks exactly like a packaging bug)
#
# Why an HTTP server: Flatpak's extra-data accepts only http/https URLs, never
# file://, and it downloads at INSTALL time rather than build time. So the
# manifest is pointed at a throwaway localhost origin that stays up for both the
# build and the install.
#
# Requirements: the org.flatpak.Builder flatpak plus the GNOME runtime and SDK
# the manifest declares:
#   flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50
#
# Outputs (all git-ignored) land under build/flatpark/.
# ==============================================================================

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <deb> [--install] [--installation <name>]" >&2
  exit 1
fi

DEB="$1"
shift
DO_INSTALL=false
INSTALLATION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install)
      DO_INSTALL=true
      shift
      ;;
    --installation)
      INSTALLATION="${2:-}"
      if [ -z "$INSTALLATION" ]; then
        echo "--installation needs a name" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$DEB" ]; then
  echo "Debian package not found: $DEB" >&2
  exit 1
fi
DEB=$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! flatpak info org.flatpak.Builder > /dev/null 2>&1; then
  echo "org.flatpak.Builder is not installed. Run:" >&2
  echo "  flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50" >&2
  exit 1
fi

APP_ID=org.libredb.Studio
# Matches build.branch in packaging/flatpark/flatpark.yml.
BRANCH=stable
SRC_DIR="$ROOT_DIR/packaging/flatpark"
BUILD_DIR="$ROOT_DIR/build/flatpark"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ------------------------------------------------------------------------------
# 1. Stage the descriptor set exactly as it would land in the registry, minus
#    the README (which is ours, not FlatPark's).
# ------------------------------------------------------------------------------
echo "==> Staging the descriptor set"
cp "$SRC_DIR"/* "$BUILD_DIR/"
rm -f "$BUILD_DIR/README.md"
chmod +x "$BUILD_DIR/apply_extra.sh" "$BUILD_DIR/resolve-update.sh" "$BUILD_DIR/libredb-studio-wrapper"

# ------------------------------------------------------------------------------
# 2. Serve the .deb over loopback and re-pin the managed extra-data block at it.
# ------------------------------------------------------------------------------
SERVE_DIR=$(mktemp -d)
cp "$DEB" "$SERVE_DIR/$(basename "$DEB")"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2> /dev/null || true
    wait "$SERVER_PID" 2> /dev/null || true
  fi
  rm -rf "$SERVE_DIR"
}
trap cleanup EXIT

PORT=$(((RANDOM % 20000) + 20001))
echo "==> Serving $(basename "$DEB") on 127.0.0.1:${PORT}"
(cd "$SERVE_DIR" && exec python3 -m http.server "$PORT" --bind 127.0.0.1) > "$SERVE_DIR/http.log" 2>&1 &
SERVER_PID=$!

READY=false
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/$(basename "$DEB")"; then
    READY=true
    break
  fi
  sleep 1
done
if [ "$READY" != "true" ]; then
  echo "The local HTTP origin never came up" >&2
  cat "$SERVE_DIR/http.log" >&2 || true
  exit 1
fi

DEB_SHA=$(sha256sum "$DEB" | cut -d' ' -f1)
DEB_SIZE=$(stat -c%s "$DEB")
DEB_URL="http://127.0.0.1:${PORT}/$(basename "$DEB")"

MANIFEST="$BUILD_DIR/${APP_ID}.yml"
# The managed extra-data block holds the only url/sha256/size keys in the
# manifest. Assert that before rewriting them, so a future manifest that grows a
# second source fails loudly instead of being silently half-repinned.
for key in url sha256 size; do
  count=$(grep -c "^ *${key}:" "$MANIFEST" || true)
  if [ "$count" != "1" ]; then
    echo "Expected exactly one '${key}:' in $MANIFEST, found ${count}" >&2
    exit 1
  fi
done

echo "==> Re-pinning the manifest at the local origin (sha256 ${DEB_SHA:0:12}..., ${DEB_SIZE} bytes)"
sed -i -E \
  -e "s|^( *)url: .*|\1url: ${DEB_URL}|" \
  -e "s|^( *)sha256: .*|\1sha256: ${DEB_SHA}|" \
  -e "s|^( *)size: .*|\1size: ${DEB_SIZE}|" \
  "$MANIFEST"

# ------------------------------------------------------------------------------
# 3. Validate the AppStream metainfo (same tool FlatPark and Flathub both run).
# ------------------------------------------------------------------------------
echo "==> Validating the AppStream metainfo"
flatpak run --command=appstreamcli org.flatpak.Builder validate \
  "$BUILD_DIR/${APP_ID}.metainfo.xml"

# ------------------------------------------------------------------------------
# 4. Build. extra-data is not fetched here - the ref only records the pin - so a
#    successful build proves the manifest, not the download.
# ------------------------------------------------------------------------------
echo "==> Building ${APP_ID} from $(basename "$DEB")"
(
  cd "$BUILD_DIR"
  # --default-branch=stable matches what FlatPark publishes (flatpark.yml
  # build.branch) and keeps this ref distinct from any other local build of the
  # same app id sitting in the installation.
  flatpak run org.flatpak.Builder --force-clean --delete-build-dirs \
    --default-branch="$BRANCH" --state-dir=state --repo=repo build-dir "${APP_ID}.yml"
)

# ------------------------------------------------------------------------------
# 5. Install. THIS is where extra-data is downloaded and apply_extra runs, so it
#    is the step that actually exercises the bsdtar unpack.
# ------------------------------------------------------------------------------
if [ "$DO_INSTALL" != "true" ]; then
  echo "==> Done. Not installed (pass --install). Repository: $BUILD_DIR/repo"
  exit 0
fi

FLATPAK_TARGET=(--user)
if [ -n "$INSTALLATION" ]; then
  FLATPAK_TARGET=(--installation="$INSTALLATION")
fi

echo "==> Installing into ${INSTALLATION:-the per-user installation}"
flatpak "${FLATPAK_TARGET[@]}" remote-add --if-not-exists --no-gpg-verify \
  libredb-flatpark-local "$BUILD_DIR/repo"
# extra-data is downloaded HERE, from the loopback origin above, and apply_extra
# runs immediately afterwards inside the sandbox. An install that succeeds is
# the real proof that the bsdtar unpack works.
flatpak "${FLATPAK_TARGET[@]}" install -y --reinstall libredb-flatpark-local "${APP_ID}//${BRANCH}"

echo "==> Done. Launch with:"
if [ -n "$INSTALLATION" ]; then
  echo "    flatpak --installation=${INSTALLATION} run ${APP_ID}//${BRANCH}"
else
  echo "    flatpak run ${APP_ID}//${BRANCH}"
fi
