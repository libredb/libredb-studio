#!/usr/bin/env bash
# Re-records every capture in this directory, and replays the agent boundary through MCP's run_etcd_read, on two fresh
# digest-pinned etcd v3.7.2 servers:
#
#   tests/fixtures/etcd/v3.7.2/mcp-scope/run.sh
#
# Two single-member containers named <ETCD_PREFIX>etcd-auth and <ETCD_PREFIX>etcd-open (default prefix libredb-mcp-),
# each serving TLS on 127.0.0.1:ETCD_AUTH_PORT and 127.0.0.1:ETCD_OPEN_PORT (defaults 23793 and 23794) with a
# certificate this script makes for 127.0.0.1 and removes, and both removed when the run ends. The check turns
# authentication on for the first and leaves it off on the second, and generates every user's password for the run;
# no capture holds a password, a token or a key.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="gcr.io/etcd-development/etcd:v3.7.2@sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3"
prefix="${ETCD_PREFIX:-libredb-mcp-}"
auth_port="${ETCD_AUTH_PORT:-23793}"
open_port="${ETCD_OPEN_PORT:-23794}"
certs=""
cleanup() {
  docker rm -f -v "${prefix}etcd-auth" "${prefix}etcd-open" >/dev/null 2>&1 || true
  if [ -n "$certs" ]; then rm -rf "$certs"; fi
}
trap cleanup EXIT
cleanup
certs="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=libredb-mcp-ca" \
  -keyout "$certs/ca.key" -out "$certs/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$certs/server.key" -out "$certs/server.csr" \
  >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' >"$certs/san.ext"
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.pem" -CAkey "$certs/ca.key" -CAcreateserial -days 1 \
  -extfile "$certs/san.ext" -out "$certs/server.pem" >/dev/null 2>&1
chmod 644 "$certs"/*
start() {
  docker run -d --name "$1" -p "127.0.0.1:$2:2379" -v "$certs:/certs:ro" "$image" /usr/local/bin/etcd --name="$1" \
    --initial-cluster-token="$1" --initial-cluster="$1=http://127.0.0.1:2380" \
    --initial-advertise-peer-urls=http://127.0.0.1:2380 --listen-peer-urls=http://127.0.0.1:2380 \
    --listen-client-urls=https://0.0.0.0:2379 --advertise-client-urls=https://127.0.0.1:2379 \
    --cert-file=/certs/server.pem --key-file=/certs/server.key \
    --data-dir=/var/lib/etcd/data >/dev/null
  until docker exec "$1" etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/certs/ca.pem endpoint health \
    --command-timeout=3s >/dev/null 2>&1; do sleep 1; done
}
start "${prefix}etcd-auth" "$auth_port"
start "${prefix}etcd-open" "$open_port"
ETCD_AUTH_TARGET="127.0.0.1:$auth_port" ETCD_OPEN_TARGET="127.0.0.1:$open_port" ETCD_CA="$certs/ca.pem" \
  ETCD_IMAGE="$image" ETCD_OUT="$dir" bun "$dir/../../../../live/etcd-mcp-boundary.ts"
