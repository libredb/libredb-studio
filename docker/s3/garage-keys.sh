#!/bin/sh
# Garage's RPC secret, admin and metrics tokens and the four key secrets of the S3 fixtures, each 32 random bytes
# as 64 hex digits, written into <dir> only when missing, mode 0600 (docker/s3/README.md). Garage runs as root in
# its image, so root ownership is what it reads. Never prints a secret.
#
#   garage-keys.sh <dir>
set -eu

DIR="$1"
umask 077
for name in rpc.secret admin.token metrics.token rw.secret browse.secret scoped.secret none.secret; do
  [ -s "$DIR/$name" ] && continue
  printf '%s' "$(openssl rand -hex 32)" > "$DIR/$name.tmp"
  chmod 0600 "$DIR/$name.tmp"
  mv "$DIR/$name.tmp" "$DIR/$name"
done
echo "garage-keys.sh: keys in $DIR"
