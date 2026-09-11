-- Object-browser fixture for the SQL Server provider (#789).
--
-- NOT mounted in database-compose.yml, and that is the image rather than an omission:
-- mcr.microsoft.com/mssql/server has no init-script directory at all (no
-- /docker-entrypoint-initdb.d, no /container-entrypoint-initdb.d), so there is nowhere to
-- mount it. Apply it by hand once the container answers:
--
--   docker cp docker/mssql-init/01-object-fixture.sql <container>:/tmp/fixture.sql
--   docker exec <container> /opt/mssql-tools18/bin/sqlcmd \
--     -S localhost -U sa -P '<password>' -C -b -i /tmp/fixture.sql
--
-- Three things about this file are load-bearing and must not be "tidied":
--
--  1. The `GO` separators. They are a client convention that never reaches the server, and
--     they are correct HERE because sqlcmd is what runs this file: CREATE VIEW, CREATE
--     PROCEDURE, CREATE FUNCTION and CREATE TRIGGER must each be the first statement of
--     their batch. They must never be sent through node-mssql, which takes one batch per
--     query() and answers "Incorrect syntax near 'GO'".
--  2. TWO databases, with DIFFERENT schema sets. `listContainers(["libredb_objects_two"])`
--     has to answer THAT database's schemas, and a provider that silently reads the
--     connected database instead cannot be caught by a fixture where both hold the same
--     schemas.
--  3. A DATABASE-scoped DDL trigger. It is absent from sys.objects entirely (measured
--     below on SQL Server 2022 CU26), so a trigger count taken from sys.objects alone is
--     wrong in a way no test on sys.objects can see.

-- ============================================================================
-- libredb_objects: the connected database, two user schemas
-- ============================================================================
DROP DATABASE IF EXISTS libredb_objects;
GO
CREATE DATABASE libredb_objects;
GO
USE libredb_objects;
GO

CREATE SCHEMA app;
GO
CREATE SCHEMA reporting;
GO

CREATE TABLE app.customers (
  id    INT          NOT NULL CONSTRAINT app_customers_pk PRIMARY KEY,
  name  NVARCHAR(100)
);
GO

CREATE TABLE app.orders (
  id           INT            NOT NULL CONSTRAINT app_orders_pk PRIMARY KEY,
  customer_id  INT            CONSTRAINT app_orders_customer_fk REFERENCES app.customers (id),
  total        DECIMAL(12, 2) CONSTRAINT app_orders_total_df DEFAULT 0,
  note         NVARCHAR(200)
);
GO

CREATE INDEX app_orders_total_ix ON app.orders (total);
GO

-- The second schema answers something rather than being an empty folder that proves
-- nothing, and it carries a trigger with the SAME NAME as app's. Measured: a trigger name
-- is unique per SCHEMA on SQL Server, not per table as on PostgreSQL, so two schemas may
-- each hold `stamp_order` and one schema may not.
-- `customer_id` crosses schemas ON PURPOSE. A foreign key whose referenced table is in
-- ANOTHER schema is the only thing that can tell a qualified `referencedTable` from a bare
-- one, and the flat schema query's OBJECT_NAME() answers a bare name for it - which
-- addresses a table in the wrong schema.
CREATE TABLE reporting.daily (
  day         DATE NOT NULL CONSTRAINT reporting_daily_pk PRIMARY KEY,
  orders      INT,
  customer_id INT CONSTRAINT reporting_daily_customer_fk REFERENCES app.customers (id)
);
GO

-- A SYSTEM-VERSIONED temporal pair, and the reason it is here is standing ruling 5a
-- (#789): task 10 derived its vocabulary from its own fixture and a MariaDB
-- system-versioned table then fell out of both the count and the listing. On SQL Server
-- both halves are `sys.objects.type = 'U'` with `temporal_type` beside it, so neither can
-- fall out - and this pair is what measures that rather than assuming it.
CREATE TABLE app.order_audit (
  id         INT NOT NULL CONSTRAINT app_order_audit_pk PRIMARY KEY,
  note       NVARCHAR(100),
  valid_from DATETIME2 GENERATED ALWAYS AS ROW START NOT NULL,
  valid_to   DATETIME2 GENERATED ALWAYS AS ROW END   NOT NULL,
  PERIOD FOR SYSTEM_TIME (valid_from, valid_to)
) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = app.order_audit_history));
GO

-- A table TYPE (`sys.objects.type = 'TT'`) and a RULE (`'R'`). Both are real user objects
-- with no declared kind, and both are here so that "excluded on purpose" is a measurement
-- rather than a claim: the table count must stay at the tables, and neither may appear in
-- any folder.
CREATE TYPE app.order_id_list AS TABLE (id INT NOT NULL);
GO

CREATE RULE app.positive_rule AS @value > 0;
GO

CREATE VIEW app.order_summary AS
  SELECT o.id, o.total, c.name AS customer_name
  FROM app.orders o
  LEFT JOIN app.customers c ON c.id = o.customer_id;
GO

CREATE PROCEDURE app.touch_order @order_id INT AS
  UPDATE app.orders SET note = 'touched' WHERE id = @order_id;
GO

-- FN: a scalar function.
CREATE FUNCTION app.order_total (@order_id INT) RETURNS DECIMAL(12, 2) AS
BEGIN
  DECLARE @total DECIMAL(12, 2);
  SELECT @total = total FROM app.orders WHERE id = @order_id;
  RETURN ISNULL(@total, 0);
END;
GO

-- IF: an inline table-valued function. A different sys.objects.type from FN and TF, and
-- all three are one `function` kind, which is why the mapping is a table and not a case.
CREATE FUNCTION app.orders_for_customer (@customer_id INT)
RETURNS TABLE AS
  RETURN (SELECT id, total FROM app.orders WHERE customer_id = @customer_id);
GO

-- TF: a multi-statement table-valued function.
CREATE FUNCTION app.orders_report ()
RETURNS @report TABLE (id INT, total DECIMAL(12, 2)) AS
BEGIN
  INSERT INTO @report (id, total) SELECT id, total FROM app.orders;
  RETURN;
END;
GO

-- TR, a DML trigger: this one IS in sys.objects.
CREATE TRIGGER app.stamp_order ON app.orders AFTER INSERT AS
  UPDATE app.orders SET note = ISNULL(note, 'inserted') WHERE id IN (SELECT id FROM inserted);
GO

CREATE TRIGGER reporting.stamp_order ON reporting.daily AFTER INSERT AS
  UPDATE reporting.daily SET orders = ISNULL(orders, 0) WHERE day IN (SELECT day FROM inserted);
GO

-- DISABLED on purpose. `sys.triggers.is_disabled` is the one state SQL Server publishes
-- about an object of any kind declared here, the tree renders it, and a fixture where every
-- trigger is enabled cannot tell a mapped state from a hardcoded "ENABLED".
DISABLE TRIGGER reporting.stamp_order ON reporting.daily;
GO

-- A DATABASE-scoped DDL trigger. Absent from sys.objects, present in sys.triggers with
-- parent_class = 0 and parent_id = 0, so it has no schema and no base object: its address
-- is [database, name] and not [database, schema, name].
CREATE TRIGGER ddl_audit ON DATABASE FOR CREATE_TABLE AS
  PRINT 'a table was created';
GO

-- A second DDL trigger, named exactly like the table app.orders. Measured: this succeeds,
-- while CREATE PROCEDURE app.orders, CREATE SEQUENCE app.orders and
-- CREATE TRIGGER app.orders ON app.customers each answer Msg 2714 - every schema object
-- shares one namespace per schema and a DDL trigger is not in it. That pair is what makes
-- describeObject's `kind` argument load-bearing on this engine rather than theoretical: a
-- read keyed on the name alone would hand this trigger the table's columns.
CREATE TRIGGER orders ON DATABASE FOR DROP_TABLE AS
  PRINT 'a table was dropped';
GO

CREATE SYNONYM app.customer_alias FOR app.customers;
GO

CREATE SEQUENCE app.order_number_seq AS INT START WITH 1 INCREMENT BY 1;
GO

-- ============================================================================
-- libredb_objects_two: a DIFFERENT schema set, for the cross-database reads
-- ============================================================================
DROP DATABASE IF EXISTS libredb_objects_two;
GO
CREATE DATABASE libredb_objects_two;
GO
USE libredb_objects_two;
GO

CREATE SCHEMA warehouse;
GO

CREATE TABLE warehouse.stock (
  sku       NVARCHAR(40) NOT NULL CONSTRAINT warehouse_stock_pk PRIMARY KEY,
  on_hand   INT          NOT NULL,
  reorder_at INT
);
GO

CREATE INDEX warehouse_stock_on_hand_ix ON warehouse.stock (on_hand);
GO

-- A user table in a FIXED-ROLE schema, which is legal and measured: db_owner and the eight
-- other role schemas exist to own permissions, so the container list drops them - unless
-- one holds something, which is what keeps that exclusion from hiding a real object. This
-- row is the only thing that can tell the EXISTS arm of `schemasSql` from a bare
-- `is_fixed_role = 0`.
CREATE TABLE db_owner.audit_log (
  id      INT NOT NULL CONSTRAINT db_owner_audit_log_pk PRIMARY KEY,
  message NVARCHAR(200)
);
GO

-- ============================================================================
-- libredb_objects_offline: a database that exists and cannot be opened
-- ============================================================================
-- Measured on SQL Server 2022 CU26: sys.databases keeps the row, state_desc reads OFFLINE
-- and HAS_DBACCESS answers 0. Listing it would draw a container whose schemas can never be
-- read, so the container list is filtered on the engine's own answer rather than on state.
-- Brought back ONLINE before it is dropped, and that is not ceremony: DROP DATABASE on an
-- OFFLINE database removes the catalog entry and LEAVES ITS FILES on disk, so the second
-- run of this file answered Msg 5170 - "Cannot create file ... because it already exists".
IF DB_ID('libredb_objects_offline') IS NOT NULL
  ALTER DATABASE libredb_objects_offline SET ONLINE;
GO
DROP DATABASE IF EXISTS libredb_objects_offline;
GO
CREATE DATABASE libredb_objects_offline;
GO
ALTER DATABASE libredb_objects_offline SET OFFLINE WITH ROLLBACK IMMEDIATE;
GO
