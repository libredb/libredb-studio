#!/bin/sh
set -e

# Resolve the bind address before anything else, so BOTH exec paths below get
# it (there is no USER instruction in the Dockerfile, so a plain `docker run`
# starts as root and takes the gosu branch; `--user` and the Helm
# podSecurityContext take the other one).
#
# The image ships `ENV HOSTNAME=""`: empty means "nobody chose" and suppresses
# Docker's HOSTNAME=<container-id> injection, while any non-empty value the
# operator sets is honoured verbatim by the resolver. See docker/bind-address.mjs
# for why `::` is proven per container rather than assumed (issue #432).
#
# LIBREDB_BIND_RESOLVER is an internal test seam, not a supported knob: it lets
# the unit test point the entrypoint at a fixture. Do not document it.
RESOLVER="${LIBREDB_BIND_RESOLVER:-/usr/local/lib/libredb-studio/bind-address.mjs}"
RESOLVED=""
if [ -r "$RESOLVER" ]; then
  # Only a clean exit is trusted; the resolver prints the address on stdout and
  # its one explanatory line on stderr, which passes straight through to
  # `docker logs` / `kubectl logs`.
  if [ "$(id -u)" = "0" ]; then
    # Measure as the user the server actually runs as.
    if RESOLVED_RAW="$(gosu nextjs:nodejs node "$RESOLVER")"; then RESOLVED="$RESOLVED_RAW"; fi
  else
    if RESOLVED_RAW="$(node "$RESOLVER")"; then RESOLVED="$RESOLVED_RAW"; fi
  fi
  # A bind address never contains whitespace, so stripping it is safe and makes
  # the contract with the resolver's stdout forgiving.
  RESOLVED="$(printf %s "$RESOLVED" | tr -d '[:space:]')"
fi
# A bind heuristic must never stop the container starting: fall back to the
# address this image used before #432.
if [ -z "$RESOLVED" ]; then
  RESOLVED="0.0.0.0"
  echo "libredb-studio: WARNING bind resolver unavailable; falling back to 0.0.0.0" >&2
fi
HOSTNAME="$RESOLVED"
export HOSTNAME

# Make the SQLite data directory writable by the non-root app user.
#
# Some platforms (e.g. Railway) mount persistent volumes owned by root, which
# the non-root `nextjs` user cannot write to — causing the SQLite store to fail
# with "unable to open database file". When this container starts as root we
# chown the data directory to the app user and then drop privileges. When it is
# already running as non-root (`--user`, or the chart's podSecurityContext), we
# just exec.
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="$(dirname "${STORAGE_SQLITE_PATH:-/app/data/libredb-storage.db}")"
  mkdir -p "$DATA_DIR"
  chown -R nextjs:nodejs "$DATA_DIR" || true
  exec gosu nextjs:nodejs "$@"
fi

exec "$@"
