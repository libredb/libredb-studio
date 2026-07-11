#!/usr/bin/env bash
# ==============================================================================
# Wrap an assembled standalone payload directory in a top-level
# libredb-studio-<version>/ root before tarring it (issue #133): a
# conventional release-tarball layout instead of a tarbomb (entries at
# archive root). Consumers extract with `tar --strip-components=1` (see
# bin/lib/launcher-utils.mjs's extractTarball and
# .github/workflows/release-artifacts.yml); Homebrew strips a single
# top-level directory automatically for its main url/sha256 download.
#
# Usage: pack-standalone-tarball.sh <payload-dir> <version> <output-tarball>
# ==============================================================================

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <payload-dir> <version> <output-tarball>" >&2
  exit 1
fi

PAYLOAD_DIR=$1
VERSION=$2
OUT_TARBALL=$3

ROOT_NAME="libredb-studio-${VERSION}"
PARENT_DIR=$(cd "$(dirname "$PAYLOAD_DIR")" && pwd)
ROOT_DIR="$PARENT_DIR/$ROOT_NAME"

rm -rf "${ROOT_DIR:?}"
mv "$PAYLOAD_DIR" "$ROOT_DIR"
tar -czf "$OUT_TARBALL" -C "$PARENT_DIR" "$ROOT_NAME"
