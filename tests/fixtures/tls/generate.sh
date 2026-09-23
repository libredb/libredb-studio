#!/usr/bin/env bash
# Makes the throwaway TLS material in this directory. README.md says what each file is for.
#
# Every key is a fresh EC P-256 key, made for this run and held in a temporary directory that
# is deleted on exit. The three authority keys never leave it: nothing signs anything at test
# time, so no test needs them. The two keys the tests load are written as JWK, which no
# default gitleaks rule matches, and tests/helpers/tls-fixtures.ts turns them back into PEM
# when a test file starts.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

for name in ca other-ca client-ca server client; do
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$name.key"
done

printf '%s\n' 'basicConstraints=critical,CA:TRUE' 'keyUsage=critical,keyCertSign,cRLSign' \
  'subjectKeyIdentifier=hash' >authority.ext
printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=serverAuth' 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1' >server.ext
printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=clientAuth' >client.ext

# 36500 days: the suite should never meet an expired certificate.
authority() { # file stem, common name, serial
  openssl req -new -key "$1.key" -subj "/CN=$2" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -signkey "$1.key" -days 36500 -sha256 -set_serial "$3" \
    -extfile authority.ext -out "$out/$1.crt"
}
leaf() { # file stem, common name, issuer stem, serial
  openssl req -new -key "$1.key" -subj "/CN=$2" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -CA "$out/$3.crt" -CAkey "$3.key" -days 36500 -sha256 \
    -set_serial "$4" -extfile "$1.ext" -out "$out/$1.crt"
}

authority ca "LibreDB Studio Test CA" 0x1001
authority other-ca "LibreDB Studio Unrelated Test CA" 0x1002
authority client-ca "LibreDB Studio Test Client CA" 0x1003
leaf server localhost ca 0x2001
leaf client libredb-studio-test-client client-ca 0x3001

for name in server client; do
  bun -e '
    import { createPrivateKey } from "node:crypto";
    import { readFileSync } from "node:fs";
    const jwk = createPrivateKey(readFileSync(process.argv[1], "utf8")).export({ format: "jwk" });
    process.stdout.write(`${JSON.stringify(jwk, null, 2)}\n`);
  ' "$name.key" >"$out/$name.key.jwk.json"
done
