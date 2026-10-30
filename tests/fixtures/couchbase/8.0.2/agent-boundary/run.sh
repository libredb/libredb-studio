#!/usr/bin/env bash
# Re-records every capture in this directory in one run, in file order, against two fresh, uninitialised nodes:
#
#   docker run -d --name <ee> couchbase/server@sha256:ad3718cf1e52acee2818a1913f80a5d3cfdaedd181947d84fa7d6765d20a079d
#   # (couchbase/server:enterprise-8.0.2)
#   docker run -d --name <ce> couchbase/server@sha256:5e3b3897fc8ee39f9fcfe697763ea22058e43a4b502e68e11ad212b6e1d96fcf
#   # (couchbase/server:community-8.0.2)
#   tests/fixtures/couchbase/8.0.2/agent-boundary/run.sh <ee-container-ip> <ce-container-ip>
#
# Each node is addressed by its container IP on 8091 and 8093, and renamed to it, so the address the cluster
# advertises is the one this host reaches. The administrator's and the users' passwords are generated here for the
# run, unless the environment already sets CB_ADMIN_PASSWORD and CB_USER_PASSWORD, and handed to probe.mjs in the
# environment; no capture prints either. 01 to 05 depend on 00, and run in order:
# 02 leaves a prepared statement and a request log entry that 03 reads back; 08 times the query service against
# role changes, so its milliseconds differ run to run.
set -euo pipefail
ee="$1"
ce="$2"
dir="$(cd "$(dirname "$0")" && pwd)"
CB_ADMIN_PASSWORD="${CB_ADMIN_PASSWORD:-$(openssl rand -hex 16)}"
CB_USER_PASSWORD="${CB_USER_PASSWORD:-$(openssl rand -hex 16)}"
export CB_ADMIN_PASSWORD CB_USER_PASSWORD

init() {
  local host="$1" services="$2" storage="$3"
  shift 3
  until curl -fs -o /dev/null "http://$host:8091/ui/index.html"; do sleep 2; done
  curl -fs -o /dev/null -X POST "http://$host:8091/node/controller/rename" -d "hostname=$host"
  curl -fs -o /dev/null -X POST "http://$host:8091/pools/default" -d memoryQuota=512 -d indexMemoryQuota=256 \
    -d ftsMemoryQuota=256 "$@"
  curl -fs -o /dev/null -X POST "http://$host:8091/node/controller/setupServices" -d "services=$services"
  curl -fs -o /dev/null -X POST "http://$host:8091/settings/web" -d port=8091 -d username=Administrator \
    --data-urlencode "password=$CB_ADMIN_PASSWORD"
  curl -fs -o /dev/null -u "Administrator:$CB_ADMIN_PASSWORD" -X POST "http://$host:8091/settings/indexes" \
    -d "storageMode=$storage"
  for bucket in probe other; do
    curl -fs -o /dev/null -u "Administrator:$CB_ADMIN_PASSWORD" -X POST "http://$host:8091/pools/default/buckets" \
      -d "name=$bucket" -d ramQuota=128 -d bucketType=couchbase
  done
  # The query service answers once the buckets are warm.
  until curl -fs -o /dev/null -u "Administrator:$CB_ADMIN_PASSWORD" "http://$host:8093/query/service" \
    --data-urlencode 'statement=SELECT RAW 1'; do sleep 2; done
  sleep 10
}

run() {
  local host="$1" file="$2"
  node "$dir/probe.mjs" "$host" "$dir/$file.json" > "$dir/$file.txt"
}

init "$ee" kv,n1ql,index,fts,eventing plasma -d eventingMemoryQuota=256
init "$ce" kv,n1ql,index,fts forestdb
run "$ee" 00-setup-as-administrator
run "$ee" 01-whoami-as-each-user
run "$ee" 02-writes-code-and-catalog-as-agent-ro
run "$ee" 03-positive-controls-as-each-refused-user
run "$ee" 04-readonly-flag-as-agent-admin
run "$ee" 05-statement-text-as-administrator
run "$ee" 07-catalog-read-as-agent-ro
node "$dir/08-revoke-window.mjs" "$ee" > "$dir/08-revoke-window.txt"
run "$ce" 06-community-edition-roles
