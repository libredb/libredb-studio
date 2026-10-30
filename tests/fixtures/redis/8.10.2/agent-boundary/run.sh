#!/usr/bin/env bash
# Re-records every capture in this directory on a fresh digest-pinned Redis 8.10.2 server:
#
#   tests/fixtures/redis/8.10.2/agent-boundary/run.sh
#
# One container named <REDIS_PREFIX>redis (default prefix libredb-agent-), with the image's own configuration, so its
# `default` user is the stock `on nopass ~* &* +@all`, on 127.0.0.1:REDIS_PORT (default 16390), removed when the run
# ends. The probe generates every ACL user's password for the run; no capture holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="redis:8.10.2@sha256:5c02d7c0f8d75af45958c0294a8004f2e14b42df98a1103e3a669aa7ec787be6"
name="${REDIS_PREFIX:-libredb-agent-}redis"
port="${REDIS_PORT:-16390}"
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$name" -p "127.0.0.1:$port:6379" "$image" >/dev/null
until [ "$(docker exec "$name" redis-cli ping 2>/dev/null || true)" = PONG ]; do sleep 1; done
REDIS_TARGET="127.0.0.1:$port" REDIS_IMAGE="$image" REDIS_OUT="$dir" bun "$dir/../../agent-boundary-probe.ts"
