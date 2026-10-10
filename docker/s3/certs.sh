#!/bin/sh
# The TLS fixture's CA and server certificate (docker/s3/README.md), written into <dir> only when missing, in the
# layout MinIO and Silo read from --certs-dir: public.crt, private.key and CAs/ca.crt, plus ca.pem, a copy of the
# CA for Studio's TLS panel. The certificate names localhost, 127.0.0.1 and silo-tls. <owner uid> owns the private
# key, the user the Silo image runs as (docker/s3/README.md records the measured value).
#
#   certs.sh <dir> <owner uid>
set -eu

DIR="$1"
OWNER="$2"
mkdir -p "$DIR/CAs"
if [ -s "$DIR/public.crt" ] && [ -s "$DIR/private.key" ] && [ -s "$DIR/CAs/ca.crt" ] && [ -s "$DIR/ca.pem" ]; then
  echo "certs.sh: certificates in $DIR already exist"
  exit 0
fi
work="$(mktemp -d)"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=libredb S3 fixture CA" -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=silo-tls" \
  -keyout "$work/server.key" -out "$work/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:silo-tls\nextendedKeyUsage=serverAuth\n' > "$work/ext.cnf"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 3650 \
  -extfile "$work/ext.cnf" -out "$work/server.crt" 2>/dev/null
cp "$work/server.crt" "$DIR/public.crt"
cp "$work/server.key" "$DIR/private.key"
chmod 0600 "$DIR/private.key"
chown "$OWNER:$OWNER" "$DIR/private.key"
cp "$work/ca.crt" "$DIR/CAs/ca.crt"
cp "$work/ca.crt" "$DIR/ca.pem"
chmod 0644 "$DIR/public.crt" "$DIR/CAs/ca.crt" "$DIR/ca.pem"
rm -rf "$work"
echo "certs.sh: CA and certificate for localhost, 127.0.0.1 and silo-tls in $DIR"
