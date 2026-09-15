#!/bin/bash
# The icr.io/db2_community/db2 image runs every executable in /var/custom as root, once its
# first-boot setup has created the database named by DBNAME. The SQL runs as the instance
# owner through the Command Line Processor, with `@` as the terminator because compound SQL
# bodies carry `;`. An already-initialized data directory skips first boot, so an edit to the
# fixture needs the container recreated.
set -euo pipefail
su - "${DB2INSTANCE}" -c "db2 connect to ${DBNAME} && db2 -td@ -vf /var/custom/01-object-fixture.sql; db2 terminate"
