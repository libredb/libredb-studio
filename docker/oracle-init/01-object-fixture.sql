-- Object-browser fixture for the Oracle provider (#789, #765).
--
-- Mounted at /container-entrypoint-initdb.d in database-compose.yml, so gvenzl/oracle-xe
-- runs it through SQL*Plus once, on a FRESH data directory only. An already-initialized
-- container has to be recreated before an edit here takes effect.
--
-- Two things about this file are load-bearing and must not be "tidied":
--
--  1. The `/` terminators. SQL*Plus needs one to end a PL/SQL block, and they are correct
--     HERE because SQL*Plus is what runs this file. They must never be sent through
--     node-oracledb, which takes one statement per execute() and answers ORA-00911 for a
--     trailing terminator.
--  2. APP_BROKEN_PKG does not compile, on purpose. Its spec is VALID and its body is
--     INVALID, which is the state Oracle is in most often and the one the tree has to
--     render: a successful CREATE OR REPLACE can still leave the object INVALID. A run
--     with only a working package cannot tell a working spec-and-body collapse from no
--     collapse at all.
--
-- The scripts run as SYSDBA against CDB$ROOT, so the container switch is the first
-- statement and every object below is schema-qualified. CURRENT_SCHEMA is deliberately
-- not used: it governs name RESOLUTION, and relying on it to decide where a CREATE lands
-- would put the fixture's correctness on an Oracle subtlety instead of on the name.
ALTER SESSION SET CONTAINER = XEPDB1;

-- Two owners, because one owner cannot show that the single-owner confinement is gone.
-- Before #765 every read was hard-scoped to OWNER = <connecting user>, so the app showed
-- exactly one schema with no way to reach another.
CREATE USER app IDENTIFIED BY "Password123!" QUOTA UNLIMITED ON USERS;
GRANT CONNECT, RESOURCE, CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE SYNONYM TO app;
-- CREATE TABLE is already in RESOURCE, and granting it again is not redundant: measured,
-- CREATE MATERIALIZED VIEW below answered ORA-01031 without this line. Creating a
-- materialized view in another user's schema checks that the OWNER holds CREATE TABLE
-- DIRECTLY, and a privilege held through a role does not satisfy that check.
GRANT CREATE TABLE TO app;

CREATE USER reporting IDENTIFIED BY "Password123!" QUOTA UNLIMITED ON USERS;
GRANT CONNECT, RESOURCE TO reporting;

-- Tables, one per owner. REPORTING's is granted to APP so the second container answers
-- something rather than being an empty folder that proves nothing.
CREATE TABLE app.app_orders (
  id           NUMBER(10)     NOT NULL,
  customer_id  NUMBER(10),
  total        NUMBER(12, 2)  DEFAULT 0,
  note         VARCHAR2(200),
  CONSTRAINT app_orders_pk PRIMARY KEY (id)
);

CREATE TABLE app.app_customers (
  id    NUMBER(10) NOT NULL,
  name  VARCHAR2(100),
  CONSTRAINT app_customers_pk PRIMARY KEY (id)
);

-- Two rows, and they are part of the deliverable rather than decoration (#789, standing
-- ruling 5i). APP is the connecting user's own schema, so this is the DEFAULT-container
-- click: the tree writes APP.APP_CUSTOMERS and an empty table cannot tell a statement the
-- server accepted from one it rejected, because both answer with no rows. Two is the
-- smallest count that is not one: a single row cannot show that a limit clause left the
-- rows alone.
INSERT INTO app.app_customers (id, name) VALUES (1, 'ada');
INSERT INTO app.app_customers (id, name) VALUES (2, 'grace');

ALTER TABLE app.app_orders ADD CONSTRAINT app_orders_customer_fk
  FOREIGN KEY (customer_id) REFERENCES app.app_customers (id);

CREATE INDEX app.app_orders_total_ix ON app.app_orders (total);

CREATE TABLE reporting.report_daily (
  report_day  DATE NOT NULL,
  orders      NUMBER(10),
  CONSTRAINT report_daily_pk PRIMARY KEY (report_day)
);

-- Two rows in the OTHER owner, which is the cross-container click: APP reads these through
-- the GRANT below, and the statement the tree writes has to be REPORTING.REPORT_DAILY
-- rather than the bare name. Written as DATE literals so the rows do not depend on the
-- session's NLS_DATE_FORMAT.
INSERT INTO reporting.report_daily (report_day, orders) VALUES (DATE '2026-09-01', 10);
INSERT INTO reporting.report_daily (report_day, orders) VALUES (DATE '2026-09-02', 20);

GRANT SELECT ON reporting.report_daily TO app;

CREATE OR REPLACE VIEW app.app_order_summary AS SELECT 1 AS id FROM dual;

CREATE MATERIALIZED VIEW app.app_revenue_mv AS SELECT 1 AS id FROM dual;

CREATE SYNONYM app.app_orders_syn FOR app.app_orders;

CREATE SEQUENCE app.app_invoice_seq;

CREATE OR REPLACE FUNCTION app.app_order_total(p_id NUMBER) RETURN NUMBER IS BEGIN RETURN p_id; END;
/

CREATE OR REPLACE PROCEDURE app.app_touch_order(p_id NUMBER) IS BEGIN NULL; END;
/

CREATE OR REPLACE PACKAGE app.app_orders_pkg IS
  FUNCTION total(p_id NUMBER) RETURN NUMBER;
END app_orders_pkg;
/

CREATE OR REPLACE PACKAGE BODY app.app_orders_pkg IS
  FUNCTION total(p_id NUMBER) RETURN NUMBER IS BEGIN RETURN p_id; END;
END app_orders_pkg;
/

-- Deliberately invalid: the acceptance run must see a VALID spec beside an INVALID body,
-- which is the state Oracle is in most often and the one a tree must render.
CREATE OR REPLACE PACKAGE app.app_broken_pkg IS
  FUNCTION total RETURN NUMBER;
END app_broken_pkg;
/

CREATE OR REPLACE PACKAGE BODY app.app_broken_pkg IS
  FUNCTION total RETURN NUMBER IS BEGIN RETURN no_such_column; END;
END app_broken_pkg;
/

CREATE OR REPLACE TRIGGER app.app_orders_trg BEFORE INSERT ON app.app_orders
  FOR EACH ROW BEGIN NULL; END;
/

-- A trigger APP owns whose base table belongs to REPORTING. ALL_TRIGGERS separates OWNER
-- from TABLE_OWNER for exactly this case, and the provider has to decide which one the
-- path hangs off; see docs/providers/oracle.md.
GRANT CREATE ANY TRIGGER TO app;

CREATE OR REPLACE TRIGGER app.report_daily_trg BEFORE INSERT ON reporting.report_daily
  FOR EACH ROW BEGIN NULL; END;
/

-- An INSTEAD OF trigger, whose base object is a VIEW rather than a table.
CREATE OR REPLACE TRIGGER app.app_view_trg INSTEAD OF INSERT ON app.app_order_summary
  BEGIN NULL; END;
/

-- A trigger with NO base object at all: measured, ALL_TRIGGERS gives it TABLE_NAME NULL
-- and BASE_OBJECT_TYPE 'SCHEMA', so it hangs off the container rather than off a table.
-- ADMINISTER DATABASE TRIGGER is required even for the schema-scoped form, because LOGON
-- is a database event.
GRANT ADMINISTER DATABASE TRIGGER TO app;

CREATE OR REPLACE TRIGGER app.app_logon_trg AFTER LOGON ON app.SCHEMA BEGIN NULL; END;
/

-- Explicit, rather than relying on SQL*Plus committing on EXIT. Measured on gvenzl/oracle-xe
-- 21.3.0: EXIT does commit, so this line changes nothing today, and it is here because the
-- INSERTs above are the only DML in the file and a fixture whose data survives on a client
-- convention is one image upgrade away from coming back empty.
COMMIT;

EXIT;
