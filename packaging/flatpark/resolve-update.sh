#!/usr/bin/env bash
# Update resolver for LibreDB Studio (issue #241).
#
# Prints the current version + the Linux x86_64 desktop .deb as JSON on stdout:
#   { "version": "0.9.62", "releaseDate": "YYYY-MM-DD",
#     "sources": [ { "filename": "libredb-studio-desktop.deb", "url": "..." } ] }
# Logs go to stderr. No hashing, no manifest rewriting - FlatPark downloads the
# URL and computes the extra-data sha256/size at build time. The version is
# compared against the latest <release> in the AppStream metainfo.
set -euo pipefail

repo="libredb/libredb-studio"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
need curl
need jq

rel="$(curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
  "https://api.github.com/repos/$repo/releases/latest")"

# Release tags in this repo are bare semver, so there is no "v" to strip.
version="$(jq -r '.tag_name' <<< "$rel")"
date="$(jq -r '.published_at' <<< "$rel" | cut -c1-10)"
# The desktop GUI build is `libredb-studio-desktop_<version>_amd64.deb`. The
# similarly named `libredb-studio_<version>_amd64.deb` is the headless systemd
# server package; the .AppImage, the .rpm, the .snap and the standalone
# tarballs are all skipped.
#
# amd64 only, matching `only-arches: [x86_64]` in the manifest - releases also
# publish an arm64 GUI .deb that this listing does not consume. Supporting it
# means emitting a second `sources` entry here AND a second extra-data block
# there; the two must change together.
url="$(jq -r '.assets[] | select(.name | test("^libredb-studio-desktop_.*_amd64\\.deb$")) | .browser_download_url' \
  <<< "$rel" | head -n1)"

[ -n "$version" ] && [ -n "$url" ] || {
  echo "failed to resolve libredb-studio release" >&2
  exit 1
}
echo "resolved libredb-studio $version ($date): $url" >&2

jq -n --arg v "$version" --arg d "$date" --arg u "$url" \
  '{version:$v, releaseDate:$d, sources:[{filename:"libredb-studio-desktop.deb", url:$u}]}'
