#!/usr/bin/env bash
# Builds the NETCONF fixture, starts it, checks it is the fixture the provider's tests assume,
# and removes it again. Leaves nothing running whether it passes or fails.
#
# Run from the repository root, after `bun install`, because verify.mjs imports ssh2:
#   ./docker/netconf/verify.sh [port]
set -euo pipefail

PORT="${1:-1830}"
IMAGE="libredb-fixture/netconf:2.8.7"
NAME="libredb-netconf-verify-$$"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "${KEYFILE:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo "building $IMAGE"
docker build -t "$IMAGE" "$HERE"

echo "starting $NAME on 127.0.0.1:$PORT"
# A smaller interface list keeps the check quick; the read sizes were measured at 5000.
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:830" -e LIBREDB_NETCONF_INTERFACES=50 \
  -e LIBREDB_NETCONF_RO_PASSWORD=fixture-password \
  -e LIBREDB_NETCONF_ROOT_PASSWORD=fixture-root \
  -e LIBREDB_NETCONF_KEY_PASSPHRASE=fixture-passphrase "$IMAGE" >/dev/null

echo "waiting for the fixture to finish its setup"
for _ in $(seq 1 60); do
  if docker exec "$NAME" test -f /fixture/.ready 2>/dev/null; then break; fi
  sleep 2
done
docker exec "$NAME" test -f /fixture/.ready || { echo "the fixture never finished its setup" >&2; docker logs "$NAME" >&2; exit 1; }

KEYFILE="$(mktemp)"
docker exec "$NAME" cat /fixture/ro-key > "$KEYFILE"
chmod 600 "$KEYFILE"

# The host key is generated when the image is built, so a check that pins it reads the
# fingerprint out of band, the way a live check against a real device would.
echo -n "host key fingerprint: "
docker exec "$NAME" sh -c 'ssh-keyscan -p 830 -t rsa 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk "{print \$2}"' || echo "(not read)"

cd "$ROOT"
if command -v bun >/dev/null 2>&1; then
  bun docker/netconf/verify.mjs "$PORT" "$KEYFILE"
else
  node docker/netconf/verify.mjs "$PORT" "$KEYFILE"
fi
