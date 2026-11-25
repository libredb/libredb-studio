-- The least-privilege principal the agent read-only execution profile requires on SQL Server.
--
-- NOT mounted in database-compose.yml, for the reason 01-object-fixture.sql states: the
-- mcr.microsoft.com/mssql/server image has no init-script directory at all, so there is
-- nowhere to mount it. Apply it by hand, against the database the agent will read, once the
-- container answers:
--
--   docker cp docker/mssql-init/02-agent-principal.sql <container>:/tmp/agent-principal.sql
--   docker exec <container> /opt/mssql-tools18/bin/sqlcmd \
--     -S localhost -U sa -P '<password>' -C -b -d <database> -i /tmp/agent-principal.sql
--
-- `-d <database>` is load-bearing and is not a convenience. A LOGIN is server-scoped and a
-- USER is database-scoped, and everything below the CREATE LOGIN is the database half: run
-- this against `master` and the agent gets a principal in the wrong database, which fails at
-- the profile's own open with a refusal about permissions rather than about the target.
--
-- The `GO` separators are the same client convention 01-object-fixture.sql documents. They
-- never reach the server, sqlcmd is what runs this file, and they must never be sent through
-- node-mssql, which takes one batch per query() and answers "Incorrect syntax near 'GO'".
-- Here they also order the drops: a LOGIN cannot be dropped in the same batch that still
-- holds the USER mapped to it.
--
-- The password is the login's own name, which is the convention every other credential in
-- this repository's fixtures follows (`postgres`, `root`, `admin`, `druid`, `src_probe`), and
-- 01-object-fixture.sql argues the case: a fixture credential shaped like a real password is
-- indistinguishable from one, to a secret scanner and to a reader. Use a real secret for a
-- real deployment; `docs/providers/mssql.md` is where an operator meets that instruction.
--
-- ============================================================================
-- Why this principal is the boundary, and why each grant is the size it is
-- ============================================================================
--
-- SQL Server has no read-only transaction: there is no `BEGIN TRANSACTION READ ONLY` and no
-- session-level read-only switch. So the first layer of the agent profile is not a
-- transaction that refuses the write, as it is on PostgreSQL, but the PRINCIPAL that may not
-- make one. `MSSQLProvider.assertAgentPrincipalIsUnprivileged` verifies that at open, before
-- any statement is sent, and a principal that fails it gets `PROFILE_PRIVILEGES_TOO_BROAD`
-- rather than a bounded run.
--
-- Measured on SQL Server 2022 (RTM-CU26, 16.0.4265.3) against AdventureWorks2022 as exactly
-- the principal this file creates: every write was refused by the server (INSERT, UPDATE and
-- DELETE with Msg 229, CREATE TABLE with Msg 262, DROP with Msg 3701), and so were
-- `xp_cmdshell`, `sp_OACreate`, `OPENROWSET(BULK …)`, `sp_execute_external_script`,
-- `xp_regread`, `sp_configure` + `RECONFIGURE`, `EXECUTE AS`, `ALTER SERVER ROLE` and every
-- read of another user database. `sa` is the positive control: it did all of them, and `sa`
-- is therefore REFUSED by the profile - not by name, but because it is a member of
-- `sysadmin`, which is the first entry of the forbidden list.
--
--  * `db_datareader` is the whole read surface. It is a role rather than per-table grants
--    because the profile's job is to bound what a statement may DO, and what it may READ is
--    bounded by the grants an operator chooses: narrow this to per-table `SELECT` grants and
--    the profile still holds, with a smaller reach. Backlog A3 and A8 record what
--    is still unbounded either way.
--
--  * `VIEW DEFINITION` is what makes the catalog reads answer for anything that is not a
--    table. Measured, twice, on this fixture's own AdventureWorks2022: a principal holding
--    `db_datareader` alone counts 0 rows in `sys.objects WHERE type = 'P'` and 31 in
--    `sys.sql_modules`; the same principal with this grant counts 10 and 52. That is SQL
--    Server's metadata visibility rule, which shows an object only to a principal holding
--    some permission ON it - and `SELECT` is not applicable to a procedure. Without this
--    grant the agent's grounding reads do not fail, which is worse: they answer, and they
--    answer that the database has no procedures.
--
--  * `VIEW DATABASE STATE` is what lets a model-written read of a DATABASE-scoped dynamic
--    management view answer. Measured on the same pair: `sys.dm_db_partition_stats` is
--    "VIEW DATABASE PERFORMANCE STATE permission denied" without it and 384 rows with it,
--    and `sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED')` is "The user
--    does not have permission to perform this action" without it and 197 rows with it. No
--    statement this repository COMPOSES reads a DMV (`src/lib/agent/composed-sql.ts` reads
--    `sys.objects`, `sys.columns`, `sys.indexes`, `sys.foreign_key_columns` and
--    `sys.partitions`, all catalog views a reader already sees), so this grant is for the
--    statements the MODEL writes on the optimization and assessment workflows. Drop it if
--    the reach you want is catalog-only; nothing in the profile requires it.
--
--    It deliberately stops at the database. The SERVER-scoped views stay denied, measured:
--    `sys.dm_exec_query_stats`, `sys.dm_os_sys_info` and `sys.dm_db_index_usage_stats` all
--    answer "VIEW SERVER PERFORMANCE STATE permission was denied on object 'server'" with
--    this grant held. That is the intended shape rather than a shortfall - the operations
--    workflow reads those through the provider's own curated methods on a different profile,
--    and widening this principal to reach them would put the whole server inside the
--    boundary of a statement a model wrote.
--
--  * `SHOWPLAN` is REQUIRED, and it is the one grant that is not about reading data. The
--    profile admits a statement by asking the optimizer to COMPILE it and return one plan row
--    per node (`SET SHOWPLAN_ALL ON`), executing nothing: it reads the roots, refuses
--    anything that is not exactly one statement of an admitted class, and only then runs it.
--    Measured, a `DROP TABLE` sent under SHOWPLAN left the table in place. So a principal
--    that cannot ask for a plan cannot be admitted at all, and the profile refuses to open
--    for one rather than fall back to sending the statement unexamined. The check is
--    `HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SHOWPLAN')`, read fail-CLOSED the other way
--    from the rest: `ISNULL(…, 0)`, so an unreadable answer means not granted.
--
-- GRANT NOTHING ELSE. The profile refuses to open for a principal holding any of `sysadmin`,
-- `securityadmin`, `serveradmin`, `setupadmin`, `processadmin`, `diskadmin`, `dbcreator`,
-- `bulkadmin`, `db_owner`, `db_accessadmin`, `db_securityadmin`, `db_ddladmin`,
-- `db_backupoperator`, `db_datawriter`, `CONTROL SERVER` or `ADMINISTER BULK OPERATIONS`, and
-- it reads every one of those answers fail-closed - `IS_SRVROLEMEMBER` and `IS_ROLEMEMBER`
-- answer NULL rather than 0 for a name the server cannot resolve, so an unresolvable answer
-- reads as HELD. `db_datawriter` is in that list beside `sysadmin` on purpose: it is the
-- smallest grant that ends the boundary, because it makes the server accept the write the
-- profile is built to have refused.
--
-- No `GRANT CONNECT` appears below. `CREATE USER … FOR LOGIN` grants it, measured: the
-- principal this file creates connects with no further grant.

-- ============================================================================
-- libredb_agent: dropped and recreated, in dependency order
-- ============================================================================
-- Re-runnable rather than incremental, so a second run cannot leave a grant made by an
-- earlier edit of this file in place. That matters more here than it would for a table: a
-- privilege this file no longer mentions is exactly the kind of thing the profile exists to
-- refuse, and an operator who re-runs the file is entitled to get what the file says.
IF DATABASE_PRINCIPAL_ID('libredb_agent') IS NOT NULL
  DROP USER libredb_agent;
GO
IF SUSER_ID('libredb_agent') IS NOT NULL
  DROP LOGIN libredb_agent;
GO

CREATE LOGIN libredb_agent WITH PASSWORD = 'libredb_agent', CHECK_POLICY = OFF;
GO

CREATE USER libredb_agent FOR LOGIN libredb_agent;
GO

ALTER ROLE db_datareader ADD MEMBER libredb_agent;
GO

GRANT VIEW DEFINITION TO libredb_agent;
GO

GRANT VIEW DATABASE STATE TO libredb_agent;
GO

GRANT SHOWPLAN TO libredb_agent;
GO

-- What the principal ended up with, printed by the file that made it. A grant that silently
-- did not land reads exactly like one that did, and the profile's refusal at open names the
-- privilege it found rather than the one it wanted, so this is the cheapest place to see the
-- whole set at once.
SELECT
  r.name AS role_member_of
FROM sys.database_role_members m
JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
WHERE u.name = 'libredb_agent';
GO

SELECT
  p.permission_name,
  p.state_desc,
  p.class_desc
FROM sys.database_permissions p
JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
WHERE u.name = 'libredb_agent'
ORDER BY p.permission_name;
GO
