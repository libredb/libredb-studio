#!/bin/bash
# cloud-init per-instance: runs exactly once per droplet
set -euo pipefail

JWT_SECRET=$(openssl rand -base64 48)
ADMIN_PASSWORD=$(openssl rand -hex 12)
USER_PASSWORD=$(openssl rand -hex 12)

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
)
chmod 600 /etc/libredb-studio.env.tmp
mv /etc/libredb-studio.env.tmp /etc/libredb-studio.env

systemctl enable --now libredb-studio
