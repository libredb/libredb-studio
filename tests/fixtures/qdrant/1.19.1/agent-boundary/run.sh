#!/usr/bin/env bash
# Re-records every capture in this directory on fresh digest-pinned Qdrant 1.19.1 servers:
#
#   tests/fixtures/qdrant/1.19.1/agent-boundary/run.sh
#
# Three containers named <QDRANT_PREFIX>* (default prefix libredb-agent-) on one network of their own, removed with
# their volumes and the network when the run ends:
#   qdrant-auth  an API key, a read-only API key and JWT RBAC, the qdrant-auth fixture's configuration, on
#                127.0.0.1:QDRANT_PORT (default 18633); its inference address is the listener below
#   qdrant-open  no key at all, on QDRANT_PORT + 1
#   egress       a listener the inference address points at, which prints one EGRESS line per request it is sent and
#                answers 500; no request ever leaves the network
# Both keys, and so the JWT signing secret, are generated here for the run, written into a configuration file in a
# temporary directory removed when the run ends, and handed to the probe in the environment; the probe mints every JWT
# from the API key. No capture holds any of them.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="ghcr.io/qdrant/qdrant/qdrant:v1.19.1@sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822"
listener="python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4"
prefix="${QDRANT_PREFIX:-libredb-agent-}"
port="${QDRANT_PORT:-18633}"
network="${prefix}qdrant-net"
full="$(openssl rand -hex 32)"
readonly_key="$(openssl rand -hex 32)"
config=""
cleanup() {
  docker rm -f -v "${prefix}qdrant-auth" "${prefix}qdrant-open" "${prefix}egress" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ -n "$config" ]; then rm -rf -- "$config"; fi
}
trap cleanup EXIT
cleanup
config="$(mktemp -d)"
chmod 755 "$config"
cat >"$config/local.yaml" <<YAML
service:
  api_key: $full
  read_only_api_key: $readonly_key
  jwt_rbac: true
inference:
  address: http://egress:8000/infer
YAML
chmod 644 "$config/local.yaml"
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

common=(-e QDRANT__TELEMETRY_DISABLED=true --memory 1g --cpus 2)
docker run -d --name "${prefix}qdrant-auth" --network "$network" -p "127.0.0.1:$port:6333" "${common[@]}" \
  -v "$config/local.yaml:/qdrant/config/local.yaml:ro" "$image" >/dev/null
docker run -d --name "${prefix}qdrant-open" --network "$network" -p "127.0.0.1:$((port + 1)):6333" "${common[@]}" \
  "$image" >/dev/null

for p in "$port" "$((port + 1))"; do
  until curl -fs -o /dev/null "http://127.0.0.1:$p/readyz"; do sleep 1; done
done

QDRANT_URL="http://127.0.0.1:$port" QDRANT_OPEN_URL="http://127.0.0.1:$((port + 1))" QDRANT_FULL="$full" \
  QDRANT_READ_ONLY="$readonly_key" QDRANT_EGRESS="${prefix}egress" node "$dir/../../agent-boundary-probe.mjs"
