#!/bin/bash
# The icr.io/db2_community/db2 image executes every file in /var/custom on every container
# start, after its own setup, so only this script is mounted there; the .sql it feeds to the
# CLP is mounted beside it under /var/custom-fixture. A database that already holds the
# fixture is left alone, which makes a restart a no-op instead of a wall of SQL0601N errors.
set -euo pipefail
su - "${DB2INSTANCE}" -c "db2 connect to ${DBNAME} >/dev/null && if [ \"\$(db2 -x \"SELECT COUNT(*) FROM SYSCAT.TABLES WHERE TABSCHEMA = 'APP' AND TABNAME = 'ORDERS'\" | tr -d ' ')\" = 0 ]; then db2 -td@ -vf /var/custom-fixture/01-object-fixture.sql; else echo 'db2-init: fixture already loaded'; fi; db2 terminate"
