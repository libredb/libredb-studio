#!/bin/sh
# Writes a CA and a server certificate for the rabbitmq-tls fixture into $1, only when missing,
# so no key is ever committed. The server certificate names localhost, 127.0.0.1 and the
# container's own name; the broker runs as rabbitmq, so the files are made readable to it.
set -eu
dir="$1"
if [ -f "$dir/server.pem" ]; then
  echo "rabbitmq-tls certificates exist in $dir"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=libredb-rabbitmq-fixture-ca" \
  -keyout "$dir/ca.key" -out "$dir/ca.pem"
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$dir/server.key" -out "$dir/server.csr"
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:libredb-rabbitmq-tls\n' > "$dir/san.ext"
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" -CAcreateserial -days 30 \
  -extfile "$dir/san.ext" -out "$dir/server.pem"
rm -f "$dir/server.csr" "$dir/san.ext" "$dir/ca.key" "$dir/ca.srl"
chmod 644 "$dir/ca.pem" "$dir/server.pem" "$dir/server.key"
echo "rabbitmq-tls certificates written to $dir"
