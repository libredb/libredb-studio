-- The DuckDB object-surface and object-source fixture (#789).
--
-- Two catalogs, four schemas, and at least one object of every declared kind, so every
-- assertion `tests/integration/db/duckdb-provider.test.ts` makes about counts, listings,
-- detail and definition text is made about objects THIS file created.
--
-- Applied two ways, by one reader: the integration suite replays it into `:memory:`, and
-- `bun docker/duckdb-init/build-fixture.ts` replays it into a database FILE a person can
-- point Studio at. Before #789 this DDL lived only inside the suite, which is the shape
-- standing ruling 5i forbids: a measurement nobody outside the test run can re-run.
--
-- THE SECOND CATALOG'S TARGET IS A PLACEHOLDER, and it has to be. `ATTACH ':memory:' AS
-- warehouse` gives the suite a second real catalog inside one process; a database FILE
-- needs a sibling file there instead, or every `warehouse` object vanishes the moment the
-- builder exits and a person opening the file finds one catalog where the tests saw two.
-- `readFixtureStatements()` substitutes {{warehouse}} and throws by name when nothing
-- substituted it.
--
-- DuckDB has NO trigger and NO stored procedure (both are parser errors on v1.5.5), so
-- neither appears below and neither is declared.

CREATE SCHEMA analytics;

CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, note VARCHAR DEFAULT 'none');
CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES main.customers(id), total DECIMAL(12,2));
CREATE INDEX ix_orders_customer ON main.orders(customer_id);

CREATE TABLE analytics.events (id BIGINT, payload VARCHAR);

-- Two SAME-NAMED tables in two schemas, with different columns and an index each. This is
-- what a detail read's schema filter is for: without it `main.customers` and
-- `analytics.customers` merge, and the merged answer is a table with columns it does not
-- have rather than an error anybody would notice.
CREATE TABLE analytics.customers (event_id BIGINT);
CREATE TABLE analytics.orders (id INTEGER);
CREATE INDEX ix_orders_customer ON analytics.orders(id);

CREATE VIEW main.customer_names AS SELECT name FROM main.customers;
CREATE VIEW analytics.event_days AS SELECT id FROM analytics.events;

-- One macro of each form. A scalar macro is `function_type` 'macro' and a table macro is
-- 'table_macro'; they are the whole vocabulary `FUNCTION_TYPE_RULES` accounts for, and
-- both are here so the two arms cannot rot into one.
CREATE MACRO main.add_one(x) AS x + 1;
CREATE MACRO analytics.recent_events(n) AS TABLE SELECT * FROM analytics.events LIMIT n;

CREATE SEQUENCE main.customer_seq START 1;
CREATE SEQUENCE analytics.event_seq START 100;

-- One name, three kinds, in one schema, and it is the reason `readObjectSource` takes the
-- KIND as well as the path. Measured on DuckDB v1.5.5: `CREATE SEQUENCE overlap` and
-- `CREATE MACRO overlap(x)` both succeed while the table `overlap` exists, and only
-- `CREATE VIEW overlap` is refused (`Catalog Error: Table with name "overlap" already
-- exists!`). A source read keyed on the name alone answers one of the three at random.
CREATE TABLE main.overlap (id INTEGER);
CREATE SEQUENCE main.overlap;
CREATE MACRO main.overlap(x) AS x;

-- A second real catalog, with a schema set of its own and no macro or sequence, so a
-- declared-and-empty folder has somewhere to be measured.
ATTACH '{{warehouse}}' AS warehouse;
CREATE SCHEMA warehouse.stock;
CREATE TABLE warehouse.main.ledger (id INTEGER);
-- Same SCHEMA name, same TABLE name, different CATALOG. This is the two-level engine's
-- characteristic case and the only thing that can show the catalog filter working: a
-- detail read that dropped `database_name = $1` would merge `memory.main.customers` with
-- this one and report a table with columns from both.
CREATE TABLE warehouse.main.customers (sku VARCHAR);
CREATE TABLE warehouse.stock.items (sku VARCHAR);
