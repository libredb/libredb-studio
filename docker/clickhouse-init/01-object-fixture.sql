-- Object-browser fixture for the ClickHouse provider (#789).
--
-- Mounted at /docker-entrypoint-initdb.d in database-compose.yml, so the
-- clickhouse-server image feeds it to clickhouse-client once, on a FRESH data directory
-- only. An already-initialized container has to be recreated before an edit here takes
-- effect. Every name is written database-qualified rather than relying on the client's
-- default database, because CLICKHOUSE_DB only decides which database the client opens
-- against and two of the objects below deliberately live somewhere else.
--
-- The fixture holds one object of EVERY kind the provider declares: table, view,
-- materialized_view, dictionary and function. The object-surface conformance helper
-- calls listObjects for every kind whose expected count is above zero, so a kind missing
-- here is a kind the live acceptance pass cannot certify.
--
-- Four shapes below are load-bearing and must not be "tidied":
--
--  1. `demo.mv_rollup` has NO `TO` clause, so the server creates an implicit inner table
--     named `.inner_id.<the view's uuid>` and gives it a real storage engine. It must
--     appear in neither the count nor the listing.
--  2. `demo.mv_to_target` IS an explicit `TO` target and an ordinary table of its own. It
--     must stay visible. Excluding every table some materialized view writes into would
--     hide it.
--  3. ``demo.`.inner_id.fake` `` is a table a PERSON created whose name matches the inner
--     table pattern. Measured on 26.7.1.1315: the server accepts that name. It is the
--     fixture that refutes `name LIKE '.inner%'` as the exclusion rule, which is why the
--     provider excludes inner tables structurally, by the view's own uuid, instead.
--  4. The dictionary is declared BOTH ways. `demo.dict_customers` is DDL-created, so it
--     has a `system.tables` row; `dict_regions_config` is declared in
--     docker/clickhouse-config/dictionaries.xml and has NO `system.tables` row at all,
--     only a `system.dictionaries` row with an EMPTY database. Dropping the config one
--     makes the provider's dictionary union untestable against the live server.
--
-- `reporting` exists so the container listing can be shown to be the SERVER's databases
-- rather than the one the connection opened against.

CREATE DATABASE IF NOT EXISTS demo;
CREATE DATABASE IF NOT EXISTS reporting;

CREATE TABLE reporting.regions
(
  id   UInt64,
  name String
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO reporting.regions VALUES (1, 'north'), (2, 'south');

CREATE TABLE demo.customers
(
  id        UInt64,
  name      String,
  region_id UInt64,
  email     Nullable(String)
)
ENGINE = MergeTree
PRIMARY KEY id
ORDER BY id;

INSERT INTO demo.customers VALUES (1, 'ada', 1, 'ada@example.com'), (2, 'grace', 2, NULL);

-- A data-skipping index, because describeObject reads system.data_skipping_indices and a
-- table without one cannot tell a working read from a read that returns nothing.
CREATE TABLE demo.orders
(
  id          UInt64,
  customer_id UInt64,
  total       Decimal(12, 2) DEFAULT 0,
  note        String,
  created_at  DateTime DEFAULT now(),
  INDEX orders_note_ix note TYPE set(100) GRANULARITY 4
)
ENGINE = MergeTree
PRIMARY KEY id
ORDER BY (id, customer_id);

INSERT INTO demo.orders (id, customer_id, total, note) VALUES (1, 1, 10.5, 'first'), (2, 2, 20.25, 'second');

CREATE VIEW demo.order_summary AS
  SELECT c.name AS customer, sum(o.total) AS total
  FROM demo.orders AS o
  INNER JOIN demo.customers AS c ON c.id = o.customer_id
  GROUP BY c.name;

-- Shape 2: an explicit TO target, and an ordinary table in its own right.
CREATE TABLE demo.mv_to_target
(
  customer_id UInt64,
  total       Decimal(12, 2)
)
ENGINE = MergeTree
ORDER BY customer_id;

CREATE MATERIALIZED VIEW demo.mv_to_customer TO demo.mv_to_target AS
  SELECT customer_id, total FROM demo.orders;

-- Shape 1: no TO clause, so this one owns an implicit inner table.
CREATE MATERIALIZED VIEW demo.mv_rollup
ENGINE = SummingMergeTree
ORDER BY customer_id AS
  SELECT customer_id, sum(total) AS total FROM demo.orders GROUP BY customer_id;

-- Shape 3: the name a pattern-based exclusion would wrongly hide.
CREATE TABLE demo.`.inner_id.fake`
(
  x UInt8
)
ENGINE = MergeTree
ORDER BY x;

-- Shape 4a: the DDL dictionary. LIFETIME 0 means never reloaded, and LAYOUT(FLAT) keeps
-- the source read trivial; neither is required for the object surface, which reads the
-- catalog rather than the dictionary's contents.
CREATE DICTIONARY demo.dict_customers
(
  id   UInt64,
  name String
)
PRIMARY KEY id
SOURCE(CLICKHOUSE(TABLE 'customers' DB 'demo' USER 'libredb' PASSWORD 'password123'))
LAYOUT(FLAT())
LIFETIME(MIN 0 MAX 0);

-- Shape 5: a TABLE whose engine is `Dictionary`. Measured on 26.7.1.1315: the server
-- accepts it, gives it a system.tables row with engine `Dictionary` and gives it NO
-- system.dictionaries row. It is a table that reads a dictionary, not a dictionary, so it
-- is what refutes `engine = 'Dictionary'` as the way to identify one. The provider asks
-- system.dictionaries for membership instead, and this table therefore belongs in the
-- Tables folder.
CREATE TABLE demo.dict_customers_proxy
(
  id   UInt64,
  name String
)
ENGINE = Dictionary(demo.dict_customers);

-- A user-defined function. CREATE FUNCTION takes no database qualifier, because a
-- ClickHouse UDF is SERVER-GLOBAL: system.functions has no database column at all.
CREATE FUNCTION order_total_with_tax AS (total) -> total * 1.2;
