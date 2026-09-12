-- The SQLite object-surface fixture (#789).
--
-- This file IS the fixture: `tests/integration/db/sqlite-provider.test.ts` reads it through
-- `readFixtureStatements()` in `build-fixture.ts` and replays it into an in-memory database,
-- so every object the object-surface and Source tests reason about is created BY this file
-- rather than by a literal inside the test. `bun docker/sqlite-init/build-fixture.ts` turns
-- the same text into a database FILE a person can point Studio at.
--
-- There is no `docker compose` service for SQLite and there never will be: the engine is a
-- file, and the build script is what an init directory would be for any other engine.
--
-- Statements are separated by a `;` at the end of a line. A `CREATE TRIGGER` body holds its
-- own semicolons, so the splitter ends such a statement only at the `;` after its `END` -
-- the trap D53 recorded, and the reason the splitter is a shared function rather than a
-- `split(";")` in each caller. `ANALYZE` appears nowhere: sqld refuses it outright, and this
-- file is applied to that server too.

-- A UNIQUE column, so SQLite also creates `sqlite_autoindex_customers_1`, which is the one
-- row of `sqlite_schema` whose `sql` is NULL. The provider's `name NOT LIKE 'sqlite\_%'`
-- filter is what keeps it out of every listing, which is why the source read has no
-- reachable refusal on this engine.
CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);

-- Two foreign keys of the two shapes SQLite publishes differently, and a generated column,
-- which `PRAGMA table_info` drops and `table_xinfo` publishes. Written over several lines
-- on purpose: `sqlite_schema.sql` keeps the newlines and the inner spacing, which is what
-- `origin: "stored"` means and what a regeneration would destroy.
CREATE TABLE orders (
     id INTEGER PRIMARY KEY,
     customer_id INTEGER REFERENCES customers,
     customer_email TEXT REFERENCES customers(email),
     total INTEGER NOT NULL DEFAULT 0,
     total_with_tax INTEGER GENERATED ALWAYS AS (total * 2) VIRTUAL
   );

-- A composite primary key, so `table_info.pk` carries the ranks 1 and 2.
CREATE TABLE archive (region TEXT, year INTEGER, PRIMARY KEY (region, year)) WITHOUT ROWID;

-- AUTOINCREMENT, so the engine adds `sqlite_sequence` to `PRAGMA table_list`.
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT);

INSERT INTO audit_log (note) VALUES ('seed');

-- A user table the UNESCAPED `LIKE 'sqlite_%'` would also exclude, because `_` is LIKE's
-- single-character wildcard. SQLite reserves only the `sqlite_` prefix, so this name is one
-- a user can really have.
CREATE TABLE sqliteXledger (id INTEGER PRIMARY KEY);

-- One `virtual` row and five `shadow` rows in `PRAGMA table_list`.
CREATE VIRTUAL TABLE notes USING fts5(body);

CREATE VIEW order_summary AS SELECT id, total FROM orders;

CREATE INDEX idx_orders_customer ON orders(customer_id);

-- An index on an EXPRESSION, whose key publishes a null column name.
CREATE INDEX idx_orders_doubled ON orders(total * 2);

CREATE TRIGGER orders_stamp AFTER INSERT ON orders BEGIN UPDATE orders SET total = total; END;

-- SQLite allows an INSTEAD OF trigger on a VIEW, so a trigger's parent segment is not always
-- a table even though the kind declares `attachedTo: "table"`.
CREATE TRIGGER order_summary_guard INSTEAD OF INSERT ON order_summary BEGIN SELECT 1; END;

-- A TRIGGER whose name is ALSO a TABLE's, which SQLite accepts: measured on SQLite 3.53.2,
-- `CREATE TRIGGER audit_log ON audit_log` is legal while `CREATE INDEX audit_log` answers
-- "there is already a table named audit_log" and `CREATE VIEW audit_log` answers "table
-- audit_log already exists". A trigger has its own namespace and a table, a view and an
-- index share one.
--
-- It is here for the source read and for nothing else. `SELECT sql FROM sqlite_schema WHERE
-- name = ?` answers TWO rows for this name and the table's comes first, so a read that took
-- its `type` from what the name matched rather than from the KIND would hand a reader the
-- table's DDL under a trigger's address. Without this object that defect is invisible: every
-- other name in this file resolves to exactly one row whatever the type filter does.
CREATE TRIGGER audit_log AFTER INSERT ON audit_log BEGIN SELECT 1; END;

-- Session scratch that shadows `main`, and must never reach the tree. The temp `orders`
-- carries ONE column, so a detail read that forgot the schema is visible as a different
-- column list rather than as an error.
CREATE TEMP TABLE orders (id INTEGER);

CREATE TEMP VIEW order_summary AS SELECT 1 AS x;

CREATE TEMP TRIGGER orders_stamp_temp AFTER INSERT ON orders BEGIN SELECT 1; END;

CREATE INDEX temp.idx_orders_customer_temp ON orders(id);

-- Another database file entirely, which the connection was not configured for.
ATTACH DATABASE ':memory:' AS attached;

CREATE TABLE attached.orders (id INTEGER);

CREATE VIEW attached.order_summary AS SELECT 1 AS x;

CREATE INDEX attached.idx_orders_customer_attached ON orders(id);

CREATE TRIGGER attached.orders_stamp_attached AFTER INSERT ON orders BEGIN SELECT 1; END;
