#!/usr/bin/env bash
# ==============================================================================
# Bundle the pinned Node.js runtime into a win32 standalone payload
# (issue #114) - the Windows sibling of packaging/linux/fetch-node.sh.
#
# Downloads the official nodejs.org dist zip for NODE_VERSION (win-x64),
# verifies it against the sha256 pinned in this script, and installs ONLY
# node.exe into <payload-dir>/node/node.exe - the private runtime the
# packaged launcher (libredb-studio.exe) starts. Nothing else from the Node
# distribution (npm, corepack, headers, docs) is shipped.
#
# Runs in Git Bash on the windows-latest release runner; zip extraction uses
# the System32 bsdtar there (Git Bash's own tar is GNU tar, which cannot
# read zip) and falls back to `unzip` for local non-Windows dry runs.
#
# Usage: packaging/windows/fetch-node.sh <payload-dir>
# ==============================================================================

set -euo pipefail

# Pinned Node LTS (Krypton). Keep in lockstep with packaging/linux/fetch-node.sh
# (same NODE_VERSION) and bump BOTH scripts' pins together.
NODE_VERSION="24.18.0"

# sha256 of the official node-v${NODE_VERSION}-win-x64.zip, from
# https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt. Pinned in-repo so
# a compromised download origin cannot serve a tampered archive together
# with a matching checksum file.
NODE_SHA256_WIN_X64="0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <payload-dir>" >&2
  exit 1
fi

PAYLOAD_DIR="$1"
if [ ! -d "$PAYLOAD_DIR" ]; then
  echo "Payload directory not found: $PAYLOAD_DIR" >&2
  exit 1
fi
PAYLOAD_DIR=$(cd "$PAYLOAD_DIR" && pwd)

DIST="node-v${NODE_VERSION}-win-x64"
BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Downloading ${DIST}.zip"
curl -fsSL --retry 3 -o "$WORK_DIR/${DIST}.zip" "${BASE_URL}/${DIST}.zip"

echo "==> Verifying against the pinned sha256"
(
  cd "$WORK_DIR"
  echo "${NODE_SHA256_WIN_X64}  ${DIST}.zip" | sha256sum -c -
)

# The official win-x64 zip keeps node.exe directly under the top-level
# ${DIST}/ folder (no bin/ subdirectory, unlike the POSIX tarballs).
# Env-var casing differs between shells (SystemRoot vs SYSTEMROOT), so probe
# for the System32 bsdtar by path and fall back to `unzip` (present in Git
# Bash and on Linux dev machines).
echo "==> Extracting node.exe into ${PAYLOAD_DIR}/node/node.exe"
WINTAR="${SYSTEMROOT:-${SystemRoot:-C:\\Windows}}/System32/tar.exe"
if [ -x "$WINTAR" ]; then
  "$WINTAR" -xf "$WORK_DIR/${DIST}.zip" -C "$WORK_DIR" "${DIST}/node.exe"
else
  unzip -q -o "$WORK_DIR/${DIST}.zip" "${DIST}/node.exe" -d "$WORK_DIR"
fi
mkdir -p "$PAYLOAD_DIR/node"
install -m 0755 "$WORK_DIR/${DIST}/node.exe" "$PAYLOAD_DIR/node/node.exe"

echo "==> Done: $("$PAYLOAD_DIR/node/node.exe" --version 2>/dev/null || echo "(cross-platform: not runnable on this host)")"
