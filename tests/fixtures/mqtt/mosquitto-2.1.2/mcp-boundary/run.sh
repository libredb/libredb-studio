#!/bin/sh
# Replays the MQTT agent boundary through MCP's run_mqtt_read into boundary.json beside this script
# (tests/live/mqtt-mcp-boundary.ts): a Mosquitto 2.1.2 broker with authentication on and an ACL file, one user that may
# read every topic, one that may read factory/# alone and one that may read and write, and a stock EMQX 5.8.9 broker,
# each on its own loopback port, all removed at the end.
#
#   sh tests/fixtures/mqtt/mosquitto-2.1.2/mcp-boundary/run.sh
#
# The user names and passwords are made for the run and passed to the probe through the environment; the capture
# records neither, and the probe refuses to write a capture that holds one. The retained topics are published, and a
# live client holds its own client id, with the broker's own clients, never by Studio. Run it under the team's docker
# lock; it touches only what it names (containers prefixed MQTT_PREFIX, default prc3-).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
MOSQUITTO_IMAGE="eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f"
EMQX_IMAGE="emqx/emqx:5.8.9@sha256:35b46f7aa7a0d51f3959e4344221ac5ec7f948b03e43099286b6c40a07bb393b"
prefix="${MQTT_PREFIX:-prc3-}"
BROKER="${prefix}mcp-mosquitto"
EMQX="${prefix}mcp-emqx"
PORT="${MQTT_MCP_PORT:-17893}"
EMQX_PORT="${MQTT_MCP_EMQX_PORT:-17894}"
work=""

cleanup() {
  docker rm -f -v "$BROKER" "$EMQX" >/dev/null 2>&1 || true
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
cleanup
work="$(mktemp -d)"

suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
MQTT_BROAD_USER="broad-$suffix"
MQTT_BROAD_SECRET="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
MQTT_NARROW_USER="narrow-$suffix"
MQTT_NARROW_SECRET="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
MQTT_WRITER_USER="writer-$suffix"
MQTT_WRITER_SECRET="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export MQTT_BROAD_USER MQTT_BROAD_SECRET MQTT_NARROW_USER MQTT_NARROW_SECRET MQTT_WRITER_USER MQTT_WRITER_SECRET

cat > "$work/mosquitto.conf" <<CONF
listener 1883 0.0.0.0
allow_anonymous false
password_file /mosquitto/config/passwd
acl_file /mosquitto/config/acl
persistence false
log_dest stdout
log_type all
connection_messages true
CONF
cat > "$work/acl" <<CONF
user $MQTT_BROAD_USER
topic read #

user $MQTT_NARROW_USER
topic read factory/#

user $MQTT_WRITER_USER
topic readwrite #
CONF
: > "$work/passwd"
chmod -R a+rwX "$work"
for pair in "$MQTT_BROAD_USER:$MQTT_BROAD_SECRET" "$MQTT_NARROW_USER:$MQTT_NARROW_SECRET" "$MQTT_WRITER_USER:$MQTT_WRITER_SECRET"; do
  docker run --rm -v "$work:/w" --entrypoint mosquitto_passwd "$MOSQUITTO_IMAGE" -b /w/passwd "${pair%%:*}" "${pair#*:}" >/dev/null 2>&1
done
docker run -d --name "$BROKER" -p "127.0.0.1:$PORT:1883" \
  -v "$work/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$work/passwd:/mosquitto/config/passwd:ro" -v "$work/acl:/mosquitto/config/acl:ro" \
  "$MOSQUITTO_IMAGE" >/dev/null
docker run -d --name "$EMQX" -p "127.0.0.1:$EMQX_PORT:1883" "$EMQX_IMAGE" >/dev/null

i=0
until docker exec "$BROKER" mosquitto_sub -u "$MQTT_WRITER_USER" -P "$MQTT_WRITER_SECRET" -t 'factory/ready' -W 1 -C 1 -E >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "run.sh: Mosquitto never answered" >&2; exit 1; }; sleep 1
done
i=0
until docker exec "$EMQX" emqx ctl status 2>/dev/null | grep -q 'is started'; do
  i=$((i + 1)); [ "$i" -lt 90 ] || { echo "run.sh: EMQX never started" >&2; exit 1; }; sleep 1
done

cd "$repo"
MQTT_PORT="$PORT" MQTT_EMQX_PORT="$EMQX_PORT" MQTT_BROKER="$BROKER" MQTT_EMQX="$EMQX" MQTT_OUT="$here" \
  MQTT_IMAGE="$MOSQUITTO_IMAGE" MQTT_EMQX_IMAGE="$EMQX_IMAGE" bun tests/live/mqtt-mcp-boundary.ts
