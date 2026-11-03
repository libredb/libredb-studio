#!/bin/sh
# Replays the Sparkplug agent boundary through MCP's run_sparkplug_read into boundary.json beside this script
# (tests/live/sparkplug-mcp-boundary.ts): the fixture's own Mosquitto 2.0.22 broker (docker/sparkplug/mosquitto.conf,
# anonymous, as the fixture is) and a second one whose anonymous ACL reads spBv1.0/SekoyaPlant/# alone, each with the
# fixture's own publisher on it, each on its own loopback port, all removed at the end.
#
#   sh tests/fixtures/sparkplug/mosquitto-2.0.22/mcp-boundary/run.sh
#
# This provider sends no credential, so none is made and none is recorded. Run it under the team's docker lock; it
# touches only what it names (containers prefixed SPARKPLUG_PREFIX, default prc3-).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
MOSQUITTO_IMAGE="eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21"
PUBLISHER_IMAGE="python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4"
prefix="${SPARKPLUG_PREFIX:-prc3-}"
BROKER="${prefix}mcp-sparkplug"
NARROW="${prefix}mcp-sparkplug-acl"
PUBLISHER="${prefix}mcp-sparkplug-publisher"
NARROW_PUBLISHER="${prefix}mcp-sparkplug-acl-publisher"
PORT="${SPARKPLUG_MCP_PORT:-17895}"
NARROW_PORT="${SPARKPLUG_MCP_ACL_PORT:-17896}"
work=""

cleanup() {
  docker rm -f -v "$BROKER" "$NARROW" "$PUBLISHER" "$NARROW_PUBLISHER" >/dev/null 2>&1 || true
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
cleanup
work="$(mktemp -d)"

# The narrow broker: the fixture's own settings, with an ACL whose anonymous rules (those before any user line) read
# one group and write the namespace, so the fixture's publisher, anonymous as the reader is, publishes every group.
cat > "$work/mosquitto.conf" <<CONF
listener 1883 0.0.0.0
allow_anonymous true
acl_file /mosquitto/config/acl
persistence false
log_dest stdout
log_type all
CONF
cat > "$work/acl" <<CONF
topic read spBv1.0/SekoyaPlant/#
topic write spBv1.0/#
CONF
chmod -R a+rX "$work"

docker run -d --name "$BROKER" -p "127.0.0.1:$PORT:1883" \
  -v "$repo/docker/sparkplug/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" "$MOSQUITTO_IMAGE" >/dev/null
docker run -d --name "$NARROW" -p "127.0.0.1:$NARROW_PORT:1883" \
  -v "$work/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" -v "$work/acl:/mosquitto/config/acl:ro" \
  "$MOSQUITTO_IMAGE" >/dev/null

for name in "$BROKER" "$NARROW"; do
  i=0
  until docker exec "$name" mosquitto_sub -t 'spBv1.0/ready' -C 1 -W 1 -E >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 30 ] || { echo "run.sh: $name never answered" >&2; exit 1; }; sleep 1
  done
done
docker run -d --name "$PUBLISHER" --network "container:$BROKER" -v "$repo/docker/sparkplug:/publisher:ro" \
  "$PUBLISHER_IMAGE" python3 /publisher/publisher.py --host 127.0.0.1 --port 1883 >/dev/null
docker run -d --name "$NARROW_PUBLISHER" --network "container:$NARROW" -v "$repo/docker/sparkplug:/publisher:ro" \
  "$PUBLISHER_IMAGE" python3 /publisher/publisher.py --host 127.0.0.1 --port 1883 >/dev/null
i=0
until docker exec "$BROKER" mosquitto_sub -t 'spBv1.0/#' -C 1 -W 3 >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "run.sh: the publisher never published" >&2; exit 1; }; sleep 1
done
sleep 3

cd "$repo"
SPARKPLUG_PORT="$PORT" SPARKPLUG_ACL_PORT="$NARROW_PORT" SPARKPLUG_BROKER="$BROKER" SPARKPLUG_IMAGE="$MOSQUITTO_IMAGE" \
  SPARKPLUG_OUT="$here" bun tests/live/sparkplug-mcp-boundary.ts
