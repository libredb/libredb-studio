#!/bin/sh
# Generates the keyed Weaviate fixtures' root key and the TLS material into a named volume at first start, so no key
# and no private key is ever committed (the Secret Scan's default rules).
#   keys.sh <directory>
# Runs once: a second start finds the marker and leaves everything as it is; to start over, remove the weaviate-keys
# volume with the containers that use it. Every file is world-readable, because the host-side harnesses copy them
# out with `docker cp` (README.md); they protect nothing but a loopback-only fixture.
#   root.key                     the key of user root, the one RBAC root user on weaviate-auth and weaviate-tls
#   ca.pem, server.pem, server.key  the certificate weaviate-tls serves
#   auth/reader.key, tls/reader.key are written later by the seed, which creates db user reader with role viewer
set -eu
cd "$1"
[ -f .complete ] && { echo "keys already in $1"; exit 0; }
rm -rf -- auth tls ./*.pem ./*.key ./*.srl

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/CN=libredb-weaviate-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf '%s\n' "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:weaviate-tls" >server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 3650 \
  -extfile server.ext 2>/dev/null
rm -f server.csr server.ext ca.key ca.srl

openssl rand -hex 32 >root.key
mkdir auth tls
chmod -R a+rX .
chmod a+r ./*.pem ./*.key
# The seed writes reader.key into these as another user.
chmod a+w auth tls
touch .complete
echo "keys written to $1"
