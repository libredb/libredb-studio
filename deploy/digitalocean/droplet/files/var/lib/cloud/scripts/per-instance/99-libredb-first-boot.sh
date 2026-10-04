#!/bin/bash
# cloud-init per-instance: runs exactly once per droplet
set -euo pipefail

JWT_SECRET=$(openssl rand -base64 48)
ADMIN_PASSWORD=$(openssl rand -hex 12)
USER_PASSWORD=$(openssl rand -hex 12)

# DigitalOcean Managed Database, offered when the customer creates the Droplet
# (digitalocean/marketplace-partners README, section 5). When the customer
# accepts, DigitalOcean writes /root/.digitalocean_dbaas_credentials before the
# per-instance scripts run; DigitalOcean's own 1-Click images read it from their
# per-instance scripts too. The helper turns it into a seed file that lists the
# database in Studio for accounts with the admin role, with the password kept
# in the env file below. Without the credentials file nothing in this block runs and the
# Droplet is configured exactly as before. A credentials file the helper refuses
# is reported in the MOTD and the journal, and Studio still starts: a database
# offer that went wrong must not cost the customer the IDE as well.
DBAAS_CREDENTIALS=/root/.digitalocean_dbaas_credentials
SEED_FILE=/etc/libredb-studio/seed/connections.yaml
DBAAS_STATUS=/var/lib/libredb-studio/dbaas.status
DBAAS_ENV=""
# per-instance runs again on a Droplet created from a customer's own snapshot,
# where the credentials file may be gone. Starting clean keeps a seed file and a
# "connected" status from the first instance from outliving their database.
rm -f "$SEED_FILE" "$DBAAS_STATUS"
if [ -f "$DBAAS_CREDENTIALS" ]; then
  # The file carries the cluster's admin password; its mode is DigitalOcean's
  # choice and is not documented, so it is narrowed to root here.
  chmod 600 "$DBAAS_CREDENTIALS"
  if DBAAS_ENV=$(/usr/local/sbin/libredb-do-dbaas-seed "$DBAAS_CREDENTIALS" "$SEED_FILE" "$DBAAS_STATUS"); then
    # The container reads it as nextjs:nodejs (1001:1001); 02-configure.sh named
    # gid 1001 libredb-studio on the host. It holds no password.
    chown root:libredb-studio "$SEED_FILE"
    chmod 640 "$SEED_FILE"
  else
    DBAAS_ENV=""
    logger -t libredb-first-boot "managed database not added to Studio: see $DBAAS_STATUS"
  fi
fi

# The droplet is reached at http://<ip>:3000 and has no name of its own, so the
# deployment is plain HTTP. Without AUTH_COOKIE_SECURE=false the app marks its
# auth cookie Secure for a non-loopback host, the browser discards it, and login
# loops back silently while every health probe still passes. The AWS image writes
# the same line for the same reason (deploy/aws/ami/files/usr/local/sbin/libredb-firstboot).
# If TLS is put in front of the Droplet later, set AUTH_COOKIE_SECURE=true here and
# restart libredb-studio: the override wins over x-forwarded-proto, so the flag does
# not come back on its own.
# cloud-init runs per-instance scripts with umask 0022, so a plain redirect would
# create the env file 0644 - world-readable with live secrets in it - and only
# narrow the mode afterwards. The AWS image writes the env file the safe way
# (deploy/aws/ami/files/usr/local/sbin/libredb-firstboot); this is the same shape:
# umask 077 around the heredoc, a temp file, and an atomic move whose completion
# is the only observable state.
# The managed-database lines are appended inside the same umask, after the
# heredoc, and only when the helper above succeeded. SEED_CONFIG_PATH is the
# container side of the read-only mount in libredb-studio.service.
( umask 077
  cat > /etc/libredb-studio.env.tmp <<EOF
JWT_SECRET=$JWT_SECRET
ADMIN_EMAIL=admin@libredb.org
ADMIN_PASSWORD=$ADMIN_PASSWORD
USER_EMAIL=user@libredb.org
USER_PASSWORD=$USER_PASSWORD
STORAGE_PROVIDER=sqlite
STORAGE_SQLITE_PATH=/app/data/libredb-storage.db
PORT=3000
AUTH_COOKIE_SECURE=false
EOF
  if [ -n "$DBAAS_ENV" ]; then
    printf '%s\n' "$DBAAS_ENV" >> /etc/libredb-studio.env.tmp
    printf 'SEED_CONFIG_PATH=/app/seed/connections.yaml\n' >> /etc/libredb-studio.env.tmp
  fi
)
chmod 600 /etc/libredb-studio.env.tmp
mv /etc/libredb-studio.env.tmp /etc/libredb-studio.env

systemctl enable --now libredb-studio
