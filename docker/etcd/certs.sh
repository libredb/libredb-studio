#!/bin/sh
# Generates the auth fixtures' certificates and passwords into a named volume at first start,
# so no private key and no password is ever committed (the Secret Scan's default rules).
#   certs.sh <directory>
# Runs once: a second start finds the marker and leaves everything as it is; to start over,
# remove the etcd-auth-certs volume with the containers that use it.
# The image is alpine/openssl. P-256 keys, which etcd, Node and Bun all read, in a fraction of
# the time RSA takes. Every file is world-readable, because the host-side clients copy them out
# with `docker cp` (README.md); they protect nothing but a loopback-only fixture.
set -eu
cd "$1"
[ -f .complete ] && { echo "certificates already in $1"; exit 0; }
rm -f -- ./*.pem ./*.crt ./*.key ./*.password ./*.srl

ca() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$1.key" -out "$1.pem" -days 3650 -subj "/CN=$2" 2>/dev/null
}

# issue <file> <Common Name, or empty for none> <CA file> <extensions>
issue() {
  subject="/CN=$2"
  [ -n "$2" ] || subject="/O=libredb-etcd-fixture"
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$1.key" -out "$1.csr" -subj "$subject" 2>/dev/null
  printf '%s\n' "$4" >"$1.ext"
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial \
    -out "$1.crt" -days 3650 -extfile "$1.ext" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}

ca ca libredb-etcd-ca
ca other-ca libredb-etcd-other-ca

# One server certificate for both auth fixtures, named for every way a client reaches them: the
# compose service names inside the network, and localhost and the loopback addresses from the
# host. Its Common Name is no etcd user, because etcd's gRPC gateway presents this certificate
# as its own client certificate, and with --client-cert-auth a Common Name is a user name.
issue server etcd-auth-server ca "subjectAltName=DNS:localhost,DNS:etcd-auth,DNS:etcd-auth-password,IP:127.0.0.1,IP:::1
extendedKeyUsage=serverAuth,clientAuth"

# Client certificates, each named by its Common Name: root and reader are etcd users with
# passwords, cert-only is a user with no password, and unknown-user is no etcd user at all (the
# healthcheck's certificate, and a Common Name that names no user).
for user in root reader cert-only unknown-user; do issue "$user" "$user" ca "extendedKeyUsage=clientAuth"; done

# A client certificate for root from a CA the server does not trust: the handshake refusal.
issue other-ca-root root other-ca "extendedKeyUsage=clientAuth"

# The init one-shots' certificate, with no Common Name at all: once RBAC is on, etcd's gateway
# answers HTTP 400 "CommonName of client sending a request against gateway will be ignored and
# not used as expected" to any client certificate that carries one (measured on 3.7.2), so a
# second run of the seed would be refused. Without one, the gateway takes root's token.
issue gateway-client "" ca "extendedKeyUsage=clientAuth"

openssl rand -hex 16 >root.password
openssl rand -hex 16 >reader.password
rm -f ./*.srl
chmod 644 ./*
touch .complete
echo "generated $(ls | wc -l) files in $1"
