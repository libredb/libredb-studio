set feedback on echo on pagesize 100 linesize 160
whenever sqlerror continue
col name format a16
col value format a8
SELECT NAME, VALUE FROM V$PARAMETER WHERE NAME = 'open_cursors';
SELECT SEQUENCE_NAME, LAST_NUMBER FROM DBA_SEQUENCES WHERE SEQUENCE_OWNER = 'APP_OWNER' ORDER BY 1;
