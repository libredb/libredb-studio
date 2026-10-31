#!/bin/sh
# Captures what the pinned OPC UA fixture (Microsoft OPC PLC 2.15.10) answers the agent's reads, what the withheld
# nodes answer read raw anonymously, as a user and as an administrator, and what a raw Write and a raw Call do, into
# boundary.json beside this script (tests/live/opcua-agent-boundary.ts).
#
#   sh tests/fixtures/opcua/2.15.10/agent-boundary/run.sh
#
# Two fresh containers of the pinned image on their own loopback ports, removed at the end: the fixture exactly as
# tests/fixtures/opcua/README.md starts it, and the same with a non-privileged user and an administrator whose
# passwords this script generates for the run. The passwords reach the capture script through its environment and are
# never printed or written; the capture records no credential value at all. The raw Write and the raw Call are sent by
# the capture script on its own client, never by Studio. Run it under the team's docker lock; it touches only the two
# containers it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="mcr.microsoft.com/iotedge/opc-plc:2.15.10@sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c"
ANON="pr318-agent-opcua"
USERS="pr318-agent-opcua-users"
ANON_PORT=54928
USERS_PORT=54929
FLAGS="--pn=50000 --autoaccept --unsecuretransport --ut --sph --hn --slownodes=3 --fastnodes=3"

cleanup() {
  docker rm -f "$ANON" "$USERS" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

user_secret="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
admin_secret="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"

# shellcheck disable=SC2086
docker run -d --name "$ANON" -p "127.0.0.1:$ANON_PORT:50000" "$IMAGE" $FLAGS >/dev/null
# shellcheck disable=SC2086
docker run -d --name "$USERS" -p "127.0.0.1:$USERS_PORT:50000" "$IMAGE" $FLAGS \
  --du probe-user --dc "$user_secret" --au probe-admin --ac "$admin_secret" >/dev/null

for name in "$ANON" "$USERS"; do
  i=0
  until docker logs "$name" 2>&1 | grep -q "PLC simulation started"; do
    i=$((i + 1))
    [ "$i" -lt 90 ] || { echo "run.sh: $name never started" >&2; exit 1; }
    sleep 1
  done
done

cd "$repo"
OPCUA_AGENT_ANON_PORT="$ANON_PORT" OPCUA_AGENT_USERS_PORT="$USERS_PORT" OPCUA_AGENT_OUT="$here" \
  OPCUA_AGENT_USER_SECRET="$user_secret" OPCUA_AGENT_ADMIN_SECRET="$admin_secret" \
  bun tests/live/opcua-agent-boundary.ts
