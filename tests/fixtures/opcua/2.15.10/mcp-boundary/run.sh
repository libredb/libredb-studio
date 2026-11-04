#!/bin/sh
# Captures what MCP's run_opcua_read answers on the pinned OPC UA fixture (Microsoft OPC PLC 2.15.10) into
# boundary.json beside this script (tests/live/opcua-mcp-boundary.ts).
#
#   sh tests/fixtures/opcua/2.15.10/mcp-boundary/run.sh
#
# One fresh container of the pinned image, started as tests/fixtures/opcua/README.md starts it with a non-privileged
# user and an administrator added, on a port Docker picks, removed at the end. The two passwords are made here for the
# run and reach the capture script through its environment; they are never printed or written, and the capture
# records no credential value. OPCUA_MCP_CONTAINER names the container. Run it under the team's docker lock; it
# touches only the container it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="mcr.microsoft.com/iotedge/opc-plc:2.15.10@sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c"
NAME="${OPCUA_MCP_CONTAINER:-opcua-mcp-boundary}"
FLAGS="--pn=50000 --autoaccept --unsecuretransport --ut --sph --hn --slownodes=3 --fastnodes=3"

cleanup() {
  docker unpause "$NAME" >/dev/null 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

user_secret="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
admin_secret="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"

# shellcheck disable=SC2086
docker run -d --name "$NAME" -p "127.0.0.1::50000" "$IMAGE" $FLAGS \
  --du probe-user --dc "$user_secret" --au probe-admin --ac "$admin_secret" >/dev/null
port="$(docker port "$NAME" 50000/tcp | head -n 1 | sed 's/.*://')"

i=0
until docker logs "$NAME" 2>&1 | grep -q "PLC simulation started"; do
  i=$((i + 1))
  [ "$i" -lt 90 ] || { echo "run.sh: $NAME never started" >&2; exit 1; }
  sleep 1
done

cd "$repo"
OPCUA_MCP_PORT="$port" OPCUA_MCP_OUT="$here" OPCUA_MCP_CONTAINER="$NAME" OPCUA_MCP_IMAGE="$IMAGE" \
  OPCUA_MCP_USER_SECRET="$user_secret" OPCUA_MCP_ADMIN_SECRET="$admin_secret" \
  bun tests/live/opcua-mcp-boundary.ts
