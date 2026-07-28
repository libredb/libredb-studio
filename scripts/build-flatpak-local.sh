#!/usr/bin/env bash
# ==============================================================================
# Build and install the LibreDB Studio Flatpak from a LOCAL AppImage (issue #232).
#
# The manifest that ships to Flathub points at a released AppImage asset. This
# script renders the same manifest against an AppImage you just built, so the
# repack can be built, linted and run end to end before anything is released:
#
#   scripts/build-desktop-appimage.sh dist --smoke
#   scripts/build-flatpak-local.sh dist/libredb-studio-desktop-<version>-linux-x64.AppImage --install
#   flatpak run org.libredb.Studio
#
# Usage: scripts/build-flatpak-local.sh <appimage> [--install]
#
#   --install   install the built app into the per-user Flatpak installation
#
# Requirements: the org.flatpak.Builder flatpak (the tool Flathub itself uses)
# plus the GNOME runtime and SDK the manifest declares:
#   flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50
#
# Outputs (all git-ignored) land under build/flatpak/:
#   org.libredb.Studio.yml        manifest with the release URLs - what is linted
#   org.libredb.Studio.local.yml  same manifest pointed at your local AppImage
#   build-dir/ repo/ state/       flatpak-builder working directories
# ==============================================================================

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <appimage> [--install]" >&2
  exit 1
fi

APPIMAGE="$1"
shift
DO_INSTALL=false
if [ "${1:-}" = "--install" ]; then
  DO_INSTALL=true
  shift
fi
if [ $# -gt 0 ]; then
  echo "Unknown argument: $1" >&2
  exit 1
fi

if [ ! -f "$APPIMAGE" ]; then
  echo "AppImage not found: $APPIMAGE" >&2
  exit 1
fi
APPIMAGE=$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

if ! flatpak info org.flatpak.Builder > /dev/null 2>&1; then
  echo "org.flatpak.Builder is not installed. Run:" >&2
  echo "  flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50" >&2
  exit 1
fi

APP_ID=org.libredb.Studio
FLATPAK_DIR="$ROOT_DIR/packaging/flatpak"
BUILD_DIR="$ROOT_DIR/build/flatpak"
VERSION=$(node -p "require('./package.json').version")

case "$(uname -m)" in
  x86_64) FLATPAK_ARCH=x86_64 ;;
  aarch64 | arm64) FLATPAK_ARCH=aarch64 ;;
  *)
    echo "Unsupported architecture '$(uname -m)' (expected x86_64 or aarch64)" >&2
    exit 1
    ;;
esac

mkdir -p "$BUILD_DIR"

# ------------------------------------------------------------------------------
# 1. Render both manifests: the release one (what Flathub gets, and what the
#    linter must be happy with) and the local one (what we actually build).
# ------------------------------------------------------------------------------
echo "==> Rendering manifests for ${VERSION} (${FLATPAK_ARCH})"
SUMS="$BUILD_DIR/appimage-sums.txt"
: > "$SUMS"
for arch in x64 arm64; do
  ASSET="libredb-studio-desktop-${VERSION}-linux-${arch}.AppImage"
  if [ "$(basename "$APPIMAGE")" = "$ASSET" ]; then
    sha256sum "$APPIMAGE" | sed "s|  .*|  ${ASSET}|" >> "$SUMS"
  else
    # Placeholder for the architecture we are not building here: the release
    # manifest needs a digest for both, and only the local one is built.
    echo "$(printf '0%.0s' $(seq 1 64))  ${ASSET}" >> "$SUMS"
  fi
done

node scripts/render-flatpak-manifest.mjs \
  "$FLATPAK_DIR/${APP_ID}.yml.tmpl" "$SUMS" "$VERSION" "$BUILD_DIR/${APP_ID}.yml"

# flatpak-builder resolves `path:` sources relative to the manifest and the build
# runs sandboxed, so every local source - launcher, desktop entry, metainfo and
# the AppImage itself - sits next to the rendered manifest.
cp "$FLATPAK_DIR/libredb-studio.sh" "$FLATPAK_DIR/${APP_ID}.desktop" \
  "$FLATPAK_DIR/${APP_ID}.metainfo.xml" "$BUILD_DIR/"
cp "$APPIMAGE" "$BUILD_DIR/$(basename "$APPIMAGE")"

node scripts/render-flatpak-manifest.mjs \
  "$FLATPAK_DIR/${APP_ID}.yml.tmpl" "$SUMS" "$VERSION" "$BUILD_DIR/${APP_ID}.local.yml" \
  --local "$FLATPAK_ARCH" "$BUILD_DIR/$(basename "$APPIMAGE")"

# ------------------------------------------------------------------------------
# 2. Lint the release manifest and validate the metainfo (same tools as Flathub).
# ------------------------------------------------------------------------------
echo "==> Validating the AppStream metainfo"
flatpak run --command=appstreamcli org.flatpak.Builder validate \
  "$BUILD_DIR/${APP_ID}.metainfo.xml"

echo "==> Linting the release manifest"
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest "$BUILD_DIR/${APP_ID}.yml"

# ------------------------------------------------------------------------------
# 3. Build the local manifest.
# ------------------------------------------------------------------------------
echo "==> Building ${APP_ID} from ${APPIMAGE##*/}"
INSTALL_ARGS=()
if [ "$DO_INSTALL" = "true" ]; then
  INSTALL_ARGS=(--user --install)
fi
(
  cd "$BUILD_DIR"
  # --mirror-screenshots-url makes flatpak-builder download the metainfo
  # screenshots and commit them as the screenshots/<arch> ref, the same way
  # Flathub's build does (it cannot rewrite the URLs to dl.flathub.org for us -
  # see packaging/flatpak/lint-exceptions.json).
  flatpak run org.flatpak.Builder --force-clean --sandbox --delete-build-dirs \
    --mirror-screenshots-url=https://dl.flathub.org/media \
    --state-dir=state --repo=repo "${INSTALL_ARGS[@]}" build-dir "${APP_ID}.local.yml"
)

echo "==> Linting the built repository"
flatpak run --command=flatpak-builder-lint org.flatpak.Builder \
  --exceptions --user-exceptions "$FLATPAK_DIR/lint-exceptions.json" repo "$BUILD_DIR/repo"

echo "==> Done."
if [ "$DO_INSTALL" = "true" ]; then
  echo "    Installed. Launch with: flatpak run ${APP_ID}"
else
  echo "    Not installed (pass --install). Repository: $BUILD_DIR/repo"
fi
