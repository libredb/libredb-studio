#!/bin/sh
# Captures what the Firestore emulator 1.22.0 answers the Firestore agent's reads, every agent-mode surface and every
# request its closed table refuses (tests/live/firestore-agent-boundary.ts), into boundary.json beside this script.
#
#   sh tests/fixtures/firestore/1.22.0/agent-boundary/run.sh
#
# A fresh digest-pinned emulator, the image of database-compose.yml's firestore service, on its own port, seeded by the
# probe, and removed at the end. The emulator takes no credential, so none exists in this run. Run it under the team's
# docker lock; it touches only the container it names.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
IMAGE="gcr.io/google.com/cloudsdktool/google-cloud-cli:587.0.0-emulators@sha256:8d8573471c489a409f03891d2c24d177fa531276184f7002b9a2d853d1b3ed54"
NAME="pr314-agent-firestore"
PORT=19384

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" "$IMAGE" \
  gcloud emulators firestore start --host-port=0.0.0.0:8080 --project=demo-libredb >/dev/null
i=0
until curl -fsS -o /dev/null 2>/dev/null "http://127.0.0.1:$PORT/"; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || { echo "run.sh: $NAME never became ready" >&2; exit 1; }
  sleep 1
done

cd "$repo"
FIRESTORE_AGENT_IMAGE="$IMAGE" FIRESTORE_AGENT_PORT="$PORT" FIRESTORE_AGENT_OUT="$here" \
  bun tests/live/firestore-agent-boundary.ts
