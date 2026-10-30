#!/usr/bin/env bash
# Re-records every capture in this directory on three fresh digest-pinned 5.26.31 servers:
#
#   export NEO4J_ACCEPT_LICENSE_AGREEMENT=<your answer>   # see below
#   tests/fixtures/neo4j/5.26.31/agent-boundary/run.sh
#
# Two servers run Neo4j Enterprise Edition, whose licence only the person running this script can accept, so the
# script neither sets nor defaults the variable the image reads: it refuses to start unless you exported it yourself,
# and passes your value through to those two containers unchanged.
#
# The servers are containers named <NEO4J_PREFIX>neo4j-ee, -ext and -ce (default prefix libredb-agent-) on
# 127.0.0.1:NEO4J_EE_PORT, NEO4J_EXT_PORT and NEO4J_CE_PORT (defaults 17687, 17688 and 17689), removed with their
# volumes when the run ends. -ee is a stock Enterprise server, -ext the same image with the test extension of
# extension/ in its plugins directory, compiled here with the image's own JDK into a temporary directory, and -ce the
# Community image, seeded with one node and restarted with every database read-only. The administrator's password is generated here for the run and handed
# to tests/live/neo4j-agent-captures.ts in the environment, which generates every other user's; no capture holds any
# of them. That script seeds the servers and writes the captures.
set -euo pipefail
if [ -z "${NEO4J_ACCEPT_LICENSE_AGREEMENT:-}" ]; then
  echo "run.sh starts Neo4j Enterprise Edition. Read its licence, then export NEO4J_ACCEPT_LICENSE_AGREEMENT yourself and run this again." >&2
  exit 2
fi
dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$dir/../../../../.." && pwd)"
enterprise="neo4j:5.26.31-enterprise@sha256:02d30e0a80f0aaed71cfdfaa85c8ea01cf44aacd55510d4a2b4a53f9f1a2e1ad"
community="neo4j:5.26.31-community@sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255"
prefix="${NEO4J_PREFIX:-libredb-agent-}"
ee_port="${NEO4J_EE_PORT:-17687}"
ext_port="${NEO4J_EXT_PORT:-17688}"
ce_port="${NEO4J_CE_PORT:-17689}"
admin_password="$(openssl rand -hex 16)"
build=""
cleanup() {
  docker rm -f -v "${prefix}neo4j-ee" "${prefix}neo4j-ext" "${prefix}neo4j-ce" >/dev/null 2>&1 || true
  if [ -n "$build" ]; then rm -rf "$build"; fi
}
trap cleanup EXIT
cleanup
build="$(mktemp -d)"
mkdir -p "$build/classes" "$build/plugins"

docker run --rm --user "$(id -u):$(id -g)" -v "$dir/extension:/src:ro" -v "$build:/out" --entrypoint sh "$enterprise" \
  -c 'javac -proc:none -cp "/var/lib/neo4j/lib/*" -d /out/classes /src/LibredbTestExtension.java &&
      jar cf /out/plugins/libredb-test-extension.jar -C /out/classes .'

common=(--memory 2g -e "NEO4J_AUTH=neo4j/$admin_password" -e NEO4J_server_memory_heap_max__size=512m
  -e NEO4J_server_memory_pagecache_size=128m -e NEO4J_server_bolt_telemetry_enabled=false)
docker run -d --name "${prefix}neo4j-ee" -p "127.0.0.1:$ee_port:7687" "${common[@]}" \
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT "$enterprise" >/dev/null
docker run -d --name "${prefix}neo4j-ext" -p "127.0.0.1:$ext_port:7687" "${common[@]}" \
  -e NEO4J_ACCEPT_LICENSE_AGREEMENT -v "$build/plugins:/plugins:ro" "$enterprise" >/dev/null
docker run -d --name "${prefix}neo4j-ce" -p "127.0.0.1:$ce_port:7687" "${common[@]}" "$community" >/dev/null

for name in neo4j-ee neo4j-ext neo4j-ce; do
  until docker exec -e NEO4J_USERNAME=neo4j -e NEO4J_PASSWORD="$admin_password" "${prefix}$name" \
    cypher-shell 'RETURN 1' >/dev/null 2>&1; do sleep 2; done
  # The file every LOAD CSV capture reads from the import directory.
  docker exec "${prefix}$name" sh -c 'printf "a,b\n1,2\n" > /var/lib/neo4j/import/probe.csv'
done

# Community: one node, then every database read-only. An empty store cannot start read-only and Community has no
# dbms.setConfigValue, so the setting goes into the container's neo4j.conf and the server is restarted.
ce() { docker exec -i -e NEO4J_USERNAME=neo4j -e NEO4J_PASSWORD="$admin_password" "${prefix}neo4j-ce" cypher-shell "$@"; }
echo "CREATE (:Person {name: 'Ada'});" | ce >/dev/null
docker exec "${prefix}neo4j-ce" sh -c 'echo server.databases.default_to_read_only=true >> /var/lib/neo4j/conf/neo4j.conf'
docker restart "${prefix}neo4j-ce" >/dev/null
until ce 'RETURN 1' >/dev/null 2>&1; do sleep 2; done

cd "$root"
NEO4J_PREFIX="$prefix" NEO4J_EE_PORT="$ee_port" NEO4J_EXT_PORT="$ext_port" NEO4J_CE_PORT="$ce_port" \
  NEO4J_ADMIN_PASSWORD="$admin_password" bun tests/live/neo4j-agent-captures.ts
