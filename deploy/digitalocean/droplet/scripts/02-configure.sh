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
