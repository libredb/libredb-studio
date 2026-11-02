#!/bin/bash
# The icr.io/db2_community/db2 image executes every file in /var/custom on every container
# start, after its own setup, so only this script is mounted there; the .sql it feeds to the
# CLP is mounted beside it under /var/custom-fixture. A database that already holds the
# fixture is left alone, which makes a restart a no-op instead of a wall of SQL0601N errors.
# Only a count of 0 loads it and only 1 skips it; any other answer, an SQL error included,
# fails the script with the server's answer on stderr, so a check that did not run is never
# read as a loaded fixture, and a load the CLP ends with an error (return code 4 or above)
# fails it too. The count is read through a file, not a pipeline: a db2 command
# in a pipeline does not share the connection the shell made, and answers SQL1024N instead.
set -euo pipefail
su - "${DB2INSTANCE}" -c "f=\$(mktemp) || exit 1; db2 connect to ${DBNAME} > \"\$f\" && db2 -x \"SELECT COUNT(*) FROM SYSCAT.TABLES WHERE TABSCHEMA = 'APP' AND TABNAME = 'ORDERS'\" > \"\$f\"; case \"\$(tr -d ' \n' < \"\$f\")\" in 0) db2 -td@ -vf /var/custom-fixture/01-object-fixture.sql; lrc=\$?; if [ \$lrc -ge 4 ]; then echo 'db2-init: the fixture load failed' >&2; rc=1; else rc=0; fi ;; 1) echo 'db2-init: fixture already loaded'; rc=0 ;; *) echo 'db2-init: the fixture check answered neither 0 nor 1:' >&2; cat \"\$f\" >&2; rc=1 ;; esac; rm -f \"\$f\"; db2 terminate; exit \$rc"
