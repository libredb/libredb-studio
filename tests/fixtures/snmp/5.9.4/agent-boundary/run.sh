#!/bin/sh
# Captures what the docker/snmp fixture (Net-SNMP snmpd 5.9.4) answers the SNMP agent's reads, the withheld security
# and target subtrees read raw, and a raw Set, into boundary.json beside this script (tests/live/snmp-agent-boundary.ts).
#
#   sh tests/fixtures/snmp/5.9.4/agent-boundary/run.sh
#
# A fresh container of the image docker/snmp builds, on its own port, removed at the end. The raw Set is sent here, with
# the image's own snmpset, never by Studio, and only the agent's reason is kept: the community is read inside the
# container from its own snmpd.conf and never printed. Run it under the team's docker lock; it touches only the
# container it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="libredb-fixture/snmp:5.9.4"
NAME="pr315-agent-snmp"
PORT=19161

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker build -q -t "$IMAGE" "$repo/docker/snmp" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:161/udp" "$IMAGE" >/dev/null
# Asked inside the container, with the community its own configuration names, so this script never holds it.
ask='c=$(awk '"'"'$1=="rocommunity"{print $2}'"'"' /etc/snmp/snmpd.conf);'
i=0
until docker exec "$NAME" sh -c "$ask snmpget -v2c -c \"\$c\" -t 1 -r 0 127.0.0.1 .1.3.6.1.2.1.1.5.0" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: $NAME never answered" >&2; exit 1; }
  sleep 1
done

# The raw Set, reduced to the reason line the agent's answer carries; snmpset prints no community.
set_reason="$(docker exec "$NAME" sh -c "$ask snmpset -v2c -c \"\$c\" -t 2 -r 0 127.0.0.1 .1.3.6.1.2.1.1.5.0 s changed 2>&1 || true" | grep '^Reason:' || echo 'no reason line')"

cd "$repo"
SNMP_AGENT_PORT="$PORT" SNMP_AGENT_OUT="$here" SNMP_AGENT_SET="$set_reason" bun tests/live/snmp-agent-boundary.ts
