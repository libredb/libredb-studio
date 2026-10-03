#!/bin/sh
# Generates the Milvus TLS fixtures' certificates into a named volume at first start, so no private key is ever
# committed (the Secret Scan's default rules).
#   certs.sh <directory>
# Runs once: a second start finds the marker and leaves everything as it is; to start over, remove the milvus-certs
# volume with the containers that use it. RSA keys, as the research's servers used. Every file is mode 644, because
# the Milvus image runs as uid 999 and the host-side harnesses copy them out with `docker cp` (README.md); they
# protect nothing but a loopback-only fixture.
set -eu
cd "$1"
[ -f .complete ] && { echo "certificates already in $1"; exit 0; }
rm -f -- ./*.pem ./*.key ./*.srl

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/CN=libredb-milvus-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# issue <file> <Common Name> <extensions> [the validity flags of openssl x509]
issue() {
  file=$1
  name=$2
  extensions=$3
  shift 3
  openssl req -newkey rsa:2048 -nodes -keyout "$file.key" -out "$file.csr" -subj "/CN=$name" 2>/dev/null
  printf '%s\n' "$extensions" >"$file.ext"
  openssl x509 -req -in "$file.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -out "$file.pem" \
    -extfile "$file.ext" "$@" 2>/dev/null
  rm -f "$file.csr" "$file.ext"
}

# One server certificate for both TLS servers, named for every way a client reaches them: localhost and 127.0.0.1
# from the host, and the compose service names inside the network.
issue server localhost "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:milvus-tls,DNS:milvus-mtls" -days 3650

# The client certificate milvus-mtls accepts, and the three variants it refuses: one issued for server
# authentication only, one expired, and the good certificate's partner key that does not match it.
issue client libredb-milvus-client "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth" -days 3650
issue client-serverauth libredb-milvus-client "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth" -days 3650
issue client-expired libredb-milvus-client "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth" -not_before 20250101000000Z -not_after 20250102000000Z
openssl genrsa -out client-mismatched.key 2048 2>/dev/null

rm -f ./*.srl
chmod 644 ./*
touch .complete
echo "generated $(ls | wc -l) files in $1"
