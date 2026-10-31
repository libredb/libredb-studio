#!/usr/bin/env bash
# Re-records every capture in this directory on a fresh digest-pinned influxdb:2.9.1 server:
#
#   tests/fixtures/influxdb/2.9.1/agent-boundary/run.sh
#
# The server is a container named <INFLUX_PREFIX>influxdb2 (default prefix libredb-agent-) on 127.0.0.1:INFLUX_PORT (default
# 18086), removed with its volumes when the run ends. The setup user's password and the operator token are generated
# here for the run, and every other token is minted by the server; all are handed to the probe in the environment, and
# no capture holds any of them.
#
# The seed: org libredb with buckets home and other; the tokens ro (read on home), rwhome (read and write on home),
# rwother (read on home, write on other) and readother (read on home and other, write on other); two points in home
# and one in other.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e"
prefix="${INFLUX_PREFIX:-libredb-agent-}"
port="${INFLUX_PORT:-18086}"
operator="$(openssl rand -hex 24)"
cleanup() { docker rm -f -v "${prefix}influxdb2" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "${prefix}influxdb2" -p "127.0.0.1:$port:8086" --memory 1g \
  -e DOCKER_INFLUXDB_INIT_MODE=setup -e DOCKER_INFLUXDB_INIT_USERNAME=admin \
  -e DOCKER_INFLUXDB_INIT_PASSWORD="$(openssl rand -hex 16)" -e DOCKER_INFLUXDB_INIT_ORG=libredb \
  -e DOCKER_INFLUXDB_INIT_BUCKET=home -e DOCKER_INFLUXDB_INIT_ADMIN_TOKEN="$operator" \
  -e INFLUXD_REPORTING_DISABLED=true "$image" >/dev/null
url="http://127.0.0.1:$port"
# The setup runs on a first server, then the image restarts it; the org answers once the second one is up.
until curl -fs -o /dev/null "$url/api/v2/orgs?org=libredb" -H "Authorization: Token $operator"; do sleep 1; done

api() { # api <method> <path> [json body]: an operator request, which must succeed
  curl -fsS -X "$1" "$url$2" -H "Authorization: Token $operator" ${3:+-H 'Content-Type: application/json'} \
    ${3:+--data-binary "$3"}
}
field() { # field <dotted path>: one value of the JSON on stdin
  node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(process.argv[1].split(".").reduce((o, k) => o[k], v))' "$1"
}
org="$(api GET '/api/v2/orgs?org=libredb' | field orgs.0.id)"
home="$(api GET "/api/v2/buckets?orgID=$org&name=home" | field buckets.0.id)"
other="$(api POST /api/v2/buckets "{\"orgID\":\"$org\",\"name\":\"other\",\"retentionRules\":[]}" | field id)"
permission() { printf '{"action":"%s","resource":{"type":"buckets","orgID":"%s","id":"%s"}}' "$1" "$org" "$2"; }
token() { # token <description> <permission>...: a new token's value
  local description="$1" permissions
  shift
  permissions="$(IFS=,; echo "$*")"
  api POST /api/v2/authorizations "{\"orgID\":\"$org\",\"description\":\"$description\",\"permissions\":[$permissions]}" |
    field token
}
ro="$(token ro "$(permission read "$home")")"
rwhome="$(token rwhome "$(permission read "$home")" "$(permission write "$home")")"
rwother="$(token rwother "$(permission read "$home")" "$(permission write "$other")")"
readother="$(token readother "$(permission read "$home")" "$(permission read "$other")" "$(permission write "$other")")"
printf 'home,room=Kitchen temp=21 1600000000000000000\nhome,room=Living temp=22 1600000360000000000\n' |
  curl -fsS -X POST "$url/api/v2/write?org=libredb&bucket=home" -H "Authorization: Token $operator" --data-binary @-
printf 'm v=1 1600000000000000000\n' |
  curl -fsS -X POST "$url/api/v2/write?org=libredb&bucket=other" -H "Authorization: Token $operator" --data-binary @-

INFLUX_URL="$url" INFLUX_OPERATOR="$operator" INFLUX_RO="$ro" INFLUX_RWHOME="$rwhome" INFLUX_RWOTHER="$rwother" \
  INFLUX_READOTHER="$readother" node "$dir/../../agent-boundary-probe.mjs" 2.9.1
