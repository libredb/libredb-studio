REM What APP_R3 reads of the policy and auditing catalog once granted: the policy on the table behind R3_BEHIND_V,
REM which ALL_POLICIES does not list it, and the auditing handler, whose ALL_AUDIT_POLICIES it may not read; and the
REM column group's hidden virtual column.
set feedback on echo on pagesize 100 linesize 160
whenever sqlerror continue
col object_owner format a10
col object_name format a12
col object_schema format a10
col policy_name format a12
col pf_owner format a10
col pf_schema format a10
col pf_function format a10
col function format a10
col table_name format a8
col column_name format a32
col name format a12
col referenced_name format a12
SELECT OBJECT_OWNER, OBJECT_NAME, POLICY_NAME, PF_OWNER, FUNCTION FROM DBA_POLICIES WHERE OBJECT_OWNER IN ('APP_OWNER', 'PUBLIC') AND OBJECT_NAME LIKE 'R3\_%' ESCAPE '\' ORDER BY 1, 2;
SELECT OBJECT_SCHEMA, OBJECT_NAME, POLICY_NAME, PF_SCHEMA, PF_FUNCTION FROM DBA_AUDIT_POLICIES WHERE OBJECT_SCHEMA = 'APP_OWNER' AND OBJECT_NAME LIKE 'R3\_%' ESCAPE '\' ORDER BY 1, 2;
SELECT NAME, REFERENCED_NAME FROM ALL_DEPENDENCIES WHERE OWNER = 'APP_OWNER' AND NAME = 'R3_BEHIND_V';
SELECT TABLE_NAME, COLUMN_NAME, HIDDEN_COLUMN, VIRTUAL_COLUMN FROM ALL_TAB_COLS WHERE OWNER = 'APP_OWNER' AND TABLE_NAME = 'R3_ES' ORDER BY 2;
