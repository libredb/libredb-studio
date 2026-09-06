#!/bin/bash
set -euo pipefail

install -d -m 0755 /opt/libredb
# 0700, and the MODE is the control rather than the ownership: the container
# starts as root (the Dockerfile sets no USER), docker-entrypoint.sh chowns this
# bind mount to nextjs (uid 1001) and then execs gosu to drop to it, so the
# directory does not stay root-owned on the buyer's instance. The credential
# fields inside the store are already sealed under a key derived from
# JWT_SECRET, so this is defence in depth rather than the only thing between a
# local user and a password.
install -d -m 0700 /opt/libredb/data

install -m 0644 /tmp/libredb-files/etc/systemd/system/libredb-studio.service    /etc/systemd/system/
install -m 0644 /tmp/libredb-files/etc/systemd/system/libredb-firstboot.service /etc/systemd/system/
install -m 0644 /tmp/libredb-files/etc/systemd/system/libredb-banner.service    /etc/systemd/system/
install -m 0755 /tmp/libredb-files/usr/local/sbin/libredb-firstboot             /usr/local/sbin/
install -m 0755 /tmp/libredb-files/usr/local/sbin/libredb-banner                /usr/local/sbin/

# run-parts --lsbsysinit ignores files with a dot in the name and skips anything
# without the exec bit. Both matter.
install -m 0755 /tmp/libredb-files/etc/update-motd.d/99-libredb-studio /etc/update-motd.d/99-libredb-studio

# sshd policy, installed and VERIFIED here rather than in 90-cleanup.sh: `sshd -T`
# needs host keys, and cleanup deletes them.
#
# `00-` prefix, not `99-`: sshd_config Includes /etc/ssh/sshd_config.d/*.conf at
# the top, the glob is read in lexical order, and sshd keeps the FIRST value it
# sees for a keyword — so a `99-` file loses to Ubuntu's own 50-cloud-init.conf.
install -m 0644 /tmp/libredb-files/etc/ssh/sshd_config.d/00-libredb-marketplace.conf \
  /etc/ssh/sshd_config.d/00-libredb-marketplace.conf
# Canonical's Server image ships openssh-server and AWS requires SSH to be
# reachable for its vetting procedure, so its absence means the base image is not
# what this template thinks it is.
command -v sshd >/dev/null \
  || { echo "FATAL: openssh-server is not installed - wrong base image?" >&2; exit 1; }
# The drop-in must actually carry both directives on the installed path. The
# effective-config assertions below CANNOT prove this: Ubuntu's own
# 50-cloud-init.conf already sets PasswordAuthentication no and Canonical's
# sshd_config already sets PermitRootLogin prohibit-password, so `sshd -T`
# answers correctly even if this file were empty or never installed at all.
grep -qx 'PasswordAuthentication no' /etc/ssh/sshd_config.d/00-libredb-marketplace.conf \
  || { echo "FATAL: the sshd drop-in is missing PasswordAuthentication no" >&2; exit 1; }
grep -qx 'PermitRootLogin prohibit-password' /etc/ssh/sshd_config.d/00-libredb-marketplace.conf \
  || { echo "FATAL: the sshd drop-in is missing PermitRootLogin prohibit-password" >&2; exit 1; }

sshd -t || { echo "FATAL: sshd config does not parse" >&2; exit 1; }
# A here-string, not a pipe: `grep -q` exits on its first match, and under
# `set -o pipefail` the producer's SIGPIPE (141) would surface as the whole
# command failing - aborting the build with the exact opposite of what happened.
grep -qx 'passwordauthentication no' <<<"$(sshd -T)" \
  || { echo "FATAL: effective sshd config still permits password authentication" >&2; exit 1; }
grep -qE '^permitrootlogin (no|prohibit-password|forced-commands-only)$' <<<"$(sshd -T)" \
  || { echo "FATAL: effective sshd config still permits root password login" >&2; exit 1; }

# Build-time substitutions — must run AFTER the files are in place. One line per
# token; each token appears exactly once here and once in the scan below.
#
# The Packer variable's validation should already have rejected an address
# carrying any of these, so this is the second lock. The image ref cannot contain
# them (OCI grammar), so it needs no such treatment.
#
# Escapes all three sed metacharacters the Packer variable's description names:
# `&` (the whole match), `\` (an escape), and `|` (the delimiter used below - an
# address containing one could otherwise close the expression and run a second
# sed command as root at build time).
support_escaped=$(printf '%s' "$SUPPORT_EMAIL" | sed -e 's/[\\&|]/\\&/g')
sed -i "s|PINNED_IMAGE|${IMAGE_REF}|"          /etc/systemd/system/libredb-studio.service
sed -i "s|SUPPORT_CONTACT|${support_escaped}|" /usr/local/sbin/libredb-banner

# One scan for every token this build is supposed to have replaced. The support
# address matters as much as the image pin: unsubstituted, it ships to every
# buyer's first-boot banner and EC2 console log, in the field AWS requires to
# carry a real support contact.
for token in PINNED_IMAGE SUPPORT_CONTACT; do
  if grep -rq "$token" /etc/systemd/system/libredb-studio.service /usr/local/sbin/; then
    echo "FATAL: $token still present after substitution. Either environment_vars is missing on this provisioner, or the replacement value contains a sed metacharacter." >&2
    exit 1
  fi
done

cat > /etc/libredb-studio.build <<EOF
app_version="${VERSION}"
app_image="${IMAGE_REF}"
build_date="$(date -u +%Y-%m-%d)"
EOF
chmod 644 /etc/libredb-studio.build

systemctl daemon-reload
# All three are enabled at build time. Nothing enables or starts anything at
# runtime: libredb-studio and libredb-banner each carry a ConditionPathExists
# that makes them skip until their input exists, and systemd owns the ordering.
systemctl enable libredb-firstboot.service libredb-studio.service libredb-banner.service
rm -rf /tmp/libredb-files
