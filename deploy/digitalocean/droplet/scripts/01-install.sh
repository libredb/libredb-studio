#!/bin/bash
set -euo pipefail

# Docker's official APT repo (docker-ce is not in Ubuntu's default repos)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# DO img-check FAILs if /opt/digitalocean exists — droplet-agent must go
apt-get purge -y droplet-agent 2>/dev/null || true
rm -rf /opt/digitalocean

# Packer's file provisioner does not create destination directories
mkdir -p /var/lib/cloud/scripts/per-instance

# Bake the image into the snapshot — no registry access needed on customer boot
docker pull "ghcr.io/libredb/libredb-studio:${VERSION}"
