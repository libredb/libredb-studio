#!/bin/sh
# ==============================================================================
# postinstall for the libredb-studio .deb/.rpm packages (nfpm scripts:).
#
# Runs on install and upgrade. deb postinst receives "configure" for both;
# rpm %post receives 1 (install) or 2 (upgrade) - restarting only when the
# service is already active covers upgrades in both worlds without touching
# fresh installs (the package never enables or starts the service itself;
# operators do that with "systemctl enable --now libredb-studio").
# ==============================================================================
set -e

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl is-active --quiet libredb-studio.service 2>/dev/null; then
    systemctl restart libredb-studio.service >/dev/null 2>&1 || true
  fi
fi

exit 0
