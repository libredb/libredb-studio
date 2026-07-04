#!/bin/sh
# ==============================================================================
# preremove for the libredb-studio .deb/.rpm packages (nfpm scripts:).
#
# Stops and disables the service only on full removal, never on upgrade:
# deb prerm receives "remove" | "upgrade" | ...; rpm %preun receives 0
# (uninstall) or >= 1 (upgrade). Without this, "apt remove" / "rpm -e"
# would delete /usr/lib/libredb-studio and the unit while the old server
# keeps running from deleted files until reboot.
# ==============================================================================
set -e

case "${1:-}" in
  remove | 0)
    if [ -d /run/systemd/system ]; then
      systemctl stop libredb-studio.service >/dev/null 2>&1 || true
      systemctl disable libredb-studio.service >/dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
