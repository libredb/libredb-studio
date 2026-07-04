#!/usr/bin/env bash
# ==============================================================================
# Bundle the pinned Node.js runtime into a standalone payload (issue #112).
#
# Downloads the official nodejs.org dist tarball for NODE_VERSION and the
# target arch, verifies it against the sha256 digests pinned in this script,
# and installs ONLY bin/node into <payload-dir>/node/bin/node - the private
# runtime the packaged wrapper (/usr/bin/libredb-studio) execs. Nothing else
# from the Node distribution (npm, corepack, headers, docs) is shipped.
#
# Usage: packaging/linux/fetch-node.sh <payload-dir> [x64|arm64]
#   arch defaults to the host arch (uname -m).
# ==============================================================================

set -euo pipefail

# Pinned Node LTS (Krypton). Keep >= the package.json "engines.node" floor
# and bump deliberately - the checksum verification below always follows.
NODE_VERSION="24.18.0"

# sha256 of the official node-v${NODE_VERSION}-linux-<arch>.tar.xz tarballs,
# from https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt. Pinned
# in-repo (like NFPM_SHA256 in release-artifacts.yml) so a compromised
# download origin cannot serve a tampered tarball together with a matching
# checksum file. Update BOTH digests whenever NODE_VERSION is bumped.
NODE_SHA256_X64="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
NODE_SHA256_ARM64="58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <payload-dir> [x64|arm64]" >&2
  exit 1
fi

PAYLOAD_DIR="$1"
if [ ! -d "$PAYLOAD_DIR" ]; then
  echo "Payload directory not found: $PAYLOAD_DIR" >&2
  exit 1
fi
PAYLOAD_DIR=$(cd "$PAYLOAD_DIR" && pwd)

if [ $# -eq 2 ]; then
  ARCH="$2"
else
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *)
      echo "Unsupported host architecture '$(uname -m)' - pass x64 or arm64 explicitly" >&2
      exit 1
      ;;
  esac
fi
case "$ARCH" in
  x64) NODE_SHA256="$NODE_SHA256_X64" ;;
  arm64) NODE_SHA256="$NODE_SHA256_ARM64" ;;
  *)
    echo "Unsupported architecture '$ARCH' (expected x64 or arm64)" >&2
    exit 1
    ;;
esac

DIST="node-v${NODE_VERSION}-linux-${ARCH}"
BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Downloading ${DIST}.tar.xz"
curl -fsSL --retry 3 -o "$WORK_DIR/${DIST}.tar.xz" "${BASE_URL}/${DIST}.tar.xz"

echo "==> Verifying against the pinned sha256"
(
  cd "$WORK_DIR"
  echo "${NODE_SHA256}  ${DIST}.tar.xz" | sha256sum -c -
)

echo "==> Extracting bin/node into ${PAYLOAD_DIR}/node/bin/node"
tar -xJf "$WORK_DIR/${DIST}.tar.xz" -C "$WORK_DIR" "${DIST}/bin/node"
install -D -m 0755 "$WORK_DIR/${DIST}/bin/node" "$PAYLOAD_DIR/node/bin/node"

echo "==> Done: $("$PAYLOAD_DIR/node/bin/node" --version 2>/dev/null || echo "(cross-arch: not runnable on this host)")"
