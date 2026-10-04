#!/usr/bin/env bash
# The only writer of the InfluxDB fixtures (docker/influxdb/README.md). Studio never runs it, and the evidence harness
# never imports or runs it.
#
#   seed.sh            the read principals, then home.lp and edge.lp, on influxdb1, influxdb2 and influxdb3
#                      (what the influxdb-seed one-shot runs)
#   seed.sh filelimit  the file-limit fixture on influxdb3-filelimit (bulk.py filelimit; needs python3)
#   seed.sh bench      database bench on all three servers (bulk.py bench; needs python3; by hand only)
#
# It creates what is missing and leaves what exists: home.lp is written only to a server whose home measurement is
# empty, because its timestamps are relative to the seed time and a second copy would double the sample; edge.lp has
# fixed timestamps, so writing it again changes nothing. Run on the host it talks to the published ports; in the
# one-shot the compose file points it at the service names. The credentials are the fixed test values of
# database-compose.yml.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-default}"

V1_URL="${INFLUXDB1_URL:-http://127.0.0.1:8087}"
V2_URL="${INFLUXDB2_URL:-http://127.0.0.1:8086}"
V3_URL="${INFLUXDB3_URL:-http://127.0.0.1:8181}"
V3_FILELIMIT_URL="${INFLUXDB3_FILELIMIT_URL:-http://127.0.0.1:8182}"
V1_ADMIN="admin:password123"
V1_READER_USER="reader"
V1_READER_PASSWORD="readonly123"
V2_ORG="libredb"
V2_TOKEN="libredb-influxdb2-operator-token"
V2_READ_TOKEN_DESCRIPTION="libredb read-only home"
V3_TOKEN="apiv3_libredb-influxdb3-admin-token"

fail() {
  echo "seed.sh: $*" >&2
  exit 1
}

# send <expected statuses> <what> <curl arguments...>: prints the body; a status outside the expected ones, written as
# 200 or 200|404, stops the seed with the body.
send() {
  local want="$1" what="$2" body status
  shift 2
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' "$@")" || {
    rm -f "$body"
    fail "$what: the request failed"
  }
  if ! [[ "$status" =~ ^($want)$ ]]; then
    cat "$body" >&2
    echo >&2
    rm -f "$body"
    fail "$what: HTTP $status, expected $want"
  fi
  cat "$body"
  rm -f "$body"
}

# The lines of a .lp file without its comments and blank lines.
lines_of() {
  grep -Ev '^(#|$)' "$1"
}

# home.lp with each NOW-<k>H replaced by the seed time minus k hours, in seconds.
home_lines() {
  lines_of "$HERE/home.lp" | awk -v now="$(date +%s)" '{
    if (match($0, / NOW-[0-9]+H$/)) print substr($0, 1, RSTART) (now - substr($0, RSTART + 5, RLENGTH - 6) * 3600)
    else { print "home.lp: no NOW-<k>H timestamp: " $0 > "/dev/stderr"; exit 1 }
  }'
}

# Every line but the ones carrying an unsigned field, which 1.x OSS refuses.
without_unsigned() {
  grep -Ev '=[0-9]+u( |,|$)'
}

# A /query answer that holds a series, as opposed to an empty result or an error.
holds_series() {
  grep -q '"series"'
}

# The first "id" of a 2.x API answer, or nothing when it holds none.
first_id() {
  { grep -o '"id": *"[0-9a-f]*"' || true; } | head -n 1 | sed -E 's/.*"([0-9a-f]*)"$/\1/'
}

v1_query() {
  local answer
  answer="$(send 200 "influxdb1 $1" -X POST "$V1_URL/query" -u "$V1_ADMIN" --data-urlencode "q=$1")"
  if printf '%s' "$answer" | grep -q '"error"'; then fail "influxdb1 $1: $answer"; fi
  printf '%s' "$answer"
}

v1_write() { # v1_write <database> <precision>, line protocol on stdin
  send 204 "influxdb1 write $1" -X POST "$V1_URL/write?db=$1&precision=$2" -u "$V1_ADMIN" --data-binary @- >/dev/null
}

v1_seeded() {
  send 200 "influxdb1 count" -X POST "$V1_URL/query" -u "$V1_ADMIN" --data-urlencode db=home \
    --data-urlencode 'q=SELECT count(temp) FROM home' | holds_series
}

seed_v1() {
  v1_query "CREATE DATABASE home" >/dev/null
  v1_query "CREATE DATABASE edge" >/dev/null
  if ! v1_query "SHOW USERS" | grep -q "\"$V1_READER_USER\""; then
    v1_query "CREATE USER $V1_READER_USER WITH PASSWORD '$V1_READER_PASSWORD'" >/dev/null
  fi
  v1_query "GRANT READ ON home TO $V1_READER_USER" >/dev/null
  if v1_seeded; then
    echo "influxdb1: home already seeded, left as it is"
  else
    home_lines | v1_write home s
    echo "influxdb1: wrote home.lp"
  fi
  for database in home edge; do lines_of "$HERE/edge.lp" | without_unsigned | v1_write "$database" ns; done
  echo "influxdb1: wrote edge.lp to home and edge, without the unsigned lines"
}

v2_api() { # v2_api <expected status> <method> <path> [json body]
  local arguments=(-X "$2" "$V2_URL$3" -H "Authorization: Token $V2_TOKEN")
  if [ "$#" -ge 4 ]; then arguments+=(-H 'Content-Type: application/json' --data-binary "$4"); fi
  send "$1" "influxdb2 $2 $3" "${arguments[@]}"
}

v2_write() { # v2_write <bucket> <precision>, line protocol on stdin
  send 204 "influxdb2 write $1" -X POST "$V2_URL/api/v2/write?org=$V2_ORG&bucket=$1&precision=$2" \
    -H "Authorization: Token $V2_TOKEN" --data-binary @- >/dev/null
}

v2_bucket() { # v2_bucket <organisation id> <name>: prints the bucket's id, creating the bucket when it is missing (404)
  local id
  id="$(v2_api '200|404' GET "/api/v2/buckets?orgID=$1&name=$2" | first_id)"
  if [ -z "$id" ]; then
    id="$(v2_api 201 POST /api/v2/buckets "{\"orgID\":\"$1\",\"name\":\"$2\",\"retentionRules\":[]}" | first_id)"
  fi
  [ -n "$id" ] || fail "influxdb2: no id for bucket $2"
  printf '%s' "$id"
}

# The ids of the authorizations carrying the read token's description. In a listing each authorization's own "id"
# comes before its "description", and its permissions' ids after it.
v2_read_token_ids() {
  v2_api 200 GET "/api/v2/authorizations?orgID=$1" | { grep -o -E '"(id|description)": *"[^"]*"' || true; } |
    awk -v wanted="\"description\": \"$V2_READ_TOKEN_DESCRIPTION\"" '
      /^"id"/ { id = $0; sub(/^"id": *"/, "", id); sub(/"$/, "", id) }
      /^"description"/ { line = $0; sub(/: */, ": ", line); if (line == wanted) print id }'
}

# v2_read_token <organisation id> <bucket id>: keeps the read-only token for bucket home in INFLUXDB2_READ_TOKEN_FILE.
# 2.9.1 shows a token's value only in the answer that creates it, so the file is the one place it is kept: when the
# file's token no longer opens the server (the server or the file was recreated), every token under the description
# is deleted and a new one is created and written.
v2_read_token() {
  local file="${INFLUXDB2_READ_TOKEN_FILE:-}" id token
  [ -n "$file" ] || fail "influxdb2: set INFLUXDB2_READ_TOKEN_FILE, the file the read-only token is kept in"
  if [ -s "$file" ] && [ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$V2_URL/query" \
    -H "Authorization: Token $(cat "$file")" --data-urlencode db=home --data-urlencode 'q=SHOW MEASUREMENTS')" = 200 ]; then
    echo "influxdb2: the read-only token in $file opens the server, left as it is"
    return
  fi
  for id in $(v2_read_token_ids "$1"); do v2_api 204 DELETE "/api/v2/authorizations/$id" >/dev/null; done
  token="$(v2_api 201 POST /api/v2/authorizations "{\"orgID\":\"$1\",\"description\":\"$V2_READ_TOKEN_DESCRIPTION\",\
\"permissions\":[{\"action\":\"read\",\"resource\":{\"type\":\"buckets\",\"orgID\":\"$1\",\"id\":\"$2\"}}]}" |
    { grep -o '"token": *"[^"]*"' || true; } | sed -E 's/.*"([^"]*)"$/\1/')"
  [ -n "$token" ] || fail "influxdb2: the answer creating the read-only token carried no token"
  (umask 077 && printf '%s\n' "$token" >"$file")
  echo "influxdb2: created the read-only token \"$V2_READ_TOKEN_DESCRIPTION\" and wrote it to $file"
}

v2_seeded() {
  send 200 "influxdb2 count" -X POST "$V2_URL/query" -H "Authorization: Token $V2_TOKEN" --data-urlencode db=home \
    --data-urlencode 'q=SELECT count(temp) FROM home' | holds_series
}

seed_v2() {
  local org home
  org="$(v2_api 200 GET "/api/v2/orgs?org=$V2_ORG" | first_id)"
  [ -n "$org" ] || fail "influxdb2: no organisation $V2_ORG"
  home="$(v2_bucket "$org" home)"
  v2_bucket "$org" edge >/dev/null
  v2_read_token "$org" "$home"
  if v2_seeded; then
    echo "influxdb2: home already seeded, left as it is"
  else
    home_lines | v2_write home s
    echo "influxdb2: wrote home.lp"
  fi
  for bucket in home edge; do lines_of "$HERE/edge.lp" | v2_write "$bucket" ns; done
  echo "influxdb2: wrote edge.lp to home and edge"
}

v3_write() { # v3_write <server url> <database> <precision>, line protocol on stdin
  send 204 "influxdb3 write $2" -X POST "$1/api/v3/write_lp?db=$2&precision=$3&accept_partial=false" \
    -H "Authorization: Bearer $V3_TOKEN" -H 'Content-Type: text/plain; charset=utf-8' --data-binary @- >/dev/null
}

v3_seeded() { # v3_seeded <server url>
  send 200 "influxdb3 count" -X POST "$1/query" -H "Authorization: Bearer $V3_TOKEN" --data-urlencode db=home \
    --data-urlencode 'q=SELECT count(temp) FROM home' | holds_series
}

seed_v3() {
  if v3_seeded "$V3_URL"; then
    echo "influxdb3: home already seeded, left as it is"
  else
    home_lines | v3_write "$V3_URL" home second
    echo "influxdb3: wrote home.lp"
  fi
  for database in home edge; do lines_of "$HERE/edge.lp" | v3_write "$V3_URL" "$database" nanosecond; done
  echo "influxdb3: wrote edge.lp to home and edge"
}

# The file-limit fixture cannot be asked for a count: an unbounded read over its seed is the read the fixture exists to
# refuse (it answers the file-limit error, with no series), and a time-bounded one goes empty as the seed ages. The
# catalog answers without a scan, so the probe is whether database home lists a measurement; only this script
# writes there. A server with no database home answers an error, which holds no series either.
filelimit_seeded() {
  send 200 "influxdb3-filelimit measurements" -X POST "$V3_FILELIMIT_URL/query" -H "Authorization: Bearer $V3_TOKEN" \
    --data-urlencode db=home --data-urlencode 'q=SHOW MEASUREMENTS' | holds_series
}

seed_filelimit() {
  if filelimit_seeded; then
    echo "influxdb3-filelimit: home already seeded, left as it is"
    return
  fi
  python3 "$HERE/bulk.py" filelimit | v3_write "$V3_FILELIMIT_URL" home second
  echo "influxdb3-filelimit: wrote bulk.py filelimit"
}

seed_bench() {
  local chunks chunk org
  chunks="$(mktemp -d)"
  trap 'rm -rf "$chunks"' EXIT
  python3 "$HERE/bulk.py" bench | split -l 50000 - "$chunks/chunk."
  v1_query "CREATE DATABASE bench" >/dev/null
  org="$(v2_api 200 GET "/api/v2/orgs?org=$V2_ORG" | first_id)"
  v2_bucket "$org" bench >/dev/null
  for chunk in "$chunks"/chunk.*; do
    v1_write bench s <"$chunk"
    v2_write bench s <"$chunk"
    v3_write "$V3_URL" bench second <"$chunk"
  done
  echo "bench: wrote bulk.py bench to all three servers"
}

case "$MODE" in
  default)
    seed_v1
    seed_v2
    seed_v3
    ;;
  filelimit) seed_filelimit ;;
  bench) seed_bench ;;
  *) fail "unknown mode $MODE: use no argument, filelimit or bench" ;;
esac
