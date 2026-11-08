#!/bin/sh
# Captures MCP's run_mtconnect_read boundary into boundary.json beside this script
# (tests/live/mtconnect-mcp-boundary.ts): the compose fixture's adapter (docker/mtconnect-init/adapter.py), an MQTT broker
# and three agents of the pinned image reading the adapter, one with the fixture's own agent.cfg (AllowPut = false), one
# with AllowPut = true and one with an MqttService sink to the broker, each on its own loopback port, all removed at the
# end. The script pauses and unpauses the first agent for the timeout and cancel probes.
#
#   sh tests/fixtures/mtconnect/2.8.0.4/mcp-boundary/run.sh
#
# The raw PUT requests (the positive control and the probe assets) are sent by the capture script with fetch, never by
# Studio. The fixture has no credential; the probe asset's URL carries an obviously fake one, which the capture records
# only as whether an answer carried it. Run it under the team's docker lock; it touches only what it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
AGENT_IMAGE="mtconnect/agent:2.8.0.4@sha256:c42f90850ab70d65ae5e73b14392b3041ed51065bd7bf287658db6f7260df641"
ADAPTER_IMAGE="python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4"
BROKER_IMAGE="eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21"
NETWORK="pr422-mtconnect"
ADAPTER="pr422-mtconnect-adapter"
BROKER="pr422-mtconnect-broker"
AGENT="pr422-mtconnect"
PUT_AGENT="pr422-mtconnect-put"
SINK_AGENT="pr422-mtconnect-sink"
PORT=17422
PUT_PORT=17423
SINK_PORT=17424
work="$(mktemp -d)"

cleanup() {
  docker unpause "$AGENT" >/dev/null 2>&1 || true
  docker rm -f "$AGENT" "$PUT_AGENT" "$SINK_AGENT" "$BROKER" "$ADAPTER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup
work="$(mktemp -d)"

mkdir -p "$work/put" "$work/sink" "$work/broker"
cp "$repo/docker/mtconnect-init/devices.xml" "$work/put/devices.xml"
cp "$repo/docker/mtconnect-init/devices.xml" "$work/sink/devices.xml"
sed 's/^AllowPut = false$/AllowPut = true/' "$repo/docker/mtconnect-init/agent.cfg" > "$work/put/agent.cfg"
grep -q '^AllowPut = true$' "$work/put/agent.cfg"
cp "$repo/docker/mtconnect-init/agent.cfg" "$work/sink/agent.cfg"
cat >> "$work/sink/agent.cfg" <<'CFG'
Sinks {
  MqttService {
    MqttHost = mqtt-broker
    MqttPort = 1883
  }
}
CFG
printf 'listener 1883\nallow_anonymous true\n' > "$work/broker/mosquitto.conf"
chmod -R a+rX "$work"

docker network create "$NETWORK" >/dev/null
# The aliases are the names the agents' configurations dial, as in database-compose.yml.
docker run -d --name "$ADAPTER" --network "$NETWORK" --network-alias mtconnect-adapter \
  -v "$repo/docker/mtconnect-init:/fixture:ro" "$ADAPTER_IMAGE" python /fixture/adapter.py >/dev/null
docker run -d --name "$BROKER" --network "$NETWORK" --network-alias mqtt-broker \
  -v "$work/broker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" "$BROKER_IMAGE" >/dev/null
docker run -d --name "$AGENT" --network "$NETWORK" -v "$repo/docker/mtconnect-init:/mtconnect/config:ro" \
  -p "127.0.0.1:$PORT:5000" "$AGENT_IMAGE" >/dev/null
docker run -d --name "$PUT_AGENT" --network "$NETWORK" -v "$work/put:/mtconnect/config:ro" \
  -p "127.0.0.1:$PUT_PORT:5000" "$AGENT_IMAGE" >/dev/null
docker run -d --name "$SINK_AGENT" --network "$NETWORK" -v "$work/sink:/mtconnect/config:ro" \
  -p "127.0.0.1:$SINK_PORT:5000" "$AGENT_IMAGE" >/dev/null

for port in "$PORT" "$PUT_PORT" "$SINK_PORT"; do
  i=0
  until curl -fsS "http://127.0.0.1:$port/current" 2>/dev/null | grep -q 'ESTABLISHED'; do
    i=$((i + 1))
    [ "$i" -lt 90 ] || { echo "run.sh: the agent on $port never read its adapter" >&2; exit 1; }
    sleep 1
  done
done
# The sink agent connects to the broker itself; its log says when.
i=0
until docker logs "$SINK_AGENT" 2>&1 | grep -q 'MQTT Connected'; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "run.sh: the sink agent never reached the broker" >&2; exit 1; }
  sleep 1
done

cd "$repo"
MTCONNECT_MCP_PORT="$PORT" MTCONNECT_MCP_PUT_PORT="$PUT_PORT" MTCONNECT_MCP_SINK_PORT="$SINK_PORT" \
  MTCONNECT_MCP_PAUSE="$AGENT" MTCONNECT_MCP_OUT="$here" bun tests/live/mtconnect-mcp-boundary.ts
