#!/bin/bash
# The agent's least-privilege user (docs/providers/db2.md section 10.1). Every file in /var/custom runs on every
# container start, after 01-object-fixture.sh, so this one is idempotent: the operating-system user is created once,
# and the .sql beside the fixture's runs until AGENT_RO reads APP.ORDERS. That is checked rather than CONNECT, because
# the fixture can be skipped on a fresh volume (D160), and the grants on its tables then wait for a start that has
# loaded it; a revoke run twice only answers SQL0556N. The count is read through a file, not a pipeline: a db2 command
# in a pipeline does not share the connection the shell made, and answers SQL1024N instead (measured).
# The password is a local fixture value.
set -euo pipefail
id agent_ro >/dev/null 2>&1 || useradd -M agent_ro
echo 'agent_ro:not-a-real-password' | chpasswd
su - "${DB2INSTANCE}" -c "db2 connect to ${DBNAME} >/dev/null && db2 -x \"SELECT COUNT(*) FROM SYSCAT.TABAUTH WHERE GRANTEE = 'AGENT_RO' AND TABSCHEMA = 'APP' AND TABNAME = 'ORDERS' AND SELECTAUTH = 'Y'\" > /tmp/db2-init-agent-ro.count; if [ \"\$(tr -d ' \n' < /tmp/db2-init-agent-ro.count)\" = 1 ]; then echo 'db2-init: agent principal already set up'; else db2 -tvf /var/custom-fixture/02-agent-principal.sql || true; fi; db2 terminate"
