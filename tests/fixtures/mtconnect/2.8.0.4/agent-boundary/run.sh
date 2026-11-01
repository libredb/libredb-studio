#!/bin/sh
# Captures the MTConnect agent path's boundary into boundary.json beside this script
# (tests/live/mtconnect-agent-boundary.ts): the compose fixture's adapter (docker/mtconnect-init/adapter.py) and two
# agents of the pinned image reading it, one with the fixture's own agent.cfg (AllowPut = false) and one with the same
# configuration but AllowPut = true, each on its own loopback port, all removed at the end.
#
#   sh tests/fixtures/mtconnect/2.8.0.4/agent-boundary/run.sh
#
# The raw PUT, POST and /cancel requests are sent by the capture script with fetch, never by Studio. The fixture has no
# credential, so the capture holds none. Run it under the team's docker lock; it touches only what it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
AGENT_IMAGE="mtconnect/agent:2.8.0.4@sha256:c42f90850ab70d65ae5e73b14392b3041ed51065bd7bf287658db6f7260df641"
ADAPTER_IMAGE="python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4"
NETWORK="pr319-agent-mtconnect"
ADAPTER="pr319-agent-mtconnect-adapter"
AGENT="pr319-agent-mtconnect"
PUT_AGENT="pr319-agent-mtconnect-put"
PORT=17393
PUT_PORT=17394
put_config="$(mktemp -d)"

cleanup() {
  docker rm -f "$AGENT" "$PUT_AGENT" "$ADAPTER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$put_config"
}
trap cleanup EXIT
cleanup
put_config="$(mktemp -d)"

cp "$repo/docker/mtconnect-init/devices.xml" "$put_config/devices.xml"
sed 's/^AllowPut = false$/AllowPut = true/' "$repo/docker/mtconnect-init/agent.cfg" > "$put_config/agent.cfg"
grep -q '^AllowPut = true$' "$put_config/agent.cfg"
chmod -R a+rX "$put_config"

docker network create "$NETWORK" >/dev/null
# The alias is the name the agent's own configuration dials, as in database-compose.yml.
docker run -d --name "$ADAPTER" --network "$NETWORK" --network-alias mtconnect-adapter \
  -v "$repo/docker/mtconnect-init:/fixture:ro" "$ADAPTER_IMAGE" python /fixture/adapter.py >/dev/null
docker run -d --name "$AGENT" --network "$NETWORK" -v "$repo/docker/mtconnect-init:/mtconnect/config:ro" \
  -p "127.0.0.1:$PORT:5000" "$AGENT_IMAGE" >/dev/null
docker run -d --name "$PUT_AGENT" --network "$NETWORK" -v "$put_config:/mtconnect/config:ro" \
  -p "127.0.0.1:$PUT_PORT:5000" "$AGENT_IMAGE" >/dev/null

for port in "$PORT" "$PUT_PORT"; do
  i=0
  until curl -fsS "http://127.0.0.1:$port/current" 2>/dev/null | grep -q 'ESTABLISHED'; do
    i=$((i + 1))
    [ "$i" -lt 90 ] || { echo "run.sh: the agent on $port never read its adapter" >&2; exit 1; }
    sleep 1
  done
done

cd "$repo"
MTCONNECT_AGENT_PORT="$PORT" MTCONNECT_AGENT_PUT_PORT="$PUT_PORT" MTCONNECT_AGENT_OUT="$here" \
  bun tests/live/mtconnect-agent-boundary.ts
