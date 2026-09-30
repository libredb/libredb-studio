# Shared by seed.sh and rbac.sh, sourced after they set ETCD_URL (the client URL).
#   ETCD_TLS                 curl's TLS options, word-split on purpose (empty for plaintext)
#   ETCD_PASSWORD_DIR  where certs.sh wrote root.password and reader.password (auth fixtures)
# Every call goes through etcd's own gRPC gateway, the JSON mapping of the v3 API, because it
# carries a key and a value as base64 of their exact bytes, and a NUL or an invalid UTF-8 byte
# cannot pass through a command-line argument (the Kafka console-producer lesson).
# The image is alpine/curl: busybox sh, base64, xxd and curl, and no jq.
set -eu

ETCD_TLS="${ETCD_TLS:-}"
WORK=$(mktemp -d)
TOKEN=""

b64() { base64 | tr -d '\n'; }
text() { printf %s "$1" | b64; }
hex() { printf %s "$1" | xxd -r -p | b64; }

# call <path> <json> [tolerated]: POSTs the JSON and fails the run on any answer but HTTP 200,
# unless the answer's message contains the tolerated text, which is how a second run passes
# over what the first one created. The answer is left in $WORK/answer.
call() {
  printf %s "$2" >"$WORK/body"
  if [ -n "$TOKEN" ]; then
    code=$(curl -sS $ETCD_TLS -H "Authorization: $TOKEN" -o "$WORK/answer" -w '%{http_code}' --data-binary "@$WORK/body" "$ETCD_URL$1")
  else
    code=$(curl -sS $ETCD_TLS -o "$WORK/answer" -w '%{http_code}' --data-binary "@$WORK/body" "$ETCD_URL$1")
  fi
  [ "$code" = 200 ] && return 0
  if [ -n "${3:-}" ] && grep -qF "$3" "$WORK/answer"; then return 0; fi
  echo "POST $1 answered HTTP $code: $(cat "$WORK/answer")" >&2
  exit 1
}

# With auth on, every later call carries a root token. The token is kept in this shell only
# and never printed; the server's simple tokens expire after --auth-token-ttl of disuse.
auth_enabled() {
  call /v3/auth/status '{}'
  grep -qF '"enabled":true' "$WORK/answer"
}

login_if_auth_enabled() {
  auth_enabled || return 0
  call /v3/auth/authenticate "{\"name\":\"root\",\"password\":\"$(cat "$ETCD_PASSWORD_DIR/root.password")\"}"
  TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$WORK/answer")
  [ -n "$TOKEN" ] || { echo "authenticate answered no token" >&2; exit 1; }
}

# put_new <key base64> <value base64> [lease id]: writes the key only if it does not exist, in
# one Txn guarded by create_revision = 0, so a second run changes nothing.
put_new() {
  lease=""
  [ -n "${3:-}" ] && lease=",\"lease\":\"$3\""
  call /v3/kv/txn "{\"compare\":[{\"key\":\"$1\",\"target\":\"CREATE\",\"result\":\"EQUAL\",\"create_revision\":\"0\"}],\"success\":[{\"request_put\":{\"key\":\"$1\",\"value\":\"$2\"$lease}}]}"
}

# put_at_version <key base64> <value base64> <version>: writes only while the key is at that
# version, so a key given three revisions by three calls keeps exactly three.
put_at_version() {
  call /v3/kv/txn "{\"compare\":[{\"key\":\"$1\",\"target\":\"VERSION\",\"result\":\"EQUAL\",\"version\":\"$3\"}],\"success\":[{\"request_put\":{\"key\":\"$1\",\"value\":\"$2\"}}]}"
}

# lease_new <id> <ttl seconds>: grants a lease with a fixed id, so a second run finds it.
lease_new() {
  call /v3/lease/grant "{\"ID\":\"$1\",\"TTL\":\"$2\"}" "lease already exists"
}
