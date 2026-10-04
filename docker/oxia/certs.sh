#!/bin/sh
# Generates the oxia-auth fixture's certificates, JWT keys and tokens into the named volume
# oxia-auth-material at first start, so no certificate, key or token is ever committed.
#   certs.sh <directory>
# Runs once: a second start finds the marker and leaves everything as it is. The token is
# valid for one year, so a fixture older than that is started over by removing the
# oxia-auth-material volume with the containers that use it.
# The image is alpine/openssl. Every file is world-readable, because the host-side tools copy
# them out with `docker cp` (README.md); they protect nothing but a loopback-only fixture.
set -eu
cd "$1"
[ -f .complete ] && { echo "auth material already in $1"; exit 0; }
rm -f -- ./*.crt ./*.key ./*.pub ./*.jwt ./*.srl

# ca <file> <Common Name>
ca() {
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.crt" -days 3650 \
    -subj "/CN=$2" 2>/dev/null
}

# issue <file> <Common Name> <extensions>, signed by ca
issue() {
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2" 2>/dev/null
  printf '%s\n' "$3" >"$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$1.crt" \
    -days 3650 -extfile "$1.ext" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}

ca ca libredb-oxia-ca
# A CA the server does not trust: the handshake refusal.
ca other-ca libredb-oxia-other-ca

# The names a client on the host reaches the server by.
issue server localhost "subjectAltName=DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth,clientAuth"
issue client libredb-oxia-client "extendedKeyUsage=clientAuth"

# The RS256 key pair of the OIDC static-key provider, and a key the server does not know.
openssl genrsa -out jwt.key 2048 2>/dev/null
openssl rsa -in jwt.key -pubout -out jwt.pub 2>/dev/null
openssl genrsa -out jwt-wrong.key 2048 2>/dev/null

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# mint <file> <signing key> <issuer> <audience> <seconds from now to expiry>
mint() {
  now=$(date +%s)
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iss":"%s","aud":"%s","sub":"fixture-user","iat":%s,"exp":%s}' \
    "$3" "$4" "$now" "$((now + $5))" | b64url)
  signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$2" | b64url)
  printf '%s.%s.%s\n' "$header" "$payload" "$signature" >"$1"
}

ISSUER=https://issuer.libredb-fixture.invalid
mint token.jwt jwt.key "$ISSUER" oxia 31536000
mint token-expired.jwt jwt.key "$ISSUER" oxia -3600
mint token-bad-signature.jwt jwt-wrong.key "$ISSUER" oxia 31536000
mint token-bad-audience.jwt jwt.key "$ISSUER" other 31536000
mint token-bad-issuer.jwt jwt.key https://other.libredb-fixture.invalid oxia 31536000

# The CA keys sign nothing after this run.
rm -f ca.key other-ca.key ./*.srl
chmod 644 ./*
touch .complete
echo "generated $(ls | wc -l) files in $1"
