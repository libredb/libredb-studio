#!/bin/bash
set -euo pipefail
fail() { echo "FATAL: $1" >&2; exit 1; }

# 1. Credentials and keys. AWS: "Remove all user credentials from the system"
#    and "Ensure that root login is disabled or locked". The sshd_config drop-in
#    itself is installed and verified in 02-configure.sh, because the effective
#    config check needs the host keys that step 2 deletes.
passwd -l root || true
rm -f /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys
rm -f /home/ubuntu/.ssh/known_hosts /root/.ssh/known_hosts

# 2. Host keys: cloud-init regenerates them per instance.
shred -u /etc/ssh/*_key /etc/ssh/*_key.pub 2>/dev/null || rm -f /etc/ssh/*_key /etc/ssh/*_key.pub

# 3. Nothing instance-specific may persist.
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id

# 4. Logs and history. journald FIRST and by its own tooling: its journals are
#    mmapped, so truncating them under a running journald leaves "Journal file
#    corrupted or uncleanly shut down" on the buyer's first boot — a visible
#    error in exactly the place the reviewer and the buyer look.
journalctl --rotate --quiet || true
journalctl --vacuum-time=1s --quiet || true
rm -rf /var/log/journal/* || true
find /var/log -type f ! -path '/var/log/journal/*' -exec truncate -s 0 {} \; 2>/dev/null || true
rm -f /root/.bash_history /home/ubuntu/.bash_history
apt-get clean
rm -rf /var/lib/apt/lists/*

# 5. cloud-init state LAST: this wipes /var/lib/cloud/* (except seed), which is
#    exactly why the first-boot logic lives in systemd units and not in
#    /var/lib/cloud/scripts/per-instance the way the DigitalOcean image does.
cloud-init clean --logs

# 6. Assert the invariants instead of hoping. The test operators differ on
#    purpose: -f means "must not exist at all" (an empty authorized_keys is
#    evidence the rm did not do what we think), while /etc/machine-id MUST
#    remain present and zero-length — that empty file is systemd's documented
#    first-boot signal, so -f there would fail a correct image.
[ ! -f /home/ubuntu/.ssh/authorized_keys ] || fail "authorized_keys survived"
[ ! -f /root/.ssh/authorized_keys ]        || fail "root authorized_keys survived"
[ ! -f /etc/libredb-studio.env ]           || fail "a generated env file is baked into the image"
[ -f /etc/machine-id ] && [ ! -s /etc/machine-id ] || fail "machine-id is missing or not empty"
if ls /etc/ssh/*_key >/dev/null 2>&1; then fail "host keys survived"; fi
exit 0
