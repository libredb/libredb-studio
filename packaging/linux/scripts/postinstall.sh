#!/bin/sh
# ==============================================================================
# postinstall for the libredb-studio .deb/.rpm packages (nfpm scripts:).
#
# Runs on install and upgrade. deb postinst receives "configure" for both;
# rpm %post receives 1 (install) or 2 (upgrade). The same two commands are
# correct in all of those cases: reload the unit files, then "try-restart",
# which systemd documents as "stop and then start ... if the units are
# running. This does nothing if units are not running". So an upgrade picks
# up the new payload and a fresh install is left alone - the package never
# enables or starts the service itself (operators do that with
# "systemctl enable --now libredb-studio"). try-restart replaces an
# "is-active" probe followed by "restart": one command instead of two, and
# no window between the probe and the restart.
#
# SYSTEMD_RUNTIME_DIR is the systemd-presence probe. LIBREDB_SYSTEMD_RUNTIME_DIR
# overrides it for tests only, so they can exercise both the systemd and the
# non-systemd branch without depending on how the host running them is booted
# (same reason the launcher honours LIBREDB_STUDIO_HOME - see
# packaging/linux/libredb-studio). Real installs never set it and keep the
# /run/systemd/system default.
# ==============================================================================
set -e

SYSTEMD_RUNTIME_DIR="${LIBREDB_SYSTEMD_RUNTIME_DIR:-/run/systemd/system}"

if [ -d "$SYSTEMD_RUNTIME_DIR" ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl try-restart libredb-studio.service >/dev/null 2>&1 || true
fi

exit 0
