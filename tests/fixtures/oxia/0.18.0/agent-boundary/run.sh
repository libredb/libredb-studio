#!/usr/bin/env bash
# Re-records every capture in this directory on two fresh digest-pinned Oxia 0.18.0 servers:
#
#   tests/fixtures/oxia/0.18.0/agent-boundary/run.sh
#
# Two containers named <OXIA_PREFIX>open and <OXIA_PREFIX>auth (default prefix libredb-agent-oxia-), plaintext, on
# 127.0.0.1:OXIA_OPEN_PORT and 127.0.0.1:OXIA_AUTH_PORT (defaults 26648 and 26678), removed when the run ends. The
# first is a standalone server with two shards and no authentication. The second is a coordinator and a data server
# in one container with the OIDC provider on a static key, which the probe generates for the run into a scratch
# directory removed when the run ends; no capture holds a key or a token.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="oxia/oxia:0.18.0@sha256:65f9898d531c3ca48a3277247650200c8065435fd542ea9a81e51c37b90fff60"
prefix="${OXIA_PREFIX:-libredb-agent-oxia-}"
open_port="${OXIA_OPEN_PORT:-26648}"
auth_port="${OXIA_AUTH_PORT:-26678}"
issuer="https://issuer.libredb-fixture.invalid"
keys=""
cleanup() {
  docker rm -f -v "${prefix}open" "${prefix}auth" >/dev/null 2>&1 || true
  rm -rf "$keys"
}
trap cleanup EXIT
cleanup
keys="$(mktemp -d)"
probe="$dir/../../../../live/oxia-agent-boundary.ts"
bun "$probe" keygen "$keys"
chmod 644 "$keys/jwt.pub"
printf 'namespaces:\n  - name: default\n    initialShardCount: 2\n    replicationFactor: 1\nservers:\n  - public: localhost:%s\n    internal: localhost:6649\n' \
  "$auth_port" >"$keys/cluster.yaml"
chmod 644 "$keys/cluster.yaml"
docker run -d --name "${prefix}open" -p "127.0.0.1:$open_port:$open_port" "$image" \
  oxia standalone --shards 2 --public-addr "0.0.0.0:$open_port" --data-dir /data/db --wal-dir /data/wal >/dev/null
docker run -d --name "${prefix}auth" -p "127.0.0.1:$auth_port:$auth_port" \
  -v "$keys/jwt.pub:/keys/jwt.pub:ro" -v "$keys/cluster.yaml:/keys/cluster.yaml:ro" "$image" sh -c "
    oxia coordinator --cconfig /keys/cluster.yaml --metadata file --file-clusters-status-path /tmp/status.json -i 0.0.0.0:6652 -p 0.0.0.0:6651 -m 0.0.0.0:6653 &
    exec oxia server -p 0.0.0.0:$auth_port -i 0.0.0.0:6649 -m 0.0.0.0:8080 --data-dir /data/db --wal-dir /data/wal \
      --auth-provider-name oidc \
      --auth-provider-params '{\"issuers\":{\"$issuer\":{\"allowedAudiences\":\"oxia\",\"userNameClaim\":\"sub\",\"staticKeyFile\":\"/keys/jwt.pub\"}}}'" >/dev/null
until docker exec "${prefix}open" oxia client -a "localhost:$open_port" --request-timeout 3s list -s / -e /0 >/dev/null 2>&1; do sleep 1; done
until docker exec "${prefix}auth" oxia health --host localhost --port 6649 --timeout 3s >/dev/null 2>&1; do sleep 1; done
# The coordinator assigns the shards after the data server answers health.
sleep 5
OXIA_OPEN_TARGET="127.0.0.1:$open_port" OXIA_AUTH_TARGET="localhost:$auth_port" OXIA_KEY_DIR="$keys" \
  OXIA_ISSUER="$issuer" OXIA_IMAGE="$image" OXIA_OUT="$dir" bun "$probe"
