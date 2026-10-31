#!/usr/bin/env bash
# Re-records every capture in this directory on two fresh digest-pinned etcd v3.7.2 servers:
#
#   tests/fixtures/etcd/v3.7.2/agent-boundary/run.sh
#
# Two single-member containers named <ETCD_PREFIX>etcd-auth and <ETCD_PREFIX>etcd-open (default prefix
# libredb-agent-), plaintext, on 127.0.0.1:ETCD_AUTH_PORT and 127.0.0.1:ETCD_OPEN_PORT (defaults 23791 and 23792),
# removed when the run ends. The probe turns authentication on for the first and leaves it off on the second, and
# generates every user's password for the run; no capture holds a password or a token.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="gcr.io/etcd-development/etcd:v3.7.2@sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3"
prefix="${ETCD_PREFIX:-libredb-agent-}"
auth_port="${ETCD_AUTH_PORT:-23791}"
open_port="${ETCD_OPEN_PORT:-23792}"
cleanup() { docker rm -f -v "${prefix}etcd-auth" "${prefix}etcd-open" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
start() {
  docker run -d --name "$1" -p "127.0.0.1:$2:2379" "$image" /usr/local/bin/etcd --name="$1" \
    --initial-cluster-token="$1" --initial-cluster="$1=http://127.0.0.1:2380" \
    --initial-advertise-peer-urls=http://127.0.0.1:2380 --listen-peer-urls=http://127.0.0.1:2380 \
    --listen-client-urls=http://0.0.0.0:2379 --advertise-client-urls=http://127.0.0.1:2379 \
    --data-dir=/var/lib/etcd/data >/dev/null
  until docker exec "$1" etcdctl endpoint health --command-timeout=3s >/dev/null 2>&1; do sleep 1; done
}
start "${prefix}etcd-auth" "$auth_port"
start "${prefix}etcd-open" "$open_port"
ETCD_AUTH_TARGET="127.0.0.1:$auth_port" ETCD_OPEN_TARGET="127.0.0.1:$open_port" ETCD_IMAGE="$image" ETCD_OUT="$dir" \
  bun "$dir/../../../../live/etcd-agent-boundary.ts"
