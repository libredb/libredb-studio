-- Object-browser fixture for the MySQL provider (#789).
--
-- Mounted at /docker-entrypoint-initdb.d in database-compose.yml, so the mysql image runs
-- it through its own `mysql` client once, on a FRESH data directory only. An
-- already-initialized container has to be recreated before an edit here takes effect.
--
-- Two things about this file are load-bearing and must not be "tidied":
--
--  1. `DELIMITER` is a CLIENT command, and it is correct HERE because the `mysql` client
--     is what runs this file. It must never be sent through mysql2, which takes one
--     statement per query() and has no notion of it.
--  2. `app.order_archive` is deliberately BOTH a table and a stored procedure, and
--     `app.order_total` is deliberately both a table column's source function and a
--     table of its own. That pair is not decoration: #789 had reasoned that a MySQL
--     table and a MySQL stored routine live in separate namespaces and had never asked
--     the server. Measured on MySQL 26.7.0, they do. Removing the pair removes the only
--     thing that keeps the answer honest.
--
-- The fixture holds one object of every kind the provider declares on a MySQL server:
-- table, view, procedure, function, trigger, event. MariaDB adds two more and has its own
-- file, docker/mariadb-init/01-object-fixture.sql.

CREATE DATABASE IF NOT EXISTS app;
-- A second user database. One cannot show that the container list is the SERVER's
-- databases rather than the one the connection opened against.
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

-- A cross-database foreign key, which InnoDB allows. The object surface has to qualify a
-- reference that leaves the container, because a bare name there addresses a table in the
-- wrong database.
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

-- The namespace pair. A table and a stored procedure of ONE name, in one database.
CREATE TABLE order_archive (
  id       INT NOT NULL,
  archived DATE,
  PRIMARY KEY (id)
);

DELIMITER //

-- An explicit DEFINER, because information_schema.ROUTINES is privilege filtered and a
-- routine whose definer is the connecting user is the easy case that hides that.
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

-- EVERY rather than AT, so the event survives its own schedule: a one-time event with
-- ON COMPLETION NOT PRESERVE drops itself and the Events folder then counts zero.
CREATE EVENT orders_nightly
  ON SCHEDULE EVERY 1 DAY
  DO DELETE FROM order_archive WHERE archived < (CURRENT_DATE() - INTERVAL 1 YEAR);
