#!/usr/bin/env bash
# Re-records boundary.json in this directory on fresh digest-pinned Milvus 3.0.2 servers:
#
#   tests/fixtures/milvus/3.0.2/mcp-boundary/run.sh
#
# Two containers named <MILVUS_PREFIX>* (default prefix libredb-mcp-), each following Milvus's standalone_embed.sh at
# tag v3.0.2 as docker/milvus/README.md describes, removed with their volumes when the run ends:
#   milvus-auth  authorization on, on 127.0.0.1:MILVUS_PORT (default 19634)
#   milvus-open  authorization off, on MILVUS_PORT + 1
# tests/live/milvus-mcp-boundary.ts drives MCP's run_milvus_read against them, and pauses milvus-auth for the limits.
# root's password on both is generated here for the run and written into a user.yaml in a temporary directory removed
# when the run ends; the script makes every other user's password. Nothing written holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$dir/../../../../.." && pwd)"
image="milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0"
prefix="${MILVUS_PREFIX:-libredb-mcp-}"
port="${MILVUS_PORT:-19634}"
root_password="$(openssl rand -hex 16)"
config=""
cleanup() {
  docker unpause "${prefix}milvus-auth" >/dev/null 2>&1 || true
  docker rm -f -v "${prefix}milvus-auth" "${prefix}milvus-open" >/dev/null 2>&1 || true
  if [ -n "$config" ]; then rm -rf -- "$config"; fi
}
trap cleanup EXIT
cleanup
config="$(mktemp -d)"
chmod 755 "$config"
for mode in auth open; do
  enabled=true
  if [ "$mode" = open ]; then enabled=false; fi
  cat >"$config/user-$mode.yaml" <<YAML
common:
  security:
    authorizationEnabled: $enabled
    defaultRootPassword: $root_password
YAML
  chmod 644 "$config/user-$mode.yaml"
done

start() {
  docker run -d --name "${prefix}milvus-$1" --security-opt seccomp:unconfined --memory 3g --cpus 2 \
    -e ETCD_USE_EMBED=true -e ETCD_DATA_DIR=/var/lib/milvus/etcd -e ETCD_CONFIG_PATH=/milvus/configs/embedEtcd.yaml \
    -e COMMON_STORAGETYPE=local -e DEPLOY_MODE=STANDALONE \
    -v "$repo/docker/milvus/embedEtcd.yaml:/milvus/configs/embedEtcd.yaml:ro" \
    -v "$config/user-$1.yaml:/milvus/configs/user.yaml:ro" \
    -p "127.0.0.1:$2:19530" "$image" milvus run standalone >/dev/null
}
start auth "$port"
start open "$((port + 1))"

for name in auth open; do
  until [ "$(docker exec "${prefix}milvus-$name" curl -fs http://localhost:9091/healthz 2>/dev/null || true)" = OK ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "${prefix}milvus-$name")" != true ]; then
      echo "${prefix}milvus-$name exited" >&2
      exit 1
    fi
    sleep 2
  done
done

MILVUS_MCP_AUTH_TARGET="127.0.0.1:$port" MILVUS_MCP_OPEN_TARGET="127.0.0.1:$((port + 1))" \
  MILVUS_MCP_CONTAINER="${prefix}milvus-auth" MILVUS_MCP_ROOT_PASSWORD="$root_password" MILVUS_MCP_OUT="$dir" \
  bun "$dir/../../../../live/milvus-mcp-boundary.ts"
