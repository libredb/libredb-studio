#!/usr/bin/env bash
# Runs tests/live/influxdb-mcp-boundary.ts against fresh digest-pinned servers, and re-records the captures it writes
# into tests/fixtures/influxdb/1.13.1/mcp-boundary/ and tests/fixtures/influxdb/2.9.1/mcp-boundary/:
#
#   tests/fixtures/influxdb/1.13.1/mcp-boundary/run.sh
#
# Three containers, named <INFLUX_PREFIX>influxdb1, <INFLUX_PREFIX>influxdb1-noauth and <INFLUX_PREFIX>influxdb2
# (default prefix libredb-mcp-), on 127.0.0.1 at INFLUX_PORT, INFLUX_NOAUTH_PORT and INFLUX2_PORT (defaults 18097,
# 18098 and 18096), each removed with its volumes when the run ends. Every password and token is generated here for the
# run and handed to the check in the environment; no capture holds any of them.
#
# The 1.13.1 seed: databases home and other; the users reader (READ on home), wide (READ on home and other) and rw
# (READ on home, WRITE on other); two points in home and one in other; a continuous query the admin defines on home;
# and the measurement big, 200,000 points in 50 series. The 2.9.1 seed: org libredb with buckets home and other; the
# tokens ro (read on home) and rwhome (read and write on home); the same points.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$dir/../../../../.." && pwd)"
image1="influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0"
image2="influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e"
prefix="${INFLUX_PREFIX:-libredb-mcp-}"
port="${INFLUX_PORT:-18097}"
noauth_port="${INFLUX_NOAUTH_PORT:-18098}"
port2="${INFLUX2_PORT:-18096}"
admin_password="$(openssl rand -hex 16)"
reader_password="$(openssl rand -hex 16)"
wide_password="$(openssl rand -hex 16)"
rw_password="$(openssl rand -hex 16)"
operator="$(openssl rand -hex 24)"
cleanup() {
  docker rm -f -v "${prefix}influxdb1" "${prefix}influxdb1-noauth" "${prefix}influxdb2" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker run -d --name "${prefix}influxdb1" -p "127.0.0.1:$port:8086" --memory 1g \
  -e INFLUXDB_HTTP_AUTH_ENABLED=true -e INFLUXDB_ADMIN_USER=admin -e INFLUXDB_ADMIN_PASSWORD="$admin_password" \
  -e INFLUXDB_DB=home -e INFLUXDB_REPORTING_DISABLED=true "$image1" >/dev/null
docker run -d --name "${prefix}influxdb1-noauth" -p "127.0.0.1:$noauth_port:8086" --memory 1g \
  -e INFLUXDB_DB=home -e INFLUXDB_REPORTING_DISABLED=true "$image1" >/dev/null
docker run -d --name "${prefix}influxdb2" -p "127.0.0.1:$port2:8086" --memory 1g \
  -e DOCKER_INFLUXDB_INIT_MODE=setup -e DOCKER_INFLUXDB_INIT_USERNAME=admin \
  -e DOCKER_INFLUXDB_INIT_PASSWORD="$(openssl rand -hex 16)" -e DOCKER_INFLUXDB_INIT_ORG=libredb \
  -e DOCKER_INFLUXDB_INIT_BUCKET=home -e DOCKER_INFLUXDB_INIT_ADMIN_TOKEN="$operator" \
  -e INFLUXD_REPORTING_DISABLED=true "$image2" >/dev/null
url="http://127.0.0.1:$port"
noauth_url="http://127.0.0.1:$noauth_port"
url2="http://127.0.0.1:$port2"
until curl -fs -o /dev/null "$url/ping" && curl -fs -o /dev/null "$noauth_url/ping"; do sleep 1; done
until curl -fs -o /dev/null -X POST "$url/query" -u "admin:$admin_password" --data-urlencode 'q=SHOW USERS'; do sleep 1; done
until curl -fs -o /dev/null "$url2/api/v2/orgs?org=libredb" -H "Authorization: Token $operator"; do sleep 1; done

admin() { # admin <statement>: a 1.13.1 admin statement, which must answer without an error
  local answer
  answer="$(curl -fsS -X POST "$url/query" -u "admin:$admin_password" --data-urlencode "q=$1")"
  if printf '%s' "$answer" | grep -q '"error"'; then echo "seed: $1: $answer" >&2; exit 1; fi
}
write1() { # write1 <server url> <database>, line protocol on stdin
  curl -fsS -o /dev/null -X POST "$1/write?db=$2" -u "admin:$admin_password" --data-binary @-
}
admin "CREATE DATABASE other"
admin "CREATE USER reader WITH PASSWORD '$reader_password'"
admin "GRANT READ ON home TO reader"
admin "CREATE USER wide WITH PASSWORD '$wide_password'"
admin "GRANT READ ON home TO wide"
admin "GRANT READ ON other TO wide"
admin "CREATE USER rw WITH PASSWORD '$rw_password'"
admin "GRANT READ ON home TO rw"
admin "GRANT WRITE ON other TO rw"
printf 'home,room=Kitchen temp=21 1600000000000000000\nhome,room=Living temp=22 1600000360000000000\n' | write1 "$url" home
printf 'm v=1 1600000000000000000\n' | write1 "$url" other
printf 'home,room=Kitchen temp=21 1600000000000000000\n' | write1 "$noauth_url" home
admin 'CREATE CONTINUOUS QUERY cq_hourly ON home BEGIN SELECT mean(temp) INTO "other"."autogen"."hourly" FROM "home" GROUP BY time(1h) END'
awk 'BEGIN { for (i = 0; i < 200000; i++) printf "big,h=h%d v=%d %d\n", i % 50, i, 1600000000000000000 + i * 1000000000 }' |
  write1 "$url" home

api() { # api <method> <path> [json body]: a 2.9.1 operator request, which must succeed
  curl -fsS -X "$1" "$url2$2" -H "Authorization: Token $operator" ${3:+-H 'Content-Type: application/json'} \
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
printf 'home,room=Kitchen temp=21 1600000000000000000\nhome,room=Living temp=22 1600000360000000000\n' |
  curl -fsS -X POST "$url2/api/v2/write?org=libredb&bucket=home" -H "Authorization: Token $operator" --data-binary @-
printf 'm v=1 1600000000000000000\n' |
  curl -fsS -X POST "$url2/api/v2/write?org=libredb&bucket=other" -H "Authorization: Token $operator" --data-binary @-

cd "$root"
INFLUX1_URL="$url" INFLUX1_NOAUTH_URL="$noauth_url" INFLUX2_URL="$url2" \
  INFLUX1_ADMIN="admin:$admin_password" INFLUX1_READER="reader:$reader_password" INFLUX1_WIDE="wide:$wide_password" \
  INFLUX1_RW="rw:$rw_password" INFLUX2_OPERATOR="$operator" INFLUX2_RO="$ro" INFLUX2_RWHOME="$rwhome" \
  bun tests/live/influxdb-mcp-boundary.ts
