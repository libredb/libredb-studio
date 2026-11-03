#!/usr/bin/env bash
# Re-records every capture in this directory on a fresh digest-pinned Milvus 3.0.2 server:
#
#   tests/fixtures/milvus/3.0.2/mcp-scope/run.sh
#
# One container named <MILVUS_PREFIX>milvus-scope (default prefix libredb-scope-), following Milvus's
# standalone_embed.sh at tag v3.0.2 as docker/milvus/README.md describes, authorization on, on 127.0.0.1:MILVUS_PORT
# (default 19632), removed with its volumes when the run ends.
# root's password is generated here for the run and written into a user.yaml in a temporary directory removed when the
# run ends; the probe generates every other user's password. No capture holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$dir/../../../../.." && pwd)"
image="milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0"
prefix="${MILVUS_PREFIX:-libredb-scope-}"
port="${MILVUS_PORT:-19632}"
root_password="$(openssl rand -hex 16)"
config=""
cleanup() {
  docker rm -f -v "${prefix}milvus-scope" >/dev/null 2>&1 || true
  if [ -n "$config" ]; then rm -rf -- "$config"; fi
}
trap cleanup EXIT
cleanup
config="$(mktemp -d)"
chmod 755 "$config"
cat >"$config/user.yaml" <<YAML
common:
  security:
    authorizationEnabled: true
    defaultRootPassword: $root_password
YAML
chmod 644 "$config/user.yaml"

docker run -d --name "${prefix}milvus-scope" --security-opt seccomp:unconfined --memory 3g --cpus 2 \
  -e ETCD_USE_EMBED=true -e ETCD_DATA_DIR=/var/lib/milvus/etcd -e ETCD_CONFIG_PATH=/milvus/configs/embedEtcd.yaml \
  -e COMMON_STORAGETYPE=local -e DEPLOY_MODE=STANDALONE \
  -v "$repo/docker/milvus/embedEtcd.yaml:/milvus/configs/embedEtcd.yaml:ro" \
  -v "$config/user.yaml:/milvus/configs/user.yaml:ro" \
  -p "127.0.0.1:$port:19530" "$image" milvus run standalone >/dev/null

until [ "$(docker exec "${prefix}milvus-scope" curl -fs http://localhost:9091/healthz 2>/dev/null || true)" = OK ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "${prefix}milvus-scope")" != true ]; then
    echo "${prefix}milvus-scope exited" >&2
    exit 1
  fi
  sleep 2
done

MILVUS_AUTH_TARGET="127.0.0.1:$port" MILVUS_ROOT_PASSWORD="$root_password" bun "$dir/../../mcp-scope-probe.ts"
