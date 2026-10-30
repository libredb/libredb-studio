#!/usr/bin/env bash
# Re-records every capture in this directory on fresh digest-pinned Weaviate 1.40.2 servers:
#
#   tests/fixtures/weaviate/1.40.2/agent-boundary/run.sh
#
# Four containers named <WEAVIATE_PREFIX>* (default prefix libredb-agent-) on one network of their own, removed with
# their volumes and the network when the run ends:
#   weaviate-rbac     API keys, RBAC on, anonymous access off, on 127.0.0.1:WEAVIATE_PORT (default 18383); the
#                     text2vec-openai and generative-openai modules are on with a server-side provider key, the
#                     obviously fake not-a-real-key, so a collection can name a vectorizer and a read can call it
#   weaviate-keyonly  API keys, RBAC off, on WEAVIATE_PORT + 1
#   weaviate-anon     anonymous access on, no keys, on WEAVIATE_PORT + 2
#   egress            a listener every module base URL points at, which prints one EGRESS line per request it is sent
#                     and answers 500; no request ever leaves the network
# The root key of each keyed server is generated here for the run and handed to the probe in the environment; the
# probe creates every other user and its key on the server. No capture holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="cr.weaviate.io/semitechnologies/weaviate:1.40.2@sha256:0083587dc01f33112e5406ce9b471df1abea480c71a0407af903929a389ae08a"
listener="python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4"
prefix="${WEAVIATE_PREFIX:-libredb-agent-}"
port="${WEAVIATE_PORT:-18383}"
network="${prefix}weaviate-net"
root="$(openssl rand -hex 24)"
keyonly="$(openssl rand -hex 24)"
cleanup() {
  docker rm -f -v "${prefix}weaviate-rbac" "${prefix}weaviate-keyonly" "${prefix}weaviate-anon" "${prefix}egress" \
    >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create "$network" >/dev/null

docker run -d --name "${prefix}egress" --network "$network" --network-alias egress --memory 256m "$listener" \
  python -u -c '
import http.server
class Listener(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        print("EGRESS", self.command, self.path, flush=True)
        self.send_response(500)
        self.end_headers()
    do_GET = do_POST
    def log_message(self, *args):
        pass
http.server.HTTPServer(("0.0.0.0", 8000), Listener).serve_forever()' >/dev/null

common=(-e PERSISTENCE_DATA_PATH=/var/lib/weaviate -e DISABLE_TELEMETRY=true -e DEFAULT_VECTORIZER_MODULE=none
  -e CLUSTER_HOSTNAME=node1 --memory 1g --cpus 2)
docker run -d --name "${prefix}weaviate-rbac" --network "$network" -p "127.0.0.1:$port:8080" "${common[@]}" \
  -e ENABLE_MODULES=text2vec-openai,generative-openai -e OPENAI_APIKEY=not-a-real-key \
  -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false -e AUTHENTICATION_APIKEY_ENABLED=true \
  -e AUTHENTICATION_APIKEY_ALLOWED_KEYS="$root" -e AUTHENTICATION_APIKEY_USERS=root \
  -e AUTHENTICATION_DB_USERS_ENABLED=true -e AUTHORIZATION_RBAC_ENABLED=true -e AUTHORIZATION_RBAC_ROOT_USERS=root \
  "$image" --host 0.0.0.0 --port 8080 --scheme http >/dev/null
docker run -d --name "${prefix}weaviate-keyonly" --network "$network" -p "127.0.0.1:$((port + 1)):8080" "${common[@]}" \
  -e API_BASED_MODULES_DISABLED=true \
  -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=false -e AUTHENTICATION_APIKEY_ENABLED=true \
  -e AUTHENTICATION_APIKEY_ALLOWED_KEYS="$keyonly" -e AUTHENTICATION_APIKEY_USERS=keyonly \
  "$image" --host 0.0.0.0 --port 8080 --scheme http >/dev/null
docker run -d --name "${prefix}weaviate-anon" --network "$network" -p "127.0.0.1:$((port + 2)):8080" "${common[@]}" \
  -e API_BASED_MODULES_DISABLED=true -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true \
  "$image" --host 0.0.0.0 --port 8080 --scheme http >/dev/null

for p in "$port" "$((port + 1))" "$((port + 2))"; do
  until curl -fs -o /dev/null "http://127.0.0.1:$p/v1/.well-known/ready"; do sleep 1; done
done

WEAVIATE_URL="http://127.0.0.1:$port" WEAVIATE_KEYONLY_URL="http://127.0.0.1:$((port + 1))" \
  WEAVIATE_ANON_URL="http://127.0.0.1:$((port + 2))" WEAVIATE_ROOT="$root" WEAVIATE_KEYONLY="$keyonly" \
  WEAVIATE_EGRESS="${prefix}egress" node "$dir/../../agent-boundary-probe.mjs"
