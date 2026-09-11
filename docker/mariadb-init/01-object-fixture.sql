-- Object-browser fixture for the MySQL provider's MariaDB branch (#789).
--
-- Mounted at /docker-entrypoint-initdb.d in database-compose.yml, so the mariadb image
-- runs it through its own client once, on a FRESH data directory only. An
-- already-initialized container has to be recreated before an edit here takes effect.
--
-- It exists as a SECOND file rather than as a branch inside the MySQL one because this
-- provider's `objectKinds` is not a constant: it is resolved from the server's own version
-- string, and MariaDB declares two kinds MySQL does not have at all. A test that never
-- connects to a real MariaDB cannot tell a working branch from a dead one, so the second
-- server is the point.
--
-- Three things here are load-bearing:
--
--  1. `DELIMITER` is a CLIENT command, correct here for the same reason as in the MySQL
--     file, and never to be sent through mysql2.
--  2. `SET sql_mode = 'ORACLE'` is REQUIRED for CREATE PACKAGE and changes the grammar of
--     everything after it, so it comes last and nothing that is not a package follows it.
--  3. `app.order_archive` is deliberately both a table and a stored procedure, the same
--     namespace pair the MySQL file carries, so the measurement is taken on both servers
--     rather than on one.

CREATE DATABASE IF NOT EXISTS app;
CREATE DATABASE IF NOT EXISTS reporting;

CREATE TABLE reporting.regions (
  id   INT NOT NULL,
  name VARCHAR(80),
  PRIMARY KEY (id)
);

USE app;

CREATE TABLE customers (
  id   INT NOT NULL,
  name VARCHAR(100),
  PRIMARY KEY (id)
);

CREATE TABLE orders (
  id          INT            NOT NULL,
  customer_id INT,
  region_id   INT,
  total       DECIMAL(12, 2) DEFAULT 0,
  note        VARCHAR(200),
  PRIMARY KEY (id),
  KEY orders_total_ix (total, note),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT orders_region_fk FOREIGN KEY (region_id) REFERENCES reporting.regions (id)
);

CREATE VIEW order_summary AS
  SELECT c.name AS customer, SUM(o.total) AS total
  FROM orders o JOIN customers c ON c.id = o.customer_id
  GROUP BY c.name;

CREATE TABLE order_archive (
  id       INT NOT NULL,
  archived DATE,
  PRIMARY KEY (id)
);

-- MariaDB's own kind, and it is a TABLE to information_schema: measured on
-- 12.3.2-MariaDB-ubu2404, a sequence is a row of information_schema.TABLES with
-- TABLE_TYPE = 'SEQUENCE', it carries eight columns of its own in
-- information_schema.COLUMNS, and it occupies the table namespace (CREATE SEQUENCE over an
-- existing table name answers ERROR 1050).
CREATE SEQUENCE invoice_number_seq START WITH 1 INCREMENT BY 1;

-- MariaDB's OTHER TABLE_TYPE, and it is in the fixture for the same reason the sequence is:
-- `tests/live/mysql-object-vocabulary.ts` asks the server `SELECT DISTINCT TABLE_TYPE`, which
-- reports only the spellings the server's DATA exhibits, so a fixture missing a case makes the
-- guard blind to it. Measured on 12.3.2, this table is TABLE_TYPE = 'SYSTEM VERSIONED', and the
-- provider maps it to `table` rather than to a kind of its own: it is a table you still SELECT
-- from and INSERT into.
--
-- The one case a fixture CANNOT carry is TEMPORARY: a temporary table belongs to the session
-- that made it, and this file's session ends when the image finishes initializing.
CREATE TABLE order_audit (
  id       INT NOT NULL,
  note     VARCHAR(200),
  row_start BIGINT UNSIGNED GENERATED ALWAYS AS ROW START,
  row_end   BIGINT UNSIGNED GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME(row_start, row_end),
  PRIMARY KEY (id)
) WITH SYSTEM VERSIONING;

DELIMITER //

CREATE DEFINER = `root`@`localhost` PROCEDURE order_archive(IN p_id INT)
BEGIN
  INSERT INTO order_archive (id, archived) VALUES (p_id, CURRENT_DATE());
END //

CREATE PROCEDURE touch_order(IN p_id INT)
BEGIN
  UPDATE orders SET note = CONCAT(COALESCE(note, ''), '.') WHERE id = p_id;
END //

CREATE FUNCTION order_total(p_id INT) RETURNS DECIMAL(12, 2)
READS SQL DATA
BEGIN
  DECLARE v_total DECIMAL(12, 2);
  SELECT total INTO v_total FROM orders WHERE id = p_id;
  RETURN COALESCE(v_total, 0);
END //

CREATE TRIGGER orders_stamp BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
  SET NEW.total = COALESCE(NEW.total, 0);
END //

DELIMITER ;

CREATE EVENT orders_nightly
  ON SCHEDULE EVERY 1 DAY
  DO DELETE FROM order_archive WHERE archived < (CURRENT_DATE() - INTERVAL 1 YEAR);

-- LAST, and everything below it is a package. ORACLE mode is what makes CREATE PACKAGE
-- parse at all, and it rewrites the grammar of every statement after it.
--
-- A package is TWO rows of information_schema.ROUTINES, PACKAGE and PACKAGE BODY, exactly
-- as Oracle's dictionary has it. The body cannot exist alone: measured, CREATE PACKAGE
-- BODY with no specification answers ERROR 1305 "PACKAGE app.orphan_pkg does not exist",
-- so the PACKAGE row is present for every package and counting that row alone is complete.
SET sql_mode = 'ORACLE';

DELIMITER //

CREATE PACKAGE orders_pkg AS
  PROCEDURE touch_order(p_id INT);
  FUNCTION order_total(p_id INT) RETURN INT;
END //

CREATE PACKAGE BODY orders_pkg AS
  PROCEDURE touch_order(p_id INT) AS
  BEGIN
    UPDATE orders SET note = 'touched' WHERE id = p_id;
  END;
  FUNCTION order_total(p_id INT) RETURN INT AS
  BEGIN
    RETURN 0;
  END;
END //

DELIMITER ;
