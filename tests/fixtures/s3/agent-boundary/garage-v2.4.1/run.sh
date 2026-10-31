#!/bin/sh
# Captures what Garage v2.4.1 answers the S3 agent's reads and every call its closed table refuses
# (tests/live/s3-agent-boundary.ts), into boundary.json beside this script.
#
#   sh tests/fixtures/s3/agent-boundary/garage-v2.4.1/run.sh
#
# A fresh digest-pinned single node on its own network and port, with docker/s3/garage.toml, its RPC secret, admin
# and metrics tokens and two keys made for the run and kept in this shell's environment only. Garage has no users or
# policies, only per-key grants on a bucket, so a one-shot applies the layout, creates the two buckets through the
# admin API and grants the reader key read alone and the root key read, write and owner on each. Everything is
# removed at the end. Run it under the team's docker lock; it touches only the containers and the network it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020"
CURL_IMAGE="alpine/curl:8.21.0@sha256:a1c44bab54d88e18ea9a6a4ecefab7f2d230b968567b78960fcaff8d51b7f067"
NAME="pr313-agent-garage"
NET="pr313-agent-garage-net"
PORT=19330

GARAGE_RPC_SECRET="$(openssl rand -hex 32)"
GARAGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
GARAGE_METRICS_TOKEN="$(openssl rand -hex 24)"
S3_AGENT_ROOT_KEY="GK$(openssl rand -hex 12)"
S3_AGENT_ROOT_SECRET="$(openssl rand -hex 32)"
S3_AGENT_READER_KEY="GK$(openssl rand -hex 12)"
S3_AGENT_READER_SECRET="$(openssl rand -hex 32)"
export GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN
export S3_AGENT_ROOT_KEY S3_AGENT_ROOT_SECRET S3_AGENT_READER_KEY S3_AGENT_READER_SECRET

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null
# The values reach the container through the environment by name only, so no secret is on a command line.
docker run -d --name "$NAME" --network "$NET" -p "127.0.0.1:$PORT:3900" \
  -e GARAGE_RPC_SECRET -e GARAGE_ADMIN_TOKEN -e GARAGE_METRICS_TOKEN \
  -v "$repo/docker/s3/garage.toml:/etc/garage.toml:ro" "$IMAGE" >/dev/null

T="$GARAGE_ADMIN_TOKEN" RK="$S3_AGENT_ROOT_KEY" RS="$S3_AGENT_ROOT_SECRET" AK="$S3_AGENT_READER_KEY" \
  AS="$S3_AGENT_READER_SECRET" docker run --rm --network "$NET" -e T -e RK -e RS -e AK -e AS \
  --entrypoint sh "$CURL_IMAGE" -c '
    set -eu
    admin="http://'"$NAME"':3903"
    api() { curl -fsS -X "$1" -H "Authorization: Bearer $T" -H "Content-Type: application/json" ${3:+--data-binary "$3"} "$admin$2"; }
    i=0
    until status="$(api GET /v2/GetClusterStatus 2>/dev/null)"; do
      i=$((i + 1)); [ "$i" -lt 60 ] || { echo "GetClusterStatus never answered" >&2; exit 1; }; sleep 1
    done
    node="$(printf "%s" "$status" | tr -d " \n" | sed -n "s/.*\"id\":\"\([0-9a-f]*\)\".*/\1/p")"
    api POST /v2/UpdateClusterLayout "{\"roles\":[{\"id\":\"$node\",\"zone\":\"dc1\",\"capacity\":1073741824,\"tags\":[]}]}" >/dev/null
    api POST /v2/ApplyClusterLayout "{\"version\":1}" >/dev/null
    api POST /v2/ImportKey "{\"accessKeyId\":\"$RK\",\"secretAccessKey\":\"$RS\",\"name\":\"root\"}" >/dev/null
    api POST /v2/ImportKey "{\"accessKeyId\":\"$AK\",\"secretAccessKey\":\"$AS\",\"name\":\"reader\"}" >/dev/null
    for bucket in agent-demo agent-versions; do
      id="$(api POST /v2/CreateBucket "{\"globalAlias\":\"$bucket\"}" | tr -d " \n" | sed -n "s/^{\"id\":\"\([0-9a-f]*\)\".*/\1/p")"
      [ -n "$id" ] || { echo "CreateBucket $bucket answered no id" >&2; exit 1; }
      api POST /v2/AllowBucketKey "{\"bucketId\":\"$id\",\"accessKeyId\":\"$RK\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null
      api POST /v2/AllowBucketKey "{\"bucketId\":\"$id\",\"accessKeyId\":\"$AK\",\"permissions\":{\"read\":true,\"write\":false,\"owner\":false}}" >/dev/null
    done
    i=0
    until api GET /v2/GetClusterHealth | tr -d " \n" | grep -q "\"status\":\"healthy\""; do
      i=$((i + 1)); [ "$i" -lt 60 ] || { echo "GetClusterHealth never answered healthy" >&2; exit 1; }; sleep 1
    done
  '

cd "$repo"
S3_AGENT_SERVER=garage S3_AGENT_IMAGE="$IMAGE" S3_AGENT_PORT="$PORT" S3_AGENT_OUT="$here" \
  bun tests/live/s3-agent-boundary.ts
