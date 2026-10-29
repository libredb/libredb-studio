-- What 02 left behind once its session committed: the ledger row a granted function wrote with its owner's authority,
-- the sequence it advanced, and the server file ADMIN_CMD exported (run.sh lists the file after this capture).
SELECT COUNT(*) AS LEDGER_ROWS FROM APP.LEDGER;
SELECT VARCHAR(SEQNAME, 10) AS SEQNAME, NEXTCACHEFIRSTVALUE FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = 'APP';
SELECT COUNT(*) AS CUSTOMERS FROM APP.CUSTOMERS;
SELECT VARCHAR(ROUTINENAME, 16) AS ROUTINENAME FROM SYSCAT.ROUTINES WHERE ROUTINESCHEMA = 'SYSTOOLS' AND ROUTINENAME = 'AGENT_PROBE';
