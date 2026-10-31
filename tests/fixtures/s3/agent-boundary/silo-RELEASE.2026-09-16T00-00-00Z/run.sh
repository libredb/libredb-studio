#!/bin/sh
# Captures what Silo RELEASE.2026-09-16T00-00-00Z answers the S3 agent's reads and every call its closed table refuses
# (tests/live/s3-agent-boundary.ts), into boundary.json beside this script.
#
#   sh tests/fixtures/s3/agent-boundary/silo-RELEASE.2026-09-16T00-00-00Z/run.sh
#
# A fresh digest-pinned server on its own network and port, a root key and a reader key made for the run and kept in
# this shell's environment only, the reader given ../reader-policy.json through mc admin, and everything removed at
# the end. Run it under the team's docker lock; it touches only the containers and the network it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46"
MC_IMAGE="pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd"
NAME="pr313-agent-silo"
NET="pr313-agent-silo-net"
PORT=19310

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
MINIO_ROOT_USER="$S3_AGENT_ROOT_KEY" MINIO_ROOT_PASSWORD="$S3_AGENT_ROOT_SECRET" docker run -d --name "$NAME" \
  --network "$NET" -p "127.0.0.1:$PORT:9000" -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -e MINIO_UPDATE=off \
  "$IMAGE" server /data >/dev/null
i=0
until curl -fsS -o /dev/null 2>/dev/null "http://127.0.0.1:$PORT/minio/health/ready"; do
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
S3_AGENT_SERVER=silo S3_AGENT_IMAGE="$IMAGE" S3_AGENT_PORT="$PORT" S3_AGENT_OUT="$here" \
  bun tests/live/s3-agent-boundary.ts
