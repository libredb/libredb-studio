#!/usr/bin/env bash
# Re-records every capture in this directory on a fresh digest-pinned Weaviate 1.40.2 server:
#
#   tests/fixtures/weaviate/1.40.2/data-scope/run.sh
#
# One container named <WEAVIATE_PREFIX>weaviate-scope (default prefix libredb-scope-), API keys, RBAC on, anonymous
# access off, no module, on 127.0.0.1:WEAVIATE_PORT (default 18393), removed with its volume when the run ends. The
# root key is generated here for the run and handed to the probe in the environment; the probe creates every other user
# and its key on the server. No capture holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="cr.weaviate.io/semitechnologies/weaviate:1.40.2@sha256:0083587dc01f33112e5406ce9b471df1abea480c71a0407af903929a389ae08a"
prefix="${WEAVIATE_PREFIX:-libredb-scope-}"
port="${WEAVIATE_PORT:-18393}"
root="$(openssl rand -hex 24)"
cleanup() {
  docker rm -f -v "${prefix}weaviate-scope" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name "${prefix}weaviate-scope" -p "127.0.0.1:$port:8080" \
  -e PERSISTENCE_DATA_PATH=/var/lib/weaviate -e DISABLE_TELEMETRY=true -e DEFAULT_VECTORIZER_MODULE=none \
  -e CLUSTER_HOSTNAME=node1 -e API_BASED_MODULES_DISABLED=true --memory 1g --cpus 2 \
  -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false -e AUTHENTICATION_APIKEY_ENABLED=true \
  -e AUTHENTICATION_APIKEY_ALLOWED_KEYS="$root" -e AUTHENTICATION_APIKEY_USERS=root \
  -e AUTHENTICATION_DB_USERS_ENABLED=true -e AUTHORIZATION_RBAC_ENABLED=true -e AUTHORIZATION_RBAC_ROOT_USERS=root \
  "$image" --host 0.0.0.0 --port 8080 --scheme http >/dev/null

until curl -fs -o /dev/null "http://127.0.0.1:$port/v1/.well-known/ready"; do sleep 1; done

WEAVIATE_URL="http://127.0.0.1:$port" WEAVIATE_ROOT="$root" node "$dir/../../data-scope-probe.mjs"
