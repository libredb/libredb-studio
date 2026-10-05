#!/usr/bin/env bash
# ==============================================================================
# Prune db2-node's prebuilt addons in an assembled standalone payload down to
# the ones the target can load (issue #786).
#
# db2-node is one package carrying eight N-API addons at its root
# (db2-node.<platform>-<arch>[-gnu|-musl|-msvc].node, ~43 MB together), and its
# generated index.js reaches each through a static require literal, so output
# file tracing copies all eight into the standalone output. Kept per target:
#   linux   db2-node.linux-<arch>-gnu.node and db2-node.linux-<arch>-musl.node
#           (one tarball serves glibc and, through npx, Alpine)
#   darwin  db2-node.darwin-<arch>.node
#   win32   db2-node.win32-<arch>-msvc.node
# index.js falls back to db2-node-<triple> packages that do not exist, so a
# pruned-away addon fails loudly at require time; this script fails earlier,
# when the package or a kept addon is missing, or when the payload still holds
# an addon outside every copy of the package.
#
# A copy is node_modules/db2-node, plus any .next/node_modules/db2-node-<hash>
# that is a real directory. Turbopack links each serverExternalPackages entry
# there under a hashed name and the server chunks require that name; on the
# Windows runner Git Bash's cp -R turns the link into a real directory, which is
# then the copy the server loads, so it is pruned the same way.
#
# Usage: prune-db2-node.sh <payload-dir> <linux|darwin|win32> <x64|arm64>
# ==============================================================================

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <payload-dir> <linux|darwin|win32> <x64|arm64>" >&2
  exit 1
fi

PAYLOAD_DIR=$1
OS=$2
ARCH=$3
DB2_NODE_DIR="$PAYLOAD_DIR/node_modules/db2-node"

case "$OS" in
  linux) KEEP=("db2-node.linux-${ARCH}-gnu.node" "db2-node.linux-${ARCH}-musl.node") ;;
  darwin) KEEP=("db2-node.darwin-${ARCH}.node") ;;
  win32) KEEP=("db2-node.win32-${ARCH}-msvc.node") ;;
  *)
    echo "Unknown target OS '$OS' (expected linux, darwin or win32)" >&2
    exit 1
    ;;
esac

if [ ! -f "$DB2_NODE_DIR/index.js" ]; then
  echo "node_modules/db2-node is missing from the payload - file tracing no longer reaches it" >&2
  exit 1
fi

COPIES=("$DB2_NODE_DIR")
for candidate in "$PAYLOAD_DIR"/.next/node_modules/db2-node-*; do
  if [ -d "$candidate" ] && [ ! -L "$candidate" ] && [ -f "$candidate/index.js" ]; then
    COPIES+=("$candidate")
  fi
done

for copy in "${COPIES[@]}"; do
  for wanted in "${KEEP[@]}"; do
    if [ ! -f "$copy/$wanted" ]; then
      echo "db2-node has no $wanted addon for ${OS}-${ARCH} in ${copy#"$PAYLOAD_DIR"/}" >&2
      exit 1
    fi
  done

  for addon in "$copy"/db2-node.*.node; do
    keep=false
    for wanted in "${KEEP[@]}"; do
      [ "$(basename "$addon")" = "$wanted" ] && keep=true
    done
    [ "$keep" = true ] || rm -f "$addon"
  done
done

EXPECTED=$((${#KEEP[@]} * ${#COPIES[@]}))
FOUND=$(find "$PAYLOAD_DIR" -type f -name 'db2-node.*.node' | sort)
if [ "$(printf '%s\n' "$FOUND" | grep -c .)" -ne "$EXPECTED" ]; then
  echo "Expected $EXPECTED db2-node addon(s) in ${#COPIES[@]} copy(ies) of the package after the prune, found:" >&2
  printf '%s\n' "$FOUND" >&2
  exit 1
fi
