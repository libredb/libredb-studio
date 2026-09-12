-- The libSQL object-surface fixture (#789), and the file that closes D53.
--
-- It lived as a fenced block in `docs/providers/libsql.md` and nowhere else, which is the
-- shape standing ruling 5i forbids: a person could read it and could not apply it, and the
-- capture in `tests/integration/db/libsql-provider.test.ts` was therefore a measurement
-- nobody could re-run. Sending this file to a running sqld rebuilds exactly the catalog that
-- suite answers from, and `bun docker/sqlite-init/build-fixture.ts <target> 02-libsql-object-fixture.sql`
-- replays the same text into a local database FILE.
--
-- Apply it to the compose service (sqld speaks Hrana over HTTP, so there is no client in the
-- image and `curl` is the applier):
--
--   docker compose -f database-compose.yml up -d libsql
--   bun docker/sqlite-init/apply-to-libsql.ts http://127.0.0.1:18080
--
-- WHY IT IS NOT `01-object-fixture.sql`. The two fixtures are NOT the same DDL, which the
-- Phase 2 plan assumed they were. This one holds a STRICT table, a `UNIQUE`-on-a-ROWID-table
-- autoindex and a foreign-key parent with no primary key, and it holds ten tables where 01
-- holds six; 01 holds `TEMP` and `ATTACH`ed objects, which sqld refuses outright, and an
-- `AUTOINCREMENT` audit table 02 folds into `customers`. Converging them would rewrite every
-- count in both suites and invalidate a live capture neither task took. So one directory,
-- one splitter, one build script, and one file per engine's own captured catalog.
--
-- `ANALYZE` is absent and must stay absent: sqld refuses it ("SQL not allowed statement").

CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, country TEXT DEFAULT 'TR');

CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers,
                     total REAL NOT NULL, tax REAL GENERATED ALWAYS AS (total * 0.2) VIRTUAL, placed_at TEXT);

CREATE TABLE regions (region TEXT NOT NULL, year INTEGER NOT NULL, revenue REAL,
                      PRIMARY KEY (region, year)) WITHOUT ROWID;

CREATE TABLE archive (id INTEGER PRIMARY KEY, body TEXT) STRICT;

CREATE TABLE sqliteXledger (id INTEGER PRIMARY KEY, note TEXT);

CREATE TABLE legacy (note TEXT);

CREATE TABLE legacy_ref (id INTEGER PRIMARY KEY, note TEXT REFERENCES legacy);

CREATE TABLE shipments (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), carrier TEXT);

CREATE TABLE badges (id INTEGER PRIMARY KEY, code TEXT UNIQUE, label TEXT);

CREATE VIRTUAL TABLE notes USING fts5(title, body);

CREATE VIEW order_summary AS SELECT c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id;

CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE INDEX idx_orders_placed ON orders(date(placed_at));

CREATE UNIQUE INDEX idx_customers_name ON customers(name);

CREATE TRIGGER orders_stamp AFTER INSERT ON orders
  BEGIN UPDATE orders SET placed_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER order_summary_guard INSTEAD OF INSERT ON order_summary
  BEGIN SELECT RAISE(ABORT, 'read only'); END;

-- A TRIGGER whose name is ALSO a TABLE's. sqld accepts it, exactly as the file engine does:
-- `SELECT sql FROM sqlite_schema WHERE name = 'badges'` answers TWO rows and the table's
-- comes first, so a source read taking its `type` from what the name matched rather than
-- from the KIND hands a reader the table's DDL under a trigger's address. Every other name
-- in this file resolves to one row whatever the type filter does, so without this object
-- that defect is invisible.
CREATE TRIGGER badges AFTER INSERT ON badges BEGIN SELECT 1; END;
