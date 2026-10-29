#!/usr/bin/env bash
# Re-records every capture in this directory in one run, in file order, against a fresh container:
#
#   docker run -d --name <name> -p <port>:1521 \
#     -e ORACLE_PASSWORD=not-a-real-password \
#     -e APP_USER=APP_OWNER -e APP_USER_PASSWORD=not-a-real-password \
#     gvenzl/oracle-free:slim@sha256:6d61d267a3b978c24c5ac1790e62e927416a0aec446bd86e4b3a1527562757bd
#   tests/fixtures/oracle/23.26.3-free/agent-boundary/run.sh <name> <port>
#
# APP_USER makes the image create the schema owner APP_OWNER in FREEPDB1; 01 creates the rest.
# Run it from the repository root once the container logs "DATABASE IS READY TO USE!", so 10
# resolves oracledb from the root node_modules. Sequence values in 04 to 08 depend on this order.
set -euo pipefail
name="$1"
port="$2"
dir="$(cd "$(dirname "$0")" && pwd)"
pw="not-a-real-password"
sql() {
  local user="$1" file="$2"
  docker exec -i "$name" sqlplus -s -l "$user/$pw@//localhost:1521/FREEPDB1" \
    < <(cat "$dir/$file.sql"; printf '\nexit\n') > "$dir/$file.txt"
}
sql SYSTEM 01-setup-as-system
sql SYSTEM 02-public-grants-as-system
sql APP_RO 03-writes-as-app-ro
sql APP_RO 04-transaction-roles-links-as-app-ro
sql APP_RO_SYS 05-alter-system-as-read-only-privileged-user
sql APP_RO 06-sequence-in-read-only-transaction-as-app-ro
sql APP_RO 07-public-sequences-as-app-ro
sql APP_RO 08-definer-rights-units-as-app-ro
sql SYSTEM 09-definer-rights-effects-as-system
node "$dir/10-driver-transaction-end-as-app-ro.mjs" "127.0.0.1:$port/FREEPDB1" \
  > "$dir/10-driver-transaction-end-as-app-ro.txt"
