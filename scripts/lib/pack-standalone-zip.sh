#!/usr/bin/env bash
# ==============================================================================
# Pack an assembled standalone payload directory into a FLAT zip for the
# win32-x64 release artifact (issue #114).
#
# Flat means entries sit at the archive root (server.js, .next/, node/,
# libredb-studio.exe, ...) with NO libredb-studio-<version>/ wrapper - the
# opposite of the POSIX tarball layout (issue #133). Two consumers force
# this:
#   - winget extracts the zip in place and resolves
#     NestedInstallerFiles.RelativeFilePath against the zip root; a
#     versioned wrapper directory would change that path on every release
#     (wingetcreate update does not rewrite RelativeFilePath).
#   - Chocolatey's Install-ChocolateyZipPackage unzips into the package
#     tools dir, where the launcher exe must land at a stable depth for
#     shimming.
# Windows Explorer's "Extract All" already defaults to a directory named
# after the zip, so a flat archive is not a zipbomb hazard for manual users.
#
# Packs with 7-Zip (preinstalled on the windows-latest runner image), then
# asserts the resulting layout is really flat and complete - a zip missing
# server.js or .next/ must fail here, not at install time.
#
# Usage: pack-standalone-zip.sh <payload-dir> <output-zip>
# ==============================================================================

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <payload-dir> <output-zip>" >&2
  exit 1
fi

PAYLOAD_DIR=$1
OUT_ZIP=$2

if [ ! -d "$PAYLOAD_DIR" ]; then
  echo "Payload dir not found: $PAYLOAD_DIR" >&2
  exit 1
fi

# Resolve the output path against the caller's cwd before any cd.
OUT_PARENT=$(cd "$(dirname "$OUT_ZIP")" && pwd)
OUT_ZIP="$OUT_PARENT/$(basename "$OUT_ZIP")"

# 7z is on PATH on the windows-latest runner image; fall back to the
# canonical install location for local Git Bash setups that skip PATH.
SEVENZIP=$(command -v 7z || true)
if [ -z "$SEVENZIP" ] && [ -x "/c/Program Files/7-Zip/7z.exe" ]; then
  SEVENZIP="/c/Program Files/7-Zip/7z.exe"
fi
if [ -z "$SEVENZIP" ]; then
  echo "7z not found - the win32 zip is packed with 7-Zip (preinstalled on windows-latest)" >&2
  exit 1
fi

rm -f "$OUT_ZIP"
# `7z a <zip> .` from inside the payload adds its CONTENTS at the archive
# root (no wrapper directory) and includes dot-named entries like .next -
# unlike a shell glob, which would skip them.
(cd "$PAYLOAD_DIR" && "$SEVENZIP" a -tzip -bd -bso0 "$OUT_ZIP" .)

# Layout assertions: required roots present, and present AT the root (7z
# lists paths with backslashes on Windows, so match both separators; the
# native 7z.exe also emits CRLF line endings, so strip \r or the anchored
# grep below would reject every entry on the Windows runner).
LISTING=$("$SEVENZIP" l -ba -slt "$OUT_ZIP" | sed -n 's/^Path = //p' | tr -d '\r')
for required in "server.js" ".next" "package.json"; do
  # -F: fixed-string match - a regex match would let the dots in these
  # names match any character (serverXjs must not satisfy server.js).
  if ! printf '%s\n' "$LISTING" | grep -qxF "$required"; then
    echo "Packed zip is missing required root entry '$required' - refusing to ship it" >&2
    exit 1
  fi
done
if printf '%s\n' "$LISTING" | grep -qE '^libredb-studio-[0-9]'; then
  echo "Packed zip has a versioned wrapper directory - the win32 zip must be flat (issue #114)" >&2
  exit 1
fi

echo "==> Packed flat zip $OUT_ZIP"
