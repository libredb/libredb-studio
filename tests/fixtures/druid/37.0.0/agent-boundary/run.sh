#!/usr/bin/env bash
# Re-records every capture in this directory, in file order, on a fresh digest-pinned apache/druid:37.0.0 cluster:
#
#   tests/fixtures/druid/37.0.0/agent-boundary/run.sh unsecured   # 00 to 03, allowAll, the repo's druid profile
#   tests/fixtures/druid/37.0.0/agent-boundary/run.sh secured     # 04 to 07, druid-basic-security
#
# Each run starts cluster.yml (the seven services of database-compose.yml's druid profile) under its own compose
# project, DRUID_PROJECT, default libredb-druid-agent, with the Router on 127.0.0.1:DRUID_ROUTER_PORT, default 18888,
# and removes it, volumes included, when it ends. The unsecured run applies docker/druid-init/apply.sh first. The
# metadata store's, the admin's, the internal client's and the users' passwords are generated here for the run,
# unless the environment already sets them, and handed to the cluster and probe.mjs in the environment; no capture
# prints any of them. Each capture depends on the ones before it in its run: 00 writes the million-row datasource
# 03 cancels a read of, and 04 makes the users 05 to 07 sign in as. 03's seconds differ run to run.
set -euo pipefail
mode="$1"
dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$dir/../../../../.." && pwd)"
export DRUID_PROJECT="${DRUID_PROJECT:-libredb-druid-agent}"
export DRUID_ROUTER_PORT="${DRUID_ROUTER_PORT:-18888}"
export DRUID_INIT_DIR="$repo/docker/druid-init"
export DRUID_METADATA_PASSWORD="${DRUID_METADATA_PASSWORD:-$(openssl rand -hex 16)}"
export DRUID_ADMIN_PASSWORD="${DRUID_ADMIN_PASSWORD:-$(openssl rand -hex 16)}"
export DRUID_INTERNAL_PASSWORD="${DRUID_INTERNAL_PASSWORD:-$(openssl rand -hex 16)}"
export DRUID_USER_PASSWORD="${DRUID_USER_PASSWORD:-$(openssl rand -hex 16)}"
extensions='"druid-histogram", "druid-datasketches", "druid-lookups-cached-global", "postgresql-metadata-storage", "druid-multi-stage-query"'
case "$mode" in
  unsecured)
    export DRUID_EXTENSIONS="[$extensions]" DRUID_AUTHENTICATORS='["allowAll"]' DRUID_AUTHORIZERS='["allowAll"]' \
      DRUID_ESCALATOR=noop ;;
  secured)
    export DRUID_EXTENSIONS="[$extensions, \"druid-basic-security\"]" DRUID_AUTHENTICATORS='["basic"]' \
      DRUID_AUTHORIZERS='["basic"]' DRUID_ESCALATOR=basic ;;
  *) echo "usage: $0 unsecured|secured" >&2; exit 2 ;;
esac
router="http://127.0.0.1:$DRUID_ROUTER_PORT"
compose() { docker compose -p "$DRUID_PROJECT" -f "$dir/cluster.yml" "$@"; }
trap 'compose down -v >/dev/null 2>&1 || true' EXIT
compose up -d
until curl -fs "$router/status/health" | grep -q true; do sleep 3; done
# The Broker answers SQL a little after the Router is healthy.
until curl -fs -o /dev/null -u "admin:$DRUID_ADMIN_PASSWORD" -H 'content-type: application/json' \
  -d '{"query":"SELECT 1"}' "$router/druid/v2/sql"; do sleep 3; done

run() {
  node "$dir/probe.mjs" "$router" "$dir/$1.json" > "$dir/$1.txt"
}

if [ "$mode" = unsecured ]; then
  DRUID_URL="$router" bash "$DRUID_INIT_DIR/apply.sh" > /dev/null
  run 00-setup-unsecured
  run 01-writes-and-engine-overrides-unsecured
  run 02-statement-text-unsecured
  run 03-cancel-and-timeout-unsecured
else
  run 04-setup-as-admin
  run 05-own-permissions-as-each-user
  run 06-writes-and-reads-as-each-user
  run 07-cancel-as-each-user
fi
