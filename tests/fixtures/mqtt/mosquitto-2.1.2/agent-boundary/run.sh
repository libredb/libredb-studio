#!/bin/sh
# Captures the MQTT agent path's boundary into boundary.json beside this script (tests/live/mqtt-agent-boundary.ts):
# a Mosquitto 2.1.2 broker with authentication on, one user that may only read and one that may read and write, and a
# stock EMQX 5.8.9 broker, each on its own loopback port, all removed at the end.
#
#   sh tests/fixtures/mqtt/mosquitto-2.1.2/agent-boundary/run.sh
#
# The user names and passwords are made for the run and passed to the probe through the environment; the capture
# records neither, and the probe refuses to write a capture that holds one. The raw PUBLISH, the raw wildcard and
# $share subscriptions and the raw $SYS reads are sent by this script and the probe with the broker's own clients and
# the provider's session, never by agent mode. Run it under the team's docker lock; it touches only what it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
MOSQUITTO_IMAGE="eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f"
EMQX_IMAGE="emqx/emqx:5.8.9@sha256:35b46f7aa7a0d51f3959e4344221ac5ec7f948b03e43099286b6c40a07bb393b"
BROKER="pr320-agent-mosquitto"
EMQX="pr320-agent-emqx"
SYS_READER="pr320-agent-emqx-sys"
DEVICE="pr320-agent-emqx-device"
PORT=17883
EMQX_PORT=17884
work="$(mktemp -d)"

cleanup() {
  docker rm -f "$BROKER" "$EMQX" "$SYS_READER" "$DEVICE" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cleanup
work="$(mktemp -d)"

suffix="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
MQTT_AGENT_USER="reader-$suffix"
MQTT_AGENT_SECRET="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
MQTT_WRITER_USER="writer-$suffix"
MQTT_WRITER_SECRET="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export MQTT_AGENT_USER MQTT_AGENT_SECRET MQTT_WRITER_USER MQTT_WRITER_SECRET

cat > "$work/mosquitto.conf" <<CONF
listener 1883 0.0.0.0
allow_anonymous false
password_file /mosquitto/config/passwd
acl_file /mosquitto/config/acl
persistence false
sys_interval 1
CONF
cat > "$work/acl" <<CONF
user $MQTT_AGENT_USER
topic read #
topic read \$SYS/#

user $MQTT_WRITER_USER
topic readwrite #
topic read \$SYS/#
CONF
: > "$work/passwd"
chmod -R a+rwX "$work"
docker run --rm -v "$work:/w" --entrypoint mosquitto_passwd "$MOSQUITTO_IMAGE" -b /w/passwd "$MQTT_AGENT_USER" "$MQTT_AGENT_SECRET" >/dev/null 2>&1
docker run --rm -v "$work:/w" --entrypoint mosquitto_passwd "$MOSQUITTO_IMAGE" -b /w/passwd "$MQTT_WRITER_USER" "$MQTT_WRITER_SECRET" >/dev/null 2>&1
docker run -d --name "$BROKER" -p "127.0.0.1:$PORT:1883" \
  -v "$work/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$work/passwd:/mosquitto/config/passwd:ro" -v "$work/acl:/mosquitto/config/acl:ro" \
  "$MOSQUITTO_IMAGE" >/dev/null
docker run -d --name "$EMQX" -p "127.0.0.1:$EMQX_PORT:1883" "$EMQX_IMAGE" >/dev/null

i=0
until docker exec "$BROKER" mosquitto_sub -u "$MQTT_WRITER_USER" -P "$MQTT_WRITER_SECRET" -t '$SYS/broker/version' -C 1 -W 2 >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "run.sh: Mosquitto never answered" >&2; exit 1; }; sleep 1
done
i=0
until docker exec "$EMQX" emqx ctl status 2>/dev/null | grep -q 'is started'; do
  i=$((i + 1)); [ "$i" -lt 90 ] || { echo "run.sh: EMQX never started" >&2; exit 1; }; sleep 1
done

# Each broker's $SYS tree is read raw from before a device client connects until after, so an event a broker publishes
# when a client connects is in the read. The device's id and user name are what the probe looks for. EMQX serves $SYS
# to loopback only, so its raw read runs inside its network namespace.
docker exec -d "$BROKER" sh -c "mosquitto_sub -u '$MQTT_WRITER_USER' -P '$MQTT_WRITER_SECRET' -v -t '\$SYS/#' -W 6 > /tmp/sys.txt 2>/dev/null"
docker run -d --name "$SYS_READER" --network "container:$EMQX" --entrypoint mosquitto_sub "$MOSQUITTO_IMAGE" \
  -h 127.0.0.1 -v -t '$SYS/#' -W 6 >/dev/null
sleep 1
docker exec -d "$BROKER" mosquitto_sub -i device-ayse-yilmaz-01 -u "$MQTT_WRITER_USER" -P "$MQTT_WRITER_SECRET" -t keep/alive -W 600
docker run -d --name "$DEVICE" --network "container:$EMQX" --entrypoint mosquitto_sub "$MOSQUITTO_IMAGE" \
  -h 127.0.0.1 -i device-ayse-yilmaz-01 -u device-user-ayse -t keep/alive -W 600 >/dev/null
sleep 7
docker exec "$BROKER" cat /tmp/sys.txt > "$work/mosquitto-sys.txt"
docker logs "$SYS_READER" > "$work/emqx-sys.txt" 2>/dev/null

cd "$repo"
MQTT_PORT="$PORT" MQTT_EMQX_PORT="$EMQX_PORT" MQTT_BROKER="$BROKER" MQTT_WORK="$work" MQTT_OUT="$here" \
  bun tests/live/mqtt-agent-boundary.ts
