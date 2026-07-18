#!/bin/bash
# cloud-init per-instance: runs exactly once per droplet
set -euo pipefail

JWT_SECRET=$(openssl rand -base64 48)
ADMIN_PASSWORD=$(openssl rand -hex 12)
USER_PASSWORD=$(openssl rand -hex 12)

cat > /etc/libredb-studio.env <<EOF
JWT_SECRET=$JWT_SECRET
ADMIN_EMAIL=admin@libredb.org
ADMIN_PASSWORD=$ADMIN_PASSWORD
USER_EMAIL=user@libredb.org
USER_PASSWORD=$USER_PASSWORD
STORAGE_PROVIDER=sqlite
STORAGE_SQLITE_PATH=/app/data/libredb-storage.db
PORT=3000
EOF
chmod 600 /etc/libredb-studio.env

systemctl enable --now libredb-studio
