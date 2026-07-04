#!/bin/sh
# ==============================================================================
# Launcher for the libredb-studio snap daemon (issue #113).
#
# snap.yaml command lines do not expand environment variables in arguments,
# so this script execs the bundled private Node runtime against the payload
# server.js. server.js chdirs to the payload directory itself, and all
# configuration comes from the app's environment block in snapcraft.yaml
# (STORAGE_SQLITE_PATH under $SNAP_DATA, PORT 3000); the zero-config first
# run generates missing auth secrets next to the storage database and logs
# the admin password once (snap logs libredb-studio).
# ==============================================================================
set -eu

exec "$SNAP/node/bin/node" "$SNAP/server.js"
