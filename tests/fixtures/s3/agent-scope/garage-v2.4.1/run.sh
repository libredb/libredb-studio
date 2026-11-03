#!/bin/sh
# Measures what a bucket-scoped key and a broad read key reach through the S3 agent's reads on Garage v2.4.1
# (tests/live/s3-agent-scope.ts), into scope.json beside this script.
#
#   sh tests/fixtures/s3/agent-scope/garage-v2.4.1/run.sh
#
# A fresh digest-pinned single node on its own network and a port Docker picks, with docker/s3/garage.toml, its RPC
# secret, admin and metrics tokens and four keys made for the run and kept in this shell's environment only. Garage has no users or
# policies, only per-key grants on a bucket, so a one-shot applies the layout, creates the buckets through the admin
# API and grants root read, write and owner on each, the broad key read on each, and the scoped and the unlisted key
# read on scope-granted, scope-versions and scope-objects-only alone. Everything is removed at the end. Run it under
# the team's docker lock; it touches only the containers and the network it names, S3_SCOPE_NAME when set.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020"
CURL_IMAGE="alpine/curl:8.21.0@sha256:a1c44bab54d88e18ea9a6a4ecefab7f2d230b968567b78960fcaff8d51b7f067"
NAME="${S3_SCOPE_NAME:-prc2-scope-garage}"
NET="$NAME-net"

GARAGE_RPC_SECRET="$(openssl rand -hex 32)"
GARAGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
GARAGE_METRICS_TOKEN="$(openssl rand -hex 24)"
S3_SCOPE_ROOT_KEY="GK$(openssl rand -hex 12)"
S3_SCOPE_ROOT_SECRET="$(openssl rand -hex 32)"
S3_SCOPE_SCOPED_KEY="GK$(openssl rand -hex 12)"
S3_SCOPE_SCOPED_SECRET="$(openssl rand -hex 32)"
S3_SCOPE_BROAD_KEY="GK$(openssl rand -hex 12)"
S3_SCOPE_BROAD_SECRET="$(openssl rand -hex 32)"
S3_SCOPE_UNLISTED_KEY="GK$(openssl rand -hex 12)"
S3_SCOPE_UNLISTED_SECRET="$(openssl rand -hex 32)"
export GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN GARAGE_METRICS_TOKEN
export S3_SCOPE_ROOT_KEY S3_SCOPE_ROOT_SECRET S3_SCOPE_SCOPED_KEY S3_SCOPE_SCOPED_SECRET S3_SCOPE_BROAD_KEY \
  S3_SCOPE_BROAD_SECRET S3_SCOPE_UNLISTED_KEY S3_SCOPE_UNLISTED_SECRET

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null
# The values reach the container through the environment by name only, so no secret is on a command line.
docker run -d --name "$NAME" --network "$NET" -p "127.0.0.1::3900" \
  -e GARAGE_RPC_SECRET -e GARAGE_ADMIN_TOKEN -e GARAGE_METRICS_TOKEN \
  -v "$repo/docker/s3/garage.toml:/etc/garage.toml:ro" "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 3900/tcp | head -n 1 | sed 's/.*://')"

T="$GARAGE_ADMIN_TOKEN" RK="$S3_SCOPE_ROOT_KEY" RS="$S3_SCOPE_ROOT_SECRET" SK="$S3_SCOPE_SCOPED_KEY" \
  SS="$S3_SCOPE_SCOPED_SECRET" BK="$S3_SCOPE_BROAD_KEY" BS="$S3_SCOPE_BROAD_SECRET" UK="$S3_SCOPE_UNLISTED_KEY" \
  US="$S3_SCOPE_UNLISTED_SECRET" docker run --rm --network "$NET" -e T -e RK -e RS -e SK -e SS -e BK -e BS -e UK -e US \
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
    for pair in "root:$RK:$RS" "scoped:$SK:$SS" "broad:$BK:$BS" "unlisted:$UK:$US"; do
      name="${pair%%:*}"; rest="${pair#*:}"
      api POST /v2/ImportKey "{\"accessKeyId\":\"${rest%%:*}\",\"secretAccessKey\":\"${rest#*:}\",\"name\":\"$name\"}" >/dev/null
    done
    grant() { api POST /v2/AllowBucketKey "{\"bucketId\":\"$1\",\"accessKeyId\":\"$2\",\"permissions\":{\"read\":true,\"write\":$3,\"owner\":$3}}" >/dev/null; }
    for bucket in scope-granted scope-versions scope-objects-only scope-other scope-public; do
      id="$(api POST /v2/CreateBucket "{\"globalAlias\":\"$bucket\"}" | tr -d " \n" | sed -n "s/^{\"id\":\"\([0-9a-f]*\)\".*/\1/p")"
      [ -n "$id" ] || { echo "CreateBucket $bucket answered no id" >&2; exit 1; }
      grant "$id" "$RK" true
      grant "$id" "$BK" false
      case "$bucket" in scope-other|scope-public) ;; *) grant "$id" "$SK" false; grant "$id" "$UK" false ;; esac
    done
    i=0
    until api GET /v2/GetClusterHealth | tr -d " \n" | grep -q "\"status\":\"healthy\""; do
      i=$((i + 1)); [ "$i" -lt 60 ] || { echo "GetClusterHealth never answered healthy" >&2; exit 1; }; sleep 1
    done
  '

cd "$repo"
S3_SCOPE_SERVER=garage S3_SCOPE_IMAGE="$IMAGE" S3_SCOPE_PORT="$PORT" S3_SCOPE_OUT="$here" S3_SCOPE_CONTAINER="$NAME" \
  bun "${S3_SCOPE_LIVE:-tests/live/s3-agent-scope.ts}"
