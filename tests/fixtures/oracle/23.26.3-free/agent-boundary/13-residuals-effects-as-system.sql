REM Each sequence of 11, after 12: one per mechanism, NOCACHE, so LAST_NUMBER - 1 is the number of calls.
set feedback on echo on pagesize 100 linesize 160
whenever sqlerror continue
col sequence_name format a12
SELECT SEQUENCE_NAME, LAST_NUMBER FROM DBA_SEQUENCES WHERE SEQUENCE_OWNER = 'APP_OWNER' AND SEQUENCE_NAME LIKE 'S\_%' ESCAPE '\' ORDER BY 1;
