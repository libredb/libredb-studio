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
# docker/db2-init/02-agent-principal.sql, the seed's PUBLIC revokes, so its capture has no .sql here. Captures 00 to 11
# were recorded on 2026-10-29, before the seed revoked SELECT on the distribution statistics; 12 was recorded on
# 2026-11-02 after the seed with those revokes had run. 13 revokes from PUBLIC the seven objects that keep HIGH2KEY and
# LOW2KEY, which the seed did not then, and 14 shows what the agent user then reads; both were recorded on 2026-11-02 on
# a container holding the object fixture and the seed. The seed now revokes those seven too, so a fresh run records 13's
# revokes as SQL0556N. 15 to 17 were recorded on 2026-11-02 on a container whose seed holds the seven revokes: 15 creates
# a table of the types the value-free column read spells, 16 shows what SYSIBM.COLUMNS, SYSIBM.SQLCOLUMNS and a zero-row
# describe answer the agent user, and 17 drops what 15 created. 16 was re-recorded on 2026-11-02 to read a distinct
# type's name from UDT_SCHEMA and UDT_NAME. 18 to 20 were recorded on 2026-11-02 on the same kind of container: 18
# leaves a table set integrity pending and one REORG-pending, 19 shows the agent user that a zero-row read of either
# answers while a read of the check-pending table's rows is refused, and 20 drops them.
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
clp agent-ro 09-trusted-contexts-as-agent-ro
clp agent-ro 10-external-action-functions-as-agent-ro
clp db2inst1 11-ibm-module-alter-as-db2inst1
in_container su - db2inst1 -c "db2 connect to testdb >/dev/null; db2 \"CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE APP.SECRET WITH DISTRIBUTION')\" >/dev/null; db2 terminate >/dev/null"
clp agent-ro 12-catalog-scope-as-agent-ro
clp db2inst1 13-column-statistics-revokes-as-db2inst1
clp agent-ro 14-column-sources-as-agent-ro
clp db2inst1 15-value-free-fixture-as-db2inst1
clp agent-ro 16-value-free-sources-as-agent-ro
clp db2inst1 17-value-free-fixture-drop-as-db2inst1
clp db2inst1 18-pending-states-as-db2inst1
clp agent-ro 19-pending-states-as-agent-ro
clp db2inst1 20-pending-states-drop-as-db2inst1
