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

# The first-boot script runs this helper by path when DigitalOcean created a
# Managed Database with the Droplet. The repository stores it 0644, like every
# file here, so the exec bit is set in the image or the call fails.
chmod +x /usr/local/sbin/libredb-do-dbaas-seed

# The container runs the app as nextjs:nodejs, gid 1001, which has no name on
# the host. Left unnamed, the second login adduser creates later would get
# group 1001 and could read the seed directory below. Reserving the id by name
# makes adduser pick another one. The build Droplet is a fresh Ubuntu image, so
# an existing group 1001 is a surprise and fails the build here.
groupadd --system --gid 1001 libredb-studio

# Mounted read-only into the container at /app/seed. It stays empty unless first
# boot finds a Managed Database.
install -d -m 0750 -o root -g libredb-studio /etc/libredb-studio/seed
# The first-boot result the MOTD reads. It never holds a password.
install -d -m 0755 /var/lib/libredb-studio

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
