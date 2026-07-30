#!/bin/sh
set -eu

# The unpack below is a pipeline, and a plain `set -e` only sees the exit status
# of its LAST command - a first-stage failure part-way through would hand the
# second stage a truncated stream, which can still exit 0 and leave a partial
# tree. Flatpak verifies the extra-data digest before this script runs, so a
# corrupt download cannot get here, but a full disk mid-unpack can. /bin/sh is
# bash in org.gnome.Platform; the subshell probe keeps this a no-op rather than
# a hard failure on a shell without pipefail.
# shellcheck disable=SC3040
(set -o pipefail) 2> /dev/null && set -o pipefail || true

# Runs offline at install time inside org.gnome.Platform (issue #241).
#
# The upstream Debian package is a plain FHS tree holding three things: the
# Tauri shell (usr/bin/libredb-studio-desktop), the pinned Node runtime it
# starts as a sidecar (usr/bin/libredb-studio-node) and the standalone Next.js
# server payload (usr/lib/libredb-studio-desktop/payload). The relative layout
# is load-bearing - the shell resolves its resources as
# <exe dir>/../lib/<product name> - so the whole usr tree is kept as-is at
# /app/extra/usr rather than cherry-picking the binary.
#
# The desktop file, icon and AppStream metainfo are shipped by the manifest at
# *build* time: extra-data is fetched later on the user's machine, so anything
# Flatpak has to export cannot come from here.

extra_root="${EXTRA_ROOT:-/app/extra}"
cd "$extra_root"

[ -f libredb-studio-desktop.deb ] || {
  echo "missing extra-data: libredb-studio-desktop.deb" >&2
  exit 1
}

# The Platform runtime has no ar/dpkg, but bsdtar (libarchive) reads the .deb
# ar container directly; pipe its data member into a second bsdtar to unpack the
# tree (the inner data.tar compression is auto-detected).
rm -rf stage usr
mkdir stage
# --no-same-owner: on a system-wide install Flatpak runs apply_extra as root with
# every capability dropped, so restoring the archive's recorded uid/gid fails and
# aborts the unpack even though every member extracted fine.
bsdtar -xOf libredb-studio-desktop.deb 'data.tar*' | bsdtar --no-same-owner -xf - -C stage

[ -x stage/usr/bin/libredb-studio-desktop ] || {
  echo "desktop shell not found in .deb" >&2
  exit 1
}
[ -x stage/usr/bin/libredb-studio-node ] || {
  echo "node sidecar not found in .deb" >&2
  exit 1
}
[ -f stage/usr/lib/libredb-studio-desktop/payload/server.js ] || {
  echo "server payload not found in .deb" >&2
  exit 1
}

mv stage/usr usr
rm -rf stage libredb-studio-desktop.deb
chmod +x usr/bin/libredb-studio-desktop usr/bin/libredb-studio-node
