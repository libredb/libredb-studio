#!/usr/bin/env bash
# Re-records every capture in this directory in one run, in file order, against a fresh container:
#
#   docker run -d --name <name> --cap-add IPC_LOCK --cap-add IPC_OWNER -p <port>:50000 \
#     -e LICENSE=accept -e DB2INSTANCE=db2inst1 -e DB2INST1_PASSWORD=Password123 -e DBNAME=testdb \
#     -e ARCHIVE_LOGS=false -e AUTOCONFIG=false -e SAMPLEDB=false \
#     icr.io/db2_community/db2@sha256:feaf79431bedf185b1fc8fcf2ac2ae020be54eb78e774d44bf467da55e63e1e2
#   tests/fixtures/db2/12.1.0.0/agent-boundary/run.sh <name>
#
# Run it from the repository root once the container logs "Setup has completed". It loads the object fixture
# (docker/db2-init/01-object-fixture.sql) and creates the operating-system user AGENT_RO first. Every capture runs
# under the CLP with autocommit on, except 05, which rolls its own unit of work back. 07 runs
# docker/db2-init/02-agent-principal.sql, the seed's PUBLIC revokes, so its capture has no .sql here.
set -euo pipefail
name="$1"
dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$dir/../../../../.." && pwd)"
agent_pw="not-a-real-password"
in_container() {
  docker exec -i "$name" "$@"
}
copy() {
  docker cp "$1" "$name:/tmp/$(basename "$1")" >/dev/null
  in_container chmod 644 "/tmp/$(basename "$1")"
}
clp() {
  local who="$1" file="$2" login=""
  [ "$who" = "agent-ro" ] && login=" user AGENT_RO using $agent_pw"
  copy "$dir/$file.sql"
  in_container su - db2inst1 -c "db2 connect to testdb$login >/dev/null; db2 -tvf /tmp/$file.sql; db2 terminate >/dev/null" \
    > "$dir/$file.txt" || true
}
copy "$root/docker/db2-init/01-object-fixture.sql"
in_container su - db2inst1 -c "db2 connect to testdb >/dev/null; db2 -td@ -f /tmp/01-object-fixture.sql >/dev/null; db2 terminate >/dev/null" || true
in_container bash -c "id agent_ro >/dev/null 2>&1 || useradd -M agent_ro; echo 'agent_ro:$agent_pw' | chpasswd"
clp db2inst1 00-fresh-catalog-as-db2inst1
clp db2inst1 01-setup-as-db2inst1
clp agent-ro 02-raw-as-agent-ro
clp db2inst1 03-effects-as-db2inst1
in_container ls -l /tmp/agent_ro_export.del | awk '{print $1, $3, $4, $5, $9}' >> "$dir/03-effects-as-db2inst1.txt"
clp agent-ro 04-wrapped-as-agent-ro
copy "$dir/05-positive-control-as-db2inst1.sql"
in_container su - db2inst1 -c "db2 connect to testdb >/dev/null; db2 +c -tvf /tmp/05-positive-control-as-db2inst1.sql; db2 terminate >/dev/null" \
  > "$dir/05-positive-control-as-db2inst1.txt" || true
clp db2inst1 06-revokes-as-db2inst1
docker cp "$root/docker/db2-init/02-agent-principal.sql" "$name:/tmp/07-public-revokes-as-db2inst1.sql" >/dev/null
in_container chmod 644 /tmp/07-public-revokes-as-db2inst1.sql
in_container su - db2inst1 -c "db2 connect to testdb >/dev/null; db2 -tvf /tmp/07-public-revokes-as-db2inst1.sql; db2 terminate >/dev/null" \
  > "$dir/07-public-revokes-as-db2inst1.txt" || true
clp agent-ro 08-after-revokes-as-agent-ro
