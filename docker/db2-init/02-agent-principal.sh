#!/bin/bash
# The agent's least-privilege user (docs/providers/db2.md, "The agent user"). Every file in /var/custom runs on every
# container start, after 01-object-fixture.sh, so this one is idempotent: the operating-system user is created once,
# and the .sql beside the fixture's runs only while AGENT_RO holds no CONNECT. The password is a local fixture value.
set -euo pipefail
id agent_ro >/dev/null 2>&1 || useradd -M agent_ro
echo 'agent_ro:not-a-real-password' | chpasswd
su - "${DB2INSTANCE}" -c "db2 connect to ${DBNAME} >/dev/null && if [ \"\$(db2 -x \"SELECT COUNT(*) FROM SYSCAT.DBAUTH WHERE GRANTEE = 'AGENT_RO' AND CONNECTAUTH = 'Y'\" | tr -d ' ')\" = 0 ]; then db2 -tvf /var/custom-fixture/02-agent-principal.sql; else echo 'db2-init: agent principal already set up'; fi; db2 terminate"
