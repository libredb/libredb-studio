#!/bin/sh
# Captures what RustFS 1.0.1 answers the S3 agent's reads and every call its closed table refuses
# (tests/live/s3-agent-boundary.ts), into boundary.json beside this script.
#
#   sh tests/fixtures/s3/agent-boundary/rustfs-1.0.1/run.sh
#
# A fresh digest-pinned server on its own network and port, a root key and a reader key made for the run and kept in
# this shell's environment only, the reader given ../reader-policy.json through mc admin, and everything removed at
# the end. Run it under the team's docker lock; it touches only the containers and the network it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c"
MC_IMAGE="pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd"
NAME="pr313-agent-rustfs"
NET="pr313-agent-rustfs-net"
PORT=19320

S3_AGENT_ROOT_KEY="root$(openssl rand -hex 6)"
S3_AGENT_ROOT_SECRET="$(openssl rand -hex 20)"
S3_AGENT_READER_KEY="reader$(openssl rand -hex 6)"
S3_AGENT_READER_SECRET="$(openssl rand -hex 20)"
export S3_AGENT_ROOT_KEY S3_AGENT_ROOT_SECRET S3_AGENT_READER_KEY S3_AGENT_READER_SECRET

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null
# The values reach the container through the environment by name only, so no secret is on a command line.
RUSTFS_ACCESS_KEY="$S3_AGENT_ROOT_KEY" RUSTFS_SECRET_KEY="$S3_AGENT_ROOT_SECRET" docker run -d --name "$NAME" \
  --network "$NET" -p "127.0.0.1:$PORT:9000" -e RUSTFS_ACCESS_KEY -e RUSTFS_SECRET_KEY -e RUSTFS_CHECK_UPDATE=false \
  "$IMAGE" >/dev/null
i=0
until curl -fsS -o /dev/null 2>/dev/null "http://127.0.0.1:$PORT/health/ready"; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: $NAME never became ready" >&2; exit 1; }
  sleep 1
done

R="$S3_AGENT_ROOT_KEY" S="$S3_AGENT_ROOT_SECRET" RK="$S3_AGENT_READER_KEY" RS="$S3_AGENT_READER_SECRET" \
  docker run --rm --network "$NET" -e R -e S -e RK -e RS -e MC_CONFIG_DIR=/tmp/.mc \
  -v "$here/../reader-policy.json:/policy.json:ro" --entrypoint sh "$MC_IMAGE" -c '
    set -eu
    mc alias set fx http://'"$NAME"':9000 "$R" "$S" >/dev/null
    mc admin user add fx "$RK" "$RS" >/dev/null
    mc admin policy create fx agent-reader /policy.json >/dev/null
    mc admin policy attach fx agent-reader --user "$RK" >/dev/null
  '

cd "$repo"
S3_AGENT_SERVER=rustfs S3_AGENT_IMAGE="$IMAGE" S3_AGENT_PORT="$PORT" S3_AGENT_OUT="$here" \
  bun tests/live/s3-agent-boundary.ts
