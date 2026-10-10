-- The least-privilege principal the agent read-only execution profile requires on MySQL.
--
-- Mounted by database-compose.yml at /docker-entrypoint-initdb.d, so the mysql image runs
-- it once, on a FRESH data directory only - an already-initialized container has to be
-- recreated before an edit here takes effect. Connect against the `app` database the
-- object fixture (01-object-fixture.sql) creates.
--
-- The password is the login's own name, which is the convention every other credential in
-- this repository's fixtures follows (`postgres`, `root`, `admin`, `druid`, `src_probe`).
-- Use a real secret for a real deployment; `docs/providers/mysql.md` is where an operator
-- meets that instruction.
--
-- ============================================================================
-- Why this principal is the boundary, and why the grant is the size it is
-- ============================================================================
--
-- MySQL's `START TRANSACTION READ ONLY` is NOT a boundary on its own, measured on MySQL
-- 26.7.0 (2026-10-09): it refuses DML, `SELECT … FOR UPDATE` and `CREATE TEMPORARY TABLE`
-- with 1792, but `CREATE TABLE`, `DROP`, `TRUNCATE`, `GRANT` and `SET GLOBAL` all go
-- THROUGH, because each causes an implicit commit that ends the read-only transaction
-- first. So the first layer of the agent profile on this engine is the PRINCIPAL:
-- `MySQLProvider.assertAgentPrincipalIsUnprivileged` reads `SHOW GRANTS` at open and
-- admits `USAGE` and `SELECT` alone, and a principal holding anything else is refused
-- with `PROFILE_PRIVILEGES_TOO_BROAD` rather than a bounded run.
--
-- Measured as exactly the principal this file creates: every write was refused by the
-- server (INSERT, CREATE, DROP, TRUNCATE and GRANT with 1142, SET GLOBAL and
-- `SELECT … INTO OUTFILE` with 1227), and so was `SELECT … FOR UPDATE` (1142). `root` is
-- the positive control: it did all of them, and `root` is therefore REFUSED by the
-- profile - not by name, but because its grant line carries privileges past SELECT.
--
--  * `SELECT ON app.*` is the whole read surface. It is a database-level grant rather
--    than per-table because the profile's job is to bound what a statement may DO, and
--    what it may READ is bounded by the grants an operator chooses: narrow this to
--    per-table SELECT grants and the profile still holds, with a smaller reach.
--
--  * NO grant on `mysql`, `information_schema`, `performance_schema` or `sys`. Those
--    catalogues answer to `PUBLIC` what they answer, which the object browser of an
--    ordinary connection shows anyway; `SELECT` on them is not needed to read the
--    composed catalog statements, measured - the `information_schema` reads of the
--    profile return exactly the tables the SELECT grants name.
--
--  * NOTHING that can widen the boundary: no `WITH GRANT OPTION` (a session that can
--    GRANT can widen what the next statement may do), no `EXECUTE` (a DEFINER-right
--    stored routine can write from inside a read the grants allow), no dynamic
--    privileges, no `PROXY`. The grant parser refuses every line it cannot read as
--    USAGE-or-SELECT, fail-closed, so a grant nobody listed here is a refusal rather
--    than a surprise.
--
-- The wire-compatible relatives of this protocol (TiDB, StarRocks, Doris, Vitess,
-- OceanBase, SingleStore, Percona) are NOT admitted by the profile even where they
-- accept these grants: the enforcement was measured on MySQL and MariaDB only, and the
-- ones that self-identify are refused at open. `docs/providers/mysql.md` records which
-- of them cannot be told apart from MySQL by their version string at all.

-- ============================================================================
-- libredb_agent: dropped and recreated
-- ============================================================================
-- Re-runnable rather than incremental, so a second run cannot leave a grant made by an
-- earlier edit of this file in place. A privilege this file no longer mentions is
-- exactly the kind of thing the profile exists to refuse, and an operator who re-runs
-- the file is entitled to get what the file says.
DROP USER IF EXISTS 'libredb_agent'@'%';

CREATE USER 'libredb_agent'@'%' IDENTIFIED BY 'libredb_agent';

GRANT SELECT ON app.* TO 'libredb_agent'@'%';

-- What the principal ended up with, printed by the file that made it. A grant that
-- silently did not land reads exactly like one that did, and the profile's refusal at
-- open names the grant line it found rather than the one it wanted, so this is the
-- cheapest place to see the whole set at once.
SHOW GRANTS FOR 'libredb_agent'@'%';
