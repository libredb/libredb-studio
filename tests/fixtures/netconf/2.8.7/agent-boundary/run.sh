#!/bin/sh
# Captures what the docker/netconf fixture (Netopeer2 2.8.7) answers the NETCONF agent's reads, the withheld nodes read
# raw, and a raw edit-config, into boundary.json beside this script (tests/live/netconf-agent-boundary.ts).
#
#   sh tests/fixtures/netconf/2.8.7/agent-boundary/run.sh
#
# A fresh container of the image docker/netconf builds, on its own port, removed at the end. The three fixture
# credentials are generated here for this run alone and passed by environment, never printed and never written to a
# file, so the capture holds none of them. Run it under the team's docker lock; it touches only the container it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="libredb-fixture/netconf:2.8.7"
NAME="pr316-agent-netconf"
PORT=18831

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

ro="$(openssl rand -hex 16)"
docker build -q -t "$IMAGE" "$repo/docker/netconf" >/dev/null
LIBREDB_NETCONF_RO_PASSWORD="$ro" \
LIBREDB_NETCONF_ROOT_PASSWORD="$(openssl rand -hex 16)" \
LIBREDB_NETCONF_KEY_PASSPHRASE="$(openssl rand -hex 16)" \
  docker run -d --name "$NAME" -e LIBREDB_NETCONF_INTERFACES=3 \
  -e LIBREDB_NETCONF_RO_PASSWORD -e LIBREDB_NETCONF_ROOT_PASSWORD -e LIBREDB_NETCONF_KEY_PASSPHRASE \
  -p "127.0.0.1:$PORT:830" "$IMAGE" >/dev/null
i=0
until docker exec "$NAME" test -f /fixture/.ready 2>/dev/null && ssh-keyscan -T 3 -p "$PORT" 127.0.0.1 2>&1 | grep -q SSH-2.0; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { echo "run.sh: $NAME never answered" >&2; exit 1; }
  sleep 2
done
fingerprint="$(docker exec "$NAME" sh -c 'ssh-keyscan -T 5 -p 830 127.0.0.1 2> /dev/null | ssh-keygen -lf - | awk "{print \$2}"' | head -1)"

cd "$repo"
NETCONF_AGENT_PORT="$PORT" NETCONF_AGENT_OUT="$here" NETCONF_AGENT_PASSWORD="$ro" NETCONF_AGENT_FINGERPRINT="$fingerprint" \
  bun tests/live/netconf-agent-boundary.ts
