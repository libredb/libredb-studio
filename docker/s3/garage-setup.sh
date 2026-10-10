#!/bin/sh
# Layout, buckets, keys, grants and the local alias of the Garage fixture, through Garage's admin API v2
# (docker/s3/README.md; request bodies from the v2.4.1 OpenAPI document). Every step reads first and writes only
# what is missing, so a second run changes nothing. POSIX sh in alpine/curl, which carries no jq: values are read
# with sed from the answers, which api() flattens to compact JSON, and checked to be hex before use.
#
#   garage-setup.sh <admin url>
set -eu

ADMIN="$1"
KEYS="${GARAGE_KEYS_DIR:-/keys}"
TOKEN="$(cat "$KEYS/admin.token")"
BUCKETS="studio-demo studio-scoped studio-versions studio-bulk studio-empty"

fail() {
  echo "garage-setup.sh: $*" >&2
  exit 1
}

# api <method> <path> [<json body>]: prints "<status> <body>" on one line.
# Garage answers pretty-printed JSON; api() flattens it to compact JSON for the patterns below.
api() {
  body="$(mktemp)"
  if [ "$#" -ge 3 ]; then
    status="$(curl -sS -o "$body" -w '%{http_code}' -X "$1" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' --data-binary "$3" "$ADMIN$2")" || status=000
  else
    status="$(curl -sS -o "$body" -w '%{http_code}' -X "$1" -H "Authorization: Bearer $TOKEN" "$ADMIN$2")" || status=000
  fi
  printf '%s %s' "$status" "$(awk '{ sub(/^ +/, ""); printf "%s", $0 }' "$body" | sed 's/": /":/g')"
  rm -f "$body"
}

# hex <call> <field> <value>: the value, or a stop naming the call when it is empty or not hex.
hex() {
  case "$3" in
    '' | *[!0-9a-f]*) fail "$1 answered without a readable $2" ;;
  esac
  printf '%s' "$3"
}

# expect_ok <call> <answer>: stops unless the answer's status is 200.
expect_ok() {
  case "$2" in
    "200 "*) ;;
    *) fail "$1 answered ${2%% *}: ${2#* }" ;;
  esac
}

# 1. Wait for the admin API, which answers before any layout or quorum exists.
tries=0
until answer="$(api GET /v2/GetClusterStatus)" && [ "${answer%% *}" = 200 ]; do
  tries=$((tries + 1))
  [ "$tries" -ge 60 ] && fail "GetClusterStatus did not answer 200 within 60 tries"
  sleep 1
done

# 2. Apply a one-node layout when none exists.
status_json="${answer#* }"
case "$status_json" in
  *'"layoutVersion":0'*)
    node="$(hex GetClusterStatus id "$(printf '%s' "$status_json" | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')")"
    expect_ok UpdateClusterLayout "$(api POST /v2/UpdateClusterLayout "{\"roles\":[{\"id\":\"$node\",\"zone\":\"dc1\",\"capacity\":1073741824,\"tags\":[]}]}")"
    expect_ok ApplyClusterLayout "$(api POST /v2/ApplyClusterLayout '{"version":1}')"
    ;;
esac

# bucket_id <name>: the bucket's id, creating the bucket when GetBucketInfo answers 404.
bucket_id() {
  info="$(api GET "/v2/GetBucketInfo?globalAlias=$1")"
  if [ "${info%% *}" = 404 ]; then
    expect_ok "CreateBucket $1" "$(api POST /v2/CreateBucket "{\"globalAlias\":\"$1\"}")"
    info="$(api GET "/v2/GetBucketInfo?globalAlias=$1")"
  fi
  expect_ok "GetBucketInfo $1" "$info"
  hex "GetBucketInfo $1" id "$(printf '%s' "${info#* }" | sed -n 's/^{"id":"\([0-9a-f]*\)".*/\1/p')"
}

# 3. The five buckets.
for name in $BUCKETS; do
  bucket_id "$name" >/dev/null
done

# 4. The four keys, imported with the volume's secrets.
for pair in GK000000000000000000000001:rw GK000000000000000000000002:browse GK000000000000000000000003:scoped GK000000000000000000000004:none; do
  id="${pair%%:*}"
  name="${pair#*:}"
  info="$(api GET "/v2/GetKeyInfo?id=$id")"
  if [ "${info%% *}" = 404 ]; then
    secret="$(cat "$KEYS/$name.secret")"
    expect_ok "ImportKey $name" "$(api POST /v2/ImportKey "{\"accessKeyId\":\"$id\",\"secretAccessKey\":\"$secret\",\"name\":\"$name\"}")"
  else
    expect_ok "GetKeyInfo $name" "$info"
  fi
done

# 5. Grants: rw reads, writes and owns every bucket; browse reads every bucket; scoped reads studio-scoped;
#    none has no grant. Setting a permission twice is a no-op.
allow() {
  expect_ok "AllowBucketKey $2 on $1" "$(api POST /v2/AllowBucketKey \
    "{\"bucketId\":\"$(bucket_id "$1")\",\"accessKeyId\":\"$2\",\"permissions\":{\"read\":true,\"write\":$3,\"owner\":$3}}")"
}
for name in $BUCKETS; do
  allow "$name" GK000000000000000000000001 true
  allow "$name" GK000000000000000000000002 false
done
allow studio-scoped GK000000000000000000000003 false

# 6. The scoped key's local alias for studio-scoped.
scoped="$(api GET "/v2/GetBucketInfo?globalAlias=studio-scoped")"
case "$scoped" in
  *'"bucketLocalAliases":["scoped-local"'*) ;;
  *)
    expect_ok "AddBucketAlias scoped-local" "$(api POST /v2/AddBucketAlias \
      "{\"bucketId\":\"$(bucket_id studio-scoped)\",\"localAlias\":\"scoped-local\",\"accessKeyId\":\"GK000000000000000000000003\"}")"
    ;;
esac

# Wait until the node serves requests, so garage-seed starts on a healthy node.
tries=0
until answer="$(api GET /v2/GetClusterHealth)" && case "$answer" in *'"status":"healthy"'*) true ;; *) false ;; esac; do
  tries=$((tries + 1))
  [ "$tries" -ge 60 ] && fail "GetClusterHealth did not answer healthy within 60 tries"
  sleep 1
done
echo "garage-setup.sh: layout, 5 buckets, 4 keys and their grants in place"
