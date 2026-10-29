REM The two catalog views the check reads for policies and auditing handlers: SYSTEM is refused the grant, so SYS
REM grants them to APP_R3; and a column group, whose extended statistics add a hidden virtual column to a plain table.
set feedback on echo on pagesize 100 linesize 160
whenever sqlerror continue
CONNECT SYSTEM/not-a-real-password@//localhost:1521/FREEPDB1
GRANT SELECT ON SYS.DBA_POLICIES TO APP_R3;
CONNECT SYS/not-a-real-password@//localhost:1521/FREE AS SYSDBA
ALTER SESSION SET CONTAINER = FREEPDB1;
GRANT SELECT ON SYS.DBA_POLICIES TO APP_R3;
GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO APP_R3;
CREATE TABLE APP_OWNER.R3_ES (A NUMBER, B NUMBER);
SELECT DBMS_STATS.CREATE_EXTENDED_STATS('APP_OWNER', 'R3_ES', '(A, B)') AS EXTENSION FROM DUAL;
GRANT SELECT ON APP_OWNER.R3_ES TO APP_R3;
