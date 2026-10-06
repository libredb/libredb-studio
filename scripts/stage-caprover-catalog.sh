#!/usr/bin/env bash
# Copies the CapRover one-click templates and their logos from a LibreDB Studio
# checkout into a caprover/one-click-apps checkout, byte for byte, and prints
# the catalog paths it wrote. The one list of what goes upstream, used by both
# jobs of .github/workflows/caprover-fork.yml.
#
# Usage: stage-caprover-catalog.sh <studio checkout> <catalog checkout>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: stage-caprover-catalog.sh <studio checkout> <catalog checkout>" >&2
  exit 2
fi
STUDIO="$1"
CATALOG="$2"

for name in libredb-studio libredb-studio-autoconnect; do
  cp "$STUDIO/deploy/caprover/$name.yml" "$CATALOG/public/v4/apps/$name.yml"
  cp "$STUDIO/deploy/caprover/$name.png" "$CATALOG/public/v4/logos/$name.png"
  printf '%s\n' "public/v4/apps/$name.yml" "public/v4/logos/$name.png"
done
