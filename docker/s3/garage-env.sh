#!/bin/sh
# Prints export lines for the Garage key secrets from a copy of the s3-garage-keys volume, for the live check and
# the seed-connections file (docker/s3/README.md). Run it on the host, never inside a container:
#
#   dir=$(mktemp -d); docker cp libredb-garage-keys:/keys "$dir/keys"; eval "$(sh docker/s3/garage-env.sh "$dir/keys")"
set -eu

DIR="$1"
for pair in ROOT:rw BROWSE:browse SCOPED:scoped GETONLY:none; do
  printf 'export LIBREDB_S3_GARAGE_%s_SECRET=%s\n' "${pair%%:*}" "$(cat "$DIR/${pair#*:}.secret")"
done
