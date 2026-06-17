#!/bin/sh
set -e

# Make the SQLite data directory writable by the non-root app user.
#
# Some platforms (e.g. Railway) mount persistent volumes owned by root, which
# the non-root `nextjs` user cannot write to — causing the SQLite store to fail
# with "unable to open database file". When this container starts as root we
# chown the data directory to the app user and then drop privileges. When it is
# already running as non-root (the default for plain `docker run`), we just exec.
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="$(dirname "${STORAGE_SQLITE_PATH:-/app/data/libredb-storage.db}")"
  mkdir -p "$DATA_DIR"
  chown -R nextjs:nodejs "$DATA_DIR" || true
  exec gosu nextjs:nodejs "$@"
fi

exec "$@"
