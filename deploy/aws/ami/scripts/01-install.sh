#!/bin/bash
set -euo pipefail

# Ubuntu's docker.io is enough (this is what the Azure installer uses) and
# avoids adding a third-party apt repository to an image AWS will scan.
apt-get update -y
apt-get install -y --no-install-recommends docker.io ca-certificates curl openssl

# --now, not just enable: the pull below needs a running daemon in THIS script.
systemctl enable --now docker

# Bake the digest-pinned image into the AMI so a customer launch needs no
# registry access at all.
for i in 1 2 3 4 5; do
  docker pull "${IMAGE_REF}" && break
  echo "pull failed (attempt $i), retrying"
  sleep $((i * 10))
done
docker image inspect "${IMAGE_REF}" >/dev/null
