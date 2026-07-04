#!/bin/sh
# ==============================================================================
# postremove for the libredb-studio .deb/.rpm packages (nfpm scripts:).
#
# Drops the removed unit file from systemd's view. Runs after removal,
# purge, and (on deb) upgrade; a plain daemon-reload is correct and
# harmless in all of those cases.
# ==============================================================================
set -e

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

exit 0
