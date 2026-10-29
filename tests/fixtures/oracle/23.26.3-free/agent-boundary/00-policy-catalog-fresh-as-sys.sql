REM What a fresh database holds in the two catalogs of row-level security and fine-grained auditing policies, before
REM anything else runs: every row-level policy's function is one a schema Oracle maintains owns, and no auditing policy.
set feedback on echo on pagesize 100 linesize 160
whenever sqlerror continue
col object_owner format a6
col object_name format a14
col policy_name format a20
col pf_owner format a8
col package format a10
col function format a22
col oracle_maintained format a3
SELECT p.OBJECT_OWNER, p.OBJECT_NAME, p.POLICY_NAME, p.PF_OWNER, p.PACKAGE, p.FUNCTION, u.ORACLE_MAINTAINED FROM SYS.DBA_POLICIES p LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = p.PF_OWNER ORDER BY 1, 2, 3;
SELECT COUNT(*) AS AUDIT_POLICIES FROM SYS.DBA_AUDIT_POLICIES;
