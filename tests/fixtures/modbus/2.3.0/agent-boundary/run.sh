#!/bin/sh
# Captures the Modbus agent path's boundary into boundary.json beside this script (tests/live/modbus-agent-boundary.ts):
# the pinned docker/modbus fixture (pymodbus, which serves clients concurrently) and a single-client libmodbus device
# built from single-client/ (which serves one client at a time), each a fresh container on its own port, removed at
# the end.
#
#   sh tests/fixtures/modbus/2.3.0/agent-boundary/run.sh
#
# The raw writes are sent by the capture script on its own socket, never by Studio. Modbus has no credential, so the
# capture holds none. Run it under the team's docker lock; it touches only the containers it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="oitc/modbus-server:2.3.0@sha256:32bfe144512e1f070cf7e7e2513cdcb774d74db142ee5dbad45b21d6d705ab97"
SINGLE_IMAGE="libredb-fixture/modbus-single-client:capture"
NAME="pr317-agent-modbus"
SINGLE_NAME="pr317-agent-modbus-single"
PORT=19502
SINGLE_PORT=19503

cleanup() {
  docker rm -f "$NAME" "$SINGLE_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker build -q -t "$SINGLE_IMAGE" "$here/single-client" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5020" \
  -v "$repo/docker/modbus/modbus_server.json:/app/modbus_server.json:ro" "$IMAGE" >/dev/null
docker run -d --name "$SINGLE_NAME" -p "127.0.0.1:$SINGLE_PORT:502" "$SINGLE_IMAGE" >/dev/null

cd "$repo"
for probe in "$PORT" "$SINGLE_PORT"; do
  i=0
  until MODBUS_PROBE="127.0.0.1:$probe" bun tests/live/modbus-ready-probe.ts --tables >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || { echo "run.sh: 127.0.0.1:$probe never answered" >&2; exit 1; }
    sleep 1
  done
done

MODBUS_AGENT_PORT="$PORT" MODBUS_AGENT_SINGLE_PORT="$SINGLE_PORT" MODBUS_AGENT_OUT="$here" bun tests/live/modbus-agent-boundary.ts
