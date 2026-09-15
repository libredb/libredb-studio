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

-- An EXECUTE-only caller, for the source-read refusal recorded in docs/providers/mysql.md
-- (#789), and it sits HERE, above `SET sql_mode = 'ORACLE'`, so it is parsed under the
-- default mode with the rest of the file.
--
-- MEASURED on MariaDB 12.3.2: this user sees all five `information_schema.ROUTINES` rows
-- with a NULL `ROUTINE_DEFINITION`, and `SHOW CREATE PROCEDURE`, `SHOW CREATE FUNCTION`,
-- `SHOW CREATE PACKAGE` and `SHOW CREATE PACKAGE BODY` each answer a ROW whose body column
-- is NULL rather than raising. MariaDB utters no sentence for it, so the provider supplies
-- its own.
--
-- A caller holding NOTHING on `app` is a DIFFERENT case and is deliberately not modelled
-- here: that caller is told `ERROR 1305 (42000) PROCEDURE order_archive does not exist`,
-- which is byte-identical to what a genuinely absent object answers, and it sees no row in
-- `information_schema.ROUTINES` either, so it never reaches the source read.
CREATE USER IF NOT EXISTS 'src_probe'@'%' IDENTIFIED BY 'src_probe';
GRANT EXECUTE ON app.* TO 'src_probe'@'%';

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

-- A package SPECIFICATION with no BODY, which is the ONE-PART shape of the source read
-- (#789). MEASURED on MariaDB 12.3.2: `SHOW CREATE PACKAGE app.spec_only_pkg` answers the
-- spec text and `SHOW CREATE PACKAGE BODY app.spec_only_pkg` answers
-- `ERROR 1305 (42000) PACKAGE BODY spec_only_pkg does not exist`, so a body's absence is
-- told apart from the package's absence by asking for the SPEC first. The other direction
-- is measured too and is why one PACKAGE row per package is a complete count: a
-- `CREATE PACKAGE BODY` with no specification is refused with the same ER_SP_DOES_NOT_EXIST.
--
-- `information_schema.ROUTINES` holds ONE row for this package, ROUTINE_TYPE 'PACKAGE',
-- where `orders_pkg` holds two.
CREATE PACKAGE spec_only_pkg AS
  PROCEDURE p1(p_id INT);
END //

DELIMITER ;
