#!/usr/bin/env bash
# Re-records every capture in this directory on two fresh digest-pinned influxdb:1.13.1 servers:
#
#   tests/fixtures/influxdb/1.13.1/agent-boundary/run.sh
#
# The first server has authentication on, the second off; each is a container named <INFLUX_PREFIX>influxdb1 and
# <INFLUX_PREFIX>influxdb1-noauth (default prefix libredb-agent-) on 127.0.0.1:INFLUX_PORT and INFLUX_NOAUTH_PORT (defaults
# 18087 and 18088), removed with its volumes when the run ends. The admin's and the two users' passwords are
# generated here for the run and handed to the probe in the environment; no capture holds any of them.
#
# The seed: databases home and other; the user reader with READ on home, and the user rw with READ on home and WRITE
# on other; two points in home, one in other; a continuous query the admin defines on home; and the measurement big,
# 200,000 points the admin's heavy read scans while the reader runs SHOW QUERIES.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0"
prefix="${INFLUX_PREFIX:-libredb-agent-}"
port="${INFLUX_PORT:-18087}"
noauth_port="${INFLUX_NOAUTH_PORT:-18088}"
admin_password="$(openssl rand -hex 16)"
reader_password="$(openssl rand -hex 16)"
rw_password="$(openssl rand -hex 16)"
cleanup() { docker rm -f -v "${prefix}influxdb1" "${prefix}influxdb1-noauth" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "${prefix}influxdb1" -p "127.0.0.1:$port:8086" --memory 1g \
  -e INFLUXDB_HTTP_AUTH_ENABLED=true -e INFLUXDB_ADMIN_USER=admin -e INFLUXDB_ADMIN_PASSWORD="$admin_password" \
  -e INFLUXDB_DB=home -e INFLUXDB_REPORTING_DISABLED=true "$image" >/dev/null
docker run -d --name "${prefix}influxdb1-noauth" -p "127.0.0.1:$noauth_port:8086" --memory 1g \
  -e INFLUXDB_DB=home -e INFLUXDB_REPORTING_DISABLED=true "$image" >/dev/null
url="http://127.0.0.1:$port"
noauth_url="http://127.0.0.1:$noauth_port"
until curl -fs -o /dev/null "$url/ping" && curl -fs -o /dev/null "$noauth_url/ping"; do sleep 1; done
# The image creates the admin a moment after /ping first answers.
until curl -fs -o /dev/null -X POST "$url/query" -u "admin:$admin_password" --data-urlencode 'q=SHOW USERS'; do sleep 1; done

admin() { # admin <statement> [database]: an admin statement, which must answer without an error
  local answer
  answer="$(curl -fsS -X POST "$url/query" -u "admin:$admin_password" ${2:+--data-urlencode "db=$2"} \
    --data-urlencode "q=$1")"
  if printf '%s' "$answer" | grep -q '"error"'; then echo "seed: $1: $answer" >&2; exit 1; fi
}
write() { # write <server url> <database>, line protocol on stdin
  curl -fsS -o /dev/null -X POST "$1/write?db=$2" -u "admin:$admin_password" --data-binary @-
}
admin "CREATE DATABASE other"
admin "CREATE USER reader WITH PASSWORD '$reader_password'"
admin "GRANT READ ON home TO reader"
admin "CREATE USER rw WITH PASSWORD '$rw_password'"
admin "GRANT READ ON home TO rw"
admin "GRANT WRITE ON other TO rw"
printf 'home,room=Kitchen temp=21 1600000000000000000\nhome,room=Living temp=22 1600000360000000000\n' | write "$url" home
printf 'm v=1 1600000000000000000\n' | write "$url" other
printf 'home,room=Kitchen temp=21 1600000000000000000\n' | write "$noauth_url" home
admin 'CREATE CONTINUOUS QUERY cq_hourly ON home BEGIN SELECT mean(temp) INTO "other"."autogen"."hourly" FROM "home" GROUP BY time(1h) END'
awk 'BEGIN { for (i = 0; i < 200000; i++) printf "big,h=h%d v=%d %d\n", i % 50, i, 1600000000000000000 + i * 1000000000 }' |
  write "$url" home

INFLUX_URL="$url" INFLUX_NOAUTH_URL="$noauth_url" INFLUX_ADMIN="admin:$admin_password" \
  INFLUX_READER="reader:$reader_password" INFLUX_RW="rw:$rw_password" \
  node "$dir/../../agent-boundary-probe.mjs" 1.13.1
