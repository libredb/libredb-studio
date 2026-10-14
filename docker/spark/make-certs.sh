#!/usr/bin/env bash
# Writes the throwaway TLS material of the spark-tls proxy into <dir>, outside the repository:
#   <dir>/ca.pem      the CA a client pastes under SSL / TLS (verify-full or verify-ca)
#   <dir>/server.pem  the proxy's certificate, SAN DNS:localhost and IP:127.0.0.1, signed by that CA
#   <dir>/server.key  its private key, readable by the proxy's worker
# Usage: docker/spark/make-certs.sh <dir>; then export SPARK_TLS_DIR=<dir>.
set -euo pipefail
if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: docker/spark/make-certs.sh <dir>" >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
# Resolve <dir> before creating anything: its nearest existing directory with links followed, then the levels below
# it, which may not climb with . or .., so the repository check reads the directory mkdir would create.
case "$1" in
  /*) base="$1" ;;
  *) base="$PWD/$1" ;;
esac
rest=""
until [[ -d "$base" ]]; do
  level="$(basename -- "$base")"
  if [[ "$level" == "." || "$level" == ".." ]]; then
    echo "make-certs.sh takes a directory whose levels below the last existing one hold no . or ..; nothing was created" >&2
    exit 2
  fi
  rest="/$level$rest"
  base="$(dirname -- "$base")"
done
resolved="$(cd -P -- "$base" && pwd -P)"
dir="${resolved%/}$rest"
dir="${dir:-/}"
case "$dir/" in
  "$repo"/*)
    echo "make-certs.sh writes key material only outside the repository; choose a directory outside $repo" >&2
    exit 2
    ;;
esac
mkdir -p -- "$dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=LibreDB Studio Spark fixture CA" \
  -keyout "$work/ca.key" -out "$dir/ca.pem" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$dir/server.key" -out "$work/server.csr" 2>/dev/null
cat > "$work/server.ext" <<'EXT'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in "$work/server.csr" -CA "$dir/ca.pem" -CAkey "$work/ca.key" -CAcreateserial \
  -CAserial "$work/ca.srl" -days 30 -sha256 -extfile "$work/server.ext" -out "$dir/server.pem" 2>/dev/null
chmod 644 "$dir/server.key" "$dir/server.pem" "$dir/ca.pem"
echo "Wrote ca.pem, server.pem and server.key in $dir"
