#!/usr/bin/env bash
# The Druid object-surface fixture (#789), applied.
#
# Druid's image has NO init-script directory: a datasource is not created by DDL at
# all (the grammar has no CREATE, measured on 37.0.0), it comes into existence by
# being ingested into, and a lookup is registered through the Coordinator's own API.
# So the fixture is a set of task specs plus a lookup map, and this script is what
# applies them. It is mounted into the Router at /opt/druid-init, so it can be run
# either from the repo or from inside the container:
#
#   bash docker/druid-init/apply.sh
#   docker exec libredb-druid-router bash /opt/druid-init/apply.sh
#
# It is idempotent: re-ingesting the same intervals replaces the segments, and the
# lookup map is a PUT-shaped POST of the whole tier.
#
# DRUID_URL defaults to the Router, which fronts both the SQL endpoint and - because
# druid_router_managementProxy_enabled is set in database-compose.yml - the
# Coordinator and Overlord APIs, so one port is enough for all of it.
set -euo pipefail

DRUID_URL="${DRUID_URL:-http://localhost:8888}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The image ships wget and no curl, so both are supported and neither is required.
post() {
  local path="$1" file="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -s -S -X POST -H 'Content-Type: application/json' --data "@${file}" "${DRUID_URL}${path}"
  else
    wget -q -O - --header='Content-Type: application/json' --post-file="${file}" "${DRUID_URL}${path}"
  fi
  echo
}

get() {
  if command -v curl >/dev/null 2>&1; then curl -s "${DRUID_URL}$1"; else wget -q -O - "${DRUID_URL}$1"; fi
}

echo "Waiting for the Router to answer..."
until get /status/health | grep -q true; do sleep 2; done

# The lookup store refuses the first write until it has been initialized with an
# empty map (measured: "Not initialized. If this is the first lookup, post an empty
# map to initialize"), and initializing twice is harmless.
echo "Initializing the lookup store..."
printf '{}' > /tmp/druid-init-empty.json
post /druid/coordinator/v1/lookups/config /tmp/druid-init-empty.json

# The lookup version is stamped per run rather than fixed. Measured: re-posting a
# lookup whose version does not sort ABOVE the stored one is refused with HTTP 500 and
# "can't replace existing spec", so a fixed version makes the script fail the second
# time it is applied. The comparison is a string compare, which is why the stamp keeps
# the "v" prefix: "v1789128374" sorts above "v1", while a bare epoch sorts below it
# because a digit is below a letter.
echo "Registering the lookups..."
sed "s/__VERSION__/$(date +%s)/" "${HERE}/00-lookups.json" > /tmp/druid-init-lookups.json
post /druid/coordinator/v1/lookups/config /tmp/druid-init-lookups.json

echo "Submitting the ingestion tasks..."
for spec in "${HERE}"/0[0-9]-datasource-*.json; do
  echo "  ${spec}"
  post /druid/indexer/v1/task "${spec}"
done

echo "Waiting for the tasks to finish..."
until [ "$(get '/druid/indexer/v1/tasks?state=running' | tr ',' '\n' | grep -c '"id"' || true)" = "0" ]; do sleep 5; done

# A lookup reaches SQL only once the Broker has LOADED it, and the Coordinator
# propagates on its own period. A lookup that is registered and not yet loaded has no
# INFORMATION_SCHEMA.TABLES row at all, so the fixture is not ready until this is true.
echo "Waiting for the lookups to load on every node..."
until ! get /druid/coordinator/v1/lookups/status | grep -q '"loaded":false'; do sleep 5; done

echo "Waiting for the datasources to appear in SQL..."
until [ "$(get '/druid/v2/datasources' | tr ',' '\n' | grep -c libredb || true)" -ge 4 ]; do sleep 5; done

echo "Fixture applied."
