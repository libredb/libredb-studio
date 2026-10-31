#!/usr/bin/env bash
# Re-records every capture in this directory on a fresh digest-pinned Valkey 9.1.2 server:
#
#   tests/fixtures/redis/valkey-9.1.2/agent-boundary/run.sh
#
# One container named <REDIS_PREFIX>valkey (default prefix libredb-agent-), with the image's own configuration, so its
# `default` user is the stock `on nopass ~* &* +@all`, on 127.0.0.1:REDIS_PORT (default 16391), removed when the run
# ends. The probe generates every ACL user's password for the run; no capture holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="valkey/valkey:9.1.2@sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd"
name="${REDIS_PREFIX:-libredb-agent-}valkey"
port="${REDIS_PORT:-16391}"
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$name" -p "127.0.0.1:$port:6379" "$image" >/dev/null
until [ "$(docker exec "$name" valkey-cli ping 2>/dev/null || true)" = PONG ]; do sleep 1; done
REDIS_TARGET="127.0.0.1:$port" REDIS_IMAGE="$image" REDIS_OUT="$dir" bun "$dir/../../agent-boundary-probe.ts"
