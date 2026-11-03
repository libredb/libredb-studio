#!/bin/sh
# Measures what a bucket-scoped key and a broad read key reach through the S3 agent's reads on Silo
# RELEASE.2026-09-16T00-00-00Z (tests/live/s3-agent-scope.ts), into scope.json beside this script.
#
#   sh tests/fixtures/s3/agent-scope/silo-RELEASE.2026-09-16T00-00-00Z/run.sh
#
# A fresh digest-pinned server on its own network and port, a root key and three read keys made for the run and kept
# in this shell's environment only: the scoped key given ../scoped-policy.json, the unlisted key
# ../unlisted-policy.json and the broad key ../../agent-boundary/reader-policy.json through mc admin (../keys.sh). Everything is removed at the end. Run it under the team's
# docker lock; it touches only the container and the network it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46"
MC_IMAGE="pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd"
NAME="prc2-scope-silo"
NET="prc2-scope-silo-net"
PORT=19410
SERVER=silo
START() {
  MINIO_ROOT_USER="$S3_SCOPE_ROOT_KEY" MINIO_ROOT_PASSWORD="$S3_SCOPE_ROOT_SECRET" docker run -d --name "$NAME" \
    --network "$NET" -p "127.0.0.1:$PORT:9000" -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -e MINIO_UPDATE=off \
    "$IMAGE" server /data >/dev/null
}
READY="/minio/health/ready"
. "$here/../keys.sh"
