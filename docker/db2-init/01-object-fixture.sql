-- Object-browser fixture for the Db2 LUW provider (#786, #789).
--
-- Run by 01-object-fixture.sh, which the icr.io/db2_community/db2 image executes from
-- /var/custom once its first-boot setup has created TESTDB. The statement terminator is `@`
-- (db2 -td@) because a compound SQL body carries `;` inside it. The `@` is the CLP's
-- convention and must never reach ibm_db, which sends one statement per call.
--
-- Two schemas, because one cannot show that the object browser reads beyond CURRENT SCHEMA.
-- Every object is schema-qualified: CURRENT SCHEMA decides name RESOLUTION, and relying on
-- it to decide where a CREATE lands would make the fixture depend on the session.

CREATE SCHEMA APP@
CREATE SCHEMA REPORTING@

CREATE TABLE APP.CUSTOMERS (
  ID    INTEGER      NOT NULL,
  NAME  VARCHAR(100),
  CONSTRAINT CUSTOMERS_PK PRIMARY KEY (ID)
)@

CREATE TABLE APP.ORDERS (
  ID           INTEGER       NOT NULL,
  CUSTOMER_ID  INTEGER,
  TOTAL        DECIMAL(12, 2) DEFAULT 0,
  NOTE         VARCHAR(200),
  CONSTRAINT ORDERS_PK PRIMARY KEY (ID),
  CONSTRAINT ORDERS_CUSTOMER_FK FOREIGN KEY (CUSTOMER_ID) REFERENCES APP.CUSTOMERS (ID)
)@

CREATE INDEX APP.ORDERS_CUSTOMER_IX ON APP.ORDERS (CUSTOMER_ID, TOTAL)@

-- Two rows each: an empty table cannot tell a statement the server accepted from one it
-- rejected, and a single row cannot show that a row limit left the rows alone.
INSERT INTO APP.CUSTOMERS VALUES (1, 'Ada'), (2, 'Grace')@
INSERT INTO APP.ORDERS VALUES (1, 1, 10.50, 'first'), (2, 2, 20.00, NULL)@

-- A name only a delimited identifier can spell, so quoting is exercised end to end.
CREATE TABLE APP."Mixed Case" (ID INTEGER NOT NULL PRIMARY KEY)@

-- REPORTING references APP, so a foreign key crosses a schema boundary.
CREATE TABLE REPORTING.DAILY (
  DAY          DATE    NOT NULL,
  CUSTOMER_ID  INTEGER NOT NULL,
  CONSTRAINT DAILY_PK PRIMARY KEY (DAY, CUSTOMER_ID),
  CONSTRAINT DAILY_CUSTOMER_FK FOREIGN KEY (CUSTOMER_ID) REFERENCES APP.CUSTOMERS (ID)
)@

CREATE VIEW APP.ORDER_SUMMARY AS
  SELECT C.NAME, SUM(O.TOTAL) AS TOTAL
  FROM APP.ORDERS O JOIN APP.CUSTOMERS C ON C.ID = O.CUSTOMER_ID
  GROUP BY C.NAME@

CREATE TABLE APP.ORDER_TOTALS AS (
  SELECT CUSTOMER_ID, SUM(TOTAL) AS TOTAL, COUNT(*) AS N FROM APP.ORDERS GROUP BY CUSTOMER_ID
) DATA INITIALLY DEFERRED REFRESH DEFERRED@
REFRESH TABLE APP.ORDER_TOTALS@

CREATE ALIAS APP.CLIENTS FOR APP.CUSTOMERS@

CREATE SEQUENCE APP.ORDER_SEQ START WITH 100 INCREMENT BY 1@

CREATE PROCEDURE APP.ADD_ORDER (IN P_ID INTEGER, IN P_CUSTOMER INTEGER, IN P_TOTAL DECIMAL(12, 2))
LANGUAGE SQL
BEGIN
  INSERT INTO APP.ORDERS (ID, CUSTOMER_ID, TOTAL) VALUES (P_ID, P_CUSTOMER, P_TOTAL);
END@

-- Overloaded: one routine name, two signatures, two SPECIFIC names.
CREATE FUNCTION APP.ORDER_TOTAL (P_ID INTEGER)
RETURNS DECIMAL(12, 2)
LANGUAGE SQL READS SQL DATA
SPECIFIC APP.ORDER_TOTAL_BY_ID
RETURN SELECT TOTAL FROM APP.ORDERS WHERE ID = P_ID@

CREATE FUNCTION APP.ORDER_TOTAL (P_ID INTEGER, P_TAX DECIMAL(5, 2))
RETURNS DECIMAL(12, 2)
LANGUAGE SQL READS SQL DATA
RETURN SELECT TOTAL * (1 + P_TAX) FROM APP.ORDERS WHERE ID = P_ID@

CREATE TRIGGER APP.ORDERS_NOTE_DEFAULT
NO CASCADE BEFORE INSERT ON APP.ORDERS
REFERENCING NEW AS N
FOR EACH ROW
WHEN (N.NOTE IS NULL)
  SET N.NOTE = 'none'@

-- A trigger whose own schema is not its table's schema, which Db2 allows.
CREATE TRIGGER REPORTING.ORDERS_AUDIT
AFTER UPDATE ON APP.ORDERS
FOR EACH ROW
  UPDATE APP.CUSTOMERS SET NAME = NAME WHERE 1 = 0@

-- A module holding a routine: its procedure is not a schema-level procedure.
CREATE MODULE APP.ORDER_MOD@
ALTER MODULE APP.ORDER_MOD PUBLISH PROCEDURE PING () LANGUAGE SQL BEGIN END@

-- A view left invalid by dropping what it reads.
CREATE TABLE APP.SCRATCH (ID INTEGER)@
CREATE VIEW APP.SCRATCH_VIEW AS SELECT ID FROM APP.SCRATCH@
DROP TABLE APP.SCRATCH@

-- An EXTERNAL routine. Db2 keeps no SQL text for one (SYSCAT.ROUTINES.TEXT is NULL, ORIGIN
-- 'E'), so its source read answers a refusal part rather than an empty editor. The library
-- does not exist and does not need to: CREATE records the routine without loading it.
CREATE FUNCTION APP.EXT_FN (X INTEGER) RETURNS INTEGER
LANGUAGE C PARAMETER STYLE SQL NO SQL DETERMINISTIC
EXTERNAL NAME 'nolib!nofn'@
