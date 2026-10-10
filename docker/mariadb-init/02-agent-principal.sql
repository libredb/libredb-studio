-- The least-privilege principal the agent read-only execution profile requires on MariaDB.
--
-- Mounted by database-compose.yml at the `mariadb` service's /docker-entrypoint-initdb.d,
-- so the mariadb image runs it once, on a FRESH data directory only - an
-- already-initialized container has to be recreated before an edit here takes effect.
-- Connect against the `app` database the object fixture (01-object-fixture.sql) creates.
--
-- It exists as a SECOND file rather than as a branch inside the MySQL one for the same
-- reason 01-object-fixture.sql does: a test that never connects to a real MariaDB cannot
-- tell a working boundary from a dead one, and this server is where the profile's
-- MariaDB half was measured (13.0.2, 2026-10-09).
--
-- The password is the login's own name, the convention every other credential in this
-- repository's fixtures follows. Use a real secret for a real deployment;
-- `docs/providers/mysql.md` is where an operator meets that instruction.
--
-- ============================================================================
-- Why this principal is the boundary, and how MariaDB differs
-- ============================================================================
--
-- The layering is the MySQL one (`02-agent-principal.sql` in docker/mysql-init argues
-- it in full): `START TRANSACTION READ ONLY` refuses DML, `SELECT … FOR UPDATE` and
-- `CREATE TEMPORARY TABLE` with 1792, but DDL, `GRANT` and `SET GLOBAL` end the
-- transaction through their implicit commit, so the PRINCIPAL is the first layer and
-- the transaction the second. Measured as exactly the principal this file creates on
-- MariaDB 13.0.2: INSERT, CREATE, DROP, TRUNCATE and GRANT were refused with 1142,
-- `SET GLOBAL` and `SELECT … INTO OUTFILE` with 1227. `root` did all of them.
--
-- The one difference that costs a sentence: MariaDB does NOT privilege-check
-- `SELECT … FOR UPDATE` the way MySQL does - measured, it ran as a plain SELECT-granted
-- user where MySQL answers 1142. That is why the read-only transaction is a layer of
-- its own on this engine rather than decoration: it is what refuses the locking read,
-- with 1792.
--
-- The MariaDB-only deadline escape is recorded in `docs/providers/mysql.md`: a
-- single-statement `SET STATEMENT max_statement_time = N FOR SELECT …` overrides the
-- session's deadline, measured, which is why the profile's KILL timer is owned by the
-- provider rather than the session variable.

DROP USER IF EXISTS 'libredb_agent'@'%';

CREATE USER 'libredb_agent'@'%' IDENTIFIED BY 'libredb_agent';

GRANT SELECT ON app.* TO 'libredb_agent'@'%';

SHOW GRANTS FOR 'libredb_agent'@'%';
