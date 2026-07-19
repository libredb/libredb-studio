#!/bin/bash
set -euo pipefail

# UFW: SSH only (rate-limited). Port 3000 is published through Docker's
# iptables rules — "ufw allow 3000" is not needed and the port will not
# show up in "ufw status". This is intentional.
ufw default deny incoming
ufw default allow outgoing
ufw limit ssh
ufw --force enable

systemctl daemon-reload

# run-parts --lsbsysinit requires an extensionless name AND the exec bit
chmod +x /etc/update-motd.d/99-libredb-studio

# cloud-init's runparts silently skips non-executable files (log warning
# only) — without this line the service is never installed on customer
# droplets
chmod +x /var/lib/cloud/scripts/per-instance/99-libredb-first-boot.sh

mkdir -p /app/data
chmod 750 /app/data

# Version pinning — must run AFTER the file provisioner
sed -i "s/PINNED_VERSION/${VERSION}/" /etc/systemd/system/libredb-studio.service

# Standard 1-Click metadata, mirroring droplet-1-clicks
# common/scripts/020-application-tag.sh — img-check does not validate it,
# but every canonical DO 1-Click ships it and DO tooling reads it to
# identify the app and release in a snapshot
mkdir -p /var/lib/digitalocean
cat > /var/lib/digitalocean/application.info <<EOM
application_name="libredb-studio"
build_date="$(date +%Y-%m-%d)"
distro="$(lsb_release -s -i)"
distro_release="$(lsb_release -s -r)"
distro_codename="$(lsb_release -s -c)"
distro_arch="$(uname -m)"
application_version="${VERSION}"
EOM
