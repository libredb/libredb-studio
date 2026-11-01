#!/bin/sh
# Captures the Sparkplug agent path's boundary (tests/live/sparkplug-agent-boundary.ts) into one boundary.json per
# broker: the fixture's own Mosquitto 2.0.22 broker (docker/sparkplug/mosquitto.conf, anonymous, as the fixture is)
# into the one beside this script, and a stock EMQX 5.8.9 into ../../emqx-5.8.9/agent-boundary/, each with the
# fixture's own publisher on it, each on its own loopback port, all removed at the end.
#
#   sh tests/fixtures/sparkplug/mosquitto-2.0.22/agent-boundary/run.sh
#
# This provider sends no credential, so none is made and none is recorded. The raw NCMD, the raw wildcard, $sparkplug,
# STATE and $share subscriptions are sent by the probe with the broker's own client and the provider's session, never
# by agent mode. Run it under the team's docker lock; it touches only what it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
MOSQUITTO_IMAGE="eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21"
EMQX_IMAGE="emqx/emqx:5.8.9@sha256:35b46f7aa7a0d51f3959e4344221ac5ec7f948b03e43099286b6c40a07bb393b"
PUBLISHER_IMAGE="python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4"
BROKER="pr321-agent-mosquitto"
EMQX="pr321-agent-emqx"
PUBLISHER="pr321-agent-publisher"
EMQX_PUBLISHER="pr321-agent-emqx-publisher"
PORT=17885
EMQX_PORT=17886

cleanup() {
  docker rm -f "$BROKER" "$EMQX" "$PUBLISHER" "$EMQX_PUBLISHER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name "$BROKER" -p "127.0.0.1:$PORT:1883" \
  -v "$repo/docker/sparkplug/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" "$MOSQUITTO_IMAGE" >/dev/null
docker run -d --name "$EMQX" -p "127.0.0.1:$EMQX_PORT:1883" "$EMQX_IMAGE" >/dev/null

i=0
until docker exec "$BROKER" mosquitto_sub -t '$SYS/broker/version' -C 1 -W 2 >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "run.sh: Mosquitto never answered" >&2; exit 1; }; sleep 1
done
i=0
until docker exec "$EMQX" emqx ctl status 2>/dev/null | grep -q 'is started'; do
  i=$((i + 1)); [ "$i" -lt 90 ] || { echo "run.sh: EMQX never started" >&2; exit 1; }; sleep 1
done

docker run -d --name "$PUBLISHER" --network "container:$BROKER" -v "$repo/docker/sparkplug:/publisher:ro" \
  "$PUBLISHER_IMAGE" python3 /publisher/publisher.py --host 127.0.0.1 --port 1883 >/dev/null
docker run -d --name "$EMQX_PUBLISHER" --network "container:$EMQX" -v "$repo/docker/sparkplug:/publisher:ro" \
  "$PUBLISHER_IMAGE" python3 /publisher/publisher.py --host 127.0.0.1 --port 1883 >/dev/null
i=0
until docker exec "$BROKER" mosquitto_sub -t 'spBv1.0/#' -C 1 -W 3 >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "run.sh: the publisher never published" >&2; exit 1; }; sleep 1
done
sleep 3

cd "$repo"
SPARKPLUG_PORT="$PORT" SPARKPLUG_EMQX_PORT="$EMQX_PORT" SPARKPLUG_BROKER="$BROKER" SPARKPLUG_EMQX="$EMQX" \
  SPARKPLUG_CLIENT_IMAGE="$MOSQUITTO_IMAGE" SPARKPLUG_OUT="$here/../.." bun tests/live/sparkplug-agent-boundary.ts
