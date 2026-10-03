#!/bin/sh
# Generates each keyed Qdrant fixture's admin key, read-only key and local.yaml, and the TLS material, into a named
# volume at first start, so no key and no private key is ever committed (the Secret Scan's default rules).
#   keys.sh <directory>
# Runs once: a second start finds the marker and leaves everything as it is; to start over, remove the qdrant-keys
# volume with the containers that use it. Every file is world-readable, because the host-side harnesses copy them
# out with `docker cp` (README.md); they protect nothing but a loopback-only fixture.
#   auth/  qdrant-auth: admin.key, read-only.key, local.yaml (keys and JWT RBAC)
#   tls/   qdrant-tls: the same three, local.yaml with TLS on REST
#   mtls/  qdrant-mtls: the same three, local.yaml with TLS that verifies the client's certificate
#   ca.pem, server.pem, server.key, client.pem, client.key: the TLS material both TLS servers share
set -eu
cd "$1"
[ -f .complete ] && { echo "keys already in $1"; exit 0; }
rm -rf -- auth tls mtls ./*.pem ./*.key ./*.srl

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/CN=libredb-qdrant-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# issue <file> <Common Name> <extensions>
issue() {
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2" 2>/dev/null
  printf '%s\n' "$3" >"$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -out "$1.pem" -days 3650 \
    -extfile "$1.ext" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}
issue server localhost "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:qdrant-tls,DNS:qdrant-mtls"
issue client libredb-qdrant-client "basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth"

# Each key is 32 random bytes written as 64 hexadecimal characters, above the 32 bytes the server asks of the key
# it signs JWTs with.
for server in auth tls mtls; do
  mkdir "$server"
  openssl rand -hex 32 >"$server/admin.key"
  openssl rand -hex 32 >"$server/read-only.key"
done

cat >auth/local.yaml <<YAML
service:
  api_key: $(cat auth/admin.key)
  read_only_api_key: $(cat auth/read-only.key)
  jwt_rbac: true
YAML

for server in tls mtls; do
  cat >"$server/local.yaml" <<YAML
service:
  enable_tls: true
  verify_https_client_certificate: $([ "$server" = mtls ] && echo true || echo false)
  api_key: $(cat "$server/admin.key")
  read_only_api_key: $(cat "$server/read-only.key")
tls:
  cert: /keys/server.pem
  key: /keys/server.key
  ca_cert: /keys/ca.pem
  cert_ttl: 3600
YAML
done

rm -f ./*.srl
find . -type d -exec chmod 755 {} +
find . -type f -exec chmod 644 {} +
touch .complete
echo "generated $(find . -type f | wc -l) files in $1"
