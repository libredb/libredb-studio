#!/bin/sh
# Measures what a bucket-scoped key and a broad read key reach through the S3 agent's reads on RustFS 1.0.1
# (tests/live/s3-agent-scope.ts), into scope.json beside this script.
#
#   sh tests/fixtures/s3/agent-scope/rustfs-1.0.1/run.sh
#
# A fresh digest-pinned server on its own network and port, a root key and three read keys made for the run and kept
# in this shell's environment only: the scoped key given ../scoped-policy.json, the unlisted key
# ../unlisted-policy.json and the broad key ../../agent-boundary/reader-policy.json through mc admin (../keys.sh). Everything is removed at the end. Run it under the team's
# docker lock; it touches only the container and the network it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c"
MC_IMAGE="pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd"
NAME="prc2-scope-rustfs"
NET="prc2-scope-rustfs-net"
PORT=19420
SERVER=rustfs
START() {
  RUSTFS_ACCESS_KEY="$S3_SCOPE_ROOT_KEY" RUSTFS_SECRET_KEY="$S3_SCOPE_ROOT_SECRET" docker run -d --name "$NAME" \
    --network "$NET" -p "127.0.0.1:$PORT:9000" -e RUSTFS_ACCESS_KEY -e RUSTFS_SECRET_KEY -e RUSTFS_CHECK_UPDATE=false \
    "$IMAGE" >/dev/null
}
READY="/health/ready"
. "$here/../keys.sh"
