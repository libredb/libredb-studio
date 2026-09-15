#!/bin/sh
# ==============================================================================
# Launcher for the libredb-studio snap daemon (issue #113).
#
# snap.yaml command lines do not expand environment variables in arguments,
# so this script execs the bundled private Node runtime against the payload
# server.js. server.js chdirs to the payload directory itself; the zero-config
# first run generates missing auth secrets next to the storage database and
# logs the admin password once (snap logs libredb-studio).
#
# The defaults live here, not in the app's environment block in snapcraft.yaml
# (issue #807): snap-exec applies that block over the caller's environment, so
# a key set there can never be overridden by the systemd drop-in the docs
# recommend. A default here applies only when the operator set nothing.
# ==============================================================================
set -eu

: "${NODE_ENV:=production}"
: "${NEXT_TELEMETRY_DISABLED:=1}"
: "${STORAGE_PROVIDER:=sqlite}"
: "${STORAGE_SQLITE_PATH:=$SNAP_DATA/libredb-storage.db}"
: "${PORT:=3000}"

# Local-first bind, as in the .deb/.rpm wrapper (issue #134): under systemd
# (INVOCATION_ID set) HOSTNAME is the operator's drop-in value or loopback. A
# direct `snap run` must not bind to an inherited HOSTNAME such as a Docker
# container ID, so it takes LIBREDB_BIND or loopback instead.
if [ -n "${INVOCATION_ID:-}" ]; then
  : "${HOSTNAME:=127.0.0.1}"
else
  HOSTNAME="${LIBREDB_BIND:-127.0.0.1}"
fi

export NODE_ENV NEXT_TELEMETRY_DISABLED STORAGE_PROVIDER STORAGE_SQLITE_PATH PORT HOSTNAME

exec "$SNAP/node/bin/node" "$SNAP/server.js"
