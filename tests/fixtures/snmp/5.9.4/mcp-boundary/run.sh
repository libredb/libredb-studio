#!/bin/sh
# Captures what MCP's run_snmp_read answers on a Net-SNMP 5.9.4 agent built from docker/snmp into boundary.json beside
# this script (tests/live/snmp-mcp-boundary.ts).
#
#   sh tests/fixtures/snmp/5.9.4/mcp-boundary/run.sh
#
# A fresh container of the image docker/snmp builds, on a port Docker picks, removed at the end. Its configuration is
# written here for this run alone, with five communities made per run and never printed: a census one reading the
# whole tree, a broad one reading it but the device and installed-software tables, which hold no withheld subtree, so a
# walk of the host group stays under the row budget, a crossing one reading hrSystem, the running processes and their
# figures alone, so a walk of the host group crosses the processes within one page, a narrow one whose view holds the
# system group alone, and a writer, the positive control. Markers are
# planted where a credential would sit: a running process's arguments, an SNMPv3 user's keys, two notification
# targets' communities, and the extend, exec and procfix directives' commands. Run it under the team's docker lock; it
# touches only the container it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="libredb-fixture/snmp:5.9.4"
NAME="prc4-snmp-mcp"
docker rm -f "$NAME" >/dev/null 2>&1 || true
conf="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$conf"
}
trap cleanup EXIT

made() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
census="c$(made)"
broad="b$(made)"
cross="x$(made)"
narrow="n$(made)"
writer="w$(made)"

cat >"$conf/snmpd.conf" <<EOF
view all included .1
view everything included .1
view everything excluded .1.3.6.1.2.1.25.3
view everything excluded .1.3.6.1.2.1.25.6
view hostcross included .1.3.6.1.2.1.25.1
view hostcross included .1.3.6.1.2.1.25.4
view hostcross included .1.3.6.1.2.1.25.5
view systemonly included .1.3.6.1.2.1.1
rocommunity $census default -V all
rocommunity $broad default -V everything
rocommunity $cross default -V hostcross
rocommunity $narrow default -V systemonly
rwcommunity $writer default -V everything
createUser markeruser SHA markerauthpass1 AES markerprivpass1
rouser markeruser priv -V everything
trap2sink 127.0.0.1:9162 markertrapcomm1
trapsess -v 2c -c markertrapsess1 127.0.0.1:9163
extend markerext /bin/echo markerextendarg1
exec markerexec /bin/echo markerexecarg1
proc snmpd
procfix snmpd /bin/echo markerprocfix1
sysName mcp-boundary-agent
sysLocation mcp-boundary
agentaddress udp:161
EOF
cat >"$conf/start.sh" <<'EOF'
#!/bin/sh
/bin/sh -c 'sleep 100000' markercmdline1 &
exec /usr/sbin/snmpd -f -Lo -C -c /etc/snmp/snmpd.conf
EOF
chmod +x "$conf/start.sh"
chmod 644 "$conf/snmpd.conf"

docker build -q -t "$IMAGE" "$repo/docker/snmp" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1::161/udp" \
  -v "$conf/snmpd.conf:/etc/snmp/snmpd.conf:ro" -v "$conf/start.sh:/start.sh:ro" "$IMAGE" /start.sh >/dev/null
port="$(docker port "$NAME" 161/udp | head -n 1 | sed 's/.*://')"
i=0
until docker exec "$NAME" snmpget -v2c -c "$broad" -t 1 -r 0 127.0.0.1 .1.3.6.1.2.1.1.5.0 >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "run.sh: $NAME never answered" >&2; exit 1; }
  sleep 1
done

cd "$repo"
SNMP_MCP_PORT="$port" SNMP_MCP_OUT="$here" SNMP_MCP_CONTAINER="$NAME" SNMP_MCP_IMAGE="$IMAGE" \
  SNMP_MCP_CENSUS="$census" SNMP_MCP_BROAD="$broad" SNMP_MCP_CROSS="$cross" SNMP_MCP_NARROW="$narrow" SNMP_MCP_WRITER="$writer" \
  bun tests/live/snmp-mcp-boundary.ts
