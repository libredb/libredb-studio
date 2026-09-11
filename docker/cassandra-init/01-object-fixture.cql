-- Object surface fixture for Apache Cassandra (issue #789).
--
-- The cassandra:5.0.9 image has NO init-script directory: its entrypoint runs
-- `cassandra -f` and never scans a mounted folder, and the node is not accepting CQL
-- at the moment the entrypoint starts anyway. So this file is mounted read-only at
-- /fixtures/01-object-fixture.cql purely so it is INSIDE the container, and it is
-- applied by hand once the node reports UN:
--
--   docker compose -f database-compose.yml up -d cassandra
--   until docker exec libredb-cassandra nodetool status | grep -q '^UN'; do sleep 5; done
--   docker exec libredb-cassandra cqlsh -f /fixtures/01-object-fixture.cql
--
-- The same recipe is in docs/providers/cassandra.md, which is where a reader looks.
--
-- TWO SERVER SETTINGS ARE REQUIRED and the compose service sets them, because both
-- ship DISABLED in 5.0: `materialized_views_enabled` and
-- `user_defined_functions_enabled`. Without the first, CREATE MATERIALIZED VIEW is
-- refused with "Materialized views are disabled. Enable in cassandra.yaml to use."
-- Without the second, CREATE FUNCTION is refused with "User-defined functions are
-- disabled in cassandra.yaml - set user_defined_functions_enabled=true to enable".
-- A run against a stock node therefore measures a CONFIGURATION rather than the
-- engine, which is why the service rewrites cassandra.yaml before starting.

DROP KEYSPACE IF EXISTS probe;
DROP KEYSPACE IF EXISTS system_reports;

-- A USER keyspace whose name begins with `system_`. MEASURED on 5.0.9: this statement
-- SUCCEEDS, so the system-keyspace exclusion cannot be a `system%` prefix rule - that
-- rule would hide a keyspace a person created. The provider excludes an exact NAME set
-- and this keyspace is the fixture that refutes the prefix spelling, so it must be
-- listed by `listContainers` rather than filtered out.
CREATE KEYSPACE system_reports WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE KEYSPACE probe WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

-- A user-defined type. `system_schema.types` is its catalog and nothing else lists it.
CREATE TYPE probe.address (street text, city text, postcode text);

-- Three tables, one of them carrying the UDT frozen, so `system_schema.columns`
-- reports a type spelling that is not a CQL primitive.
CREATE TABLE probe.customers (
  id int PRIMARY KEY,
  name text,
  city text,
  home frozen<address>,
  tags map<text, text>
);

CREATE TABLE probe.orders (
  customer_id int,
  order_id int,
  amount decimal,
  PRIMARY KEY (customer_id, order_id)
);

CREATE TABLE probe.events (
  pk int,
  ck int,
  payload text,
  PRIMARY KEY (pk, ck)
) WITH CLUSTERING ORDER BY (ck ASC);

-- TWO INDEX KINDS, deliberately. `system_schema.indexes.kind` is COMPOSITES for the
-- legacy secondary index and CUSTOM for a Storage Attached Index, and the provider
-- must list BOTH: a vocabulary derived from one of them would lose the other, which
-- is standing ruling 5a's absence. Nothing in the provider branches on `kind`.
CREATE INDEX customers_by_city ON probe.customers (city);
CREATE CUSTOM INDEX orders_by_amount ON probe.orders (amount) USING 'sai';
CREATE INDEX customers_by_tag ON probe.customers (KEYS(tags));

-- A materialized view. Every non-key column of the base table's key must be in the
-- view's key, and the view's own key must include all of the base primary key.
CREATE MATERIALIZED VIEW probe.customers_by_city AS
  SELECT id, city, name FROM probe.customers
  WHERE city IS NOT NULL AND id IS NOT NULL
  PRIMARY KEY (city, id);

-- A function taking NO arguments, so `argument_types` is the EMPTY list. Its identity
-- segment is `answer()`, which is what makes the empty case visible rather than
-- inferred: a name-only identity and an argument-type identity agree on every function
-- that takes one argument and disagree here and on the overloaded pair below.
CREATE FUNCTION probe.answer()
  CALLED ON NULL INPUT RETURNS int
  LANGUAGE java AS 'return 42;';

-- TWO FUNCTIONS SHARING ONE NAME, overloaded on argument type. This is the fixture
-- that would refute "a function's name identifies it", and it does not: both rows sit
-- in `system_schema.functions` under function_name = 'render' with different
-- `argument_types`, so the last path segment carries the argument-type list.
CREATE FUNCTION probe.render(value int)
  CALLED ON NULL INPUT RETURNS text
  LANGUAGE java AS 'return value == null ? "null" : value.toString();';

CREATE FUNCTION probe.render(value text)
  CALLED ON NULL INPUT RETURNS text
  LANGUAGE java AS 'return value == null ? "null" : value;';

-- An aggregate needs a state function whose first argument is the state type. The
-- aggregate is overloadable on argument types the same way a function is, and
-- `system_schema.aggregates` carries the same `argument_types` column.
CREATE FUNCTION probe.sum_state(state int, value int)
  CALLED ON NULL INPUT RETURNS int
  LANGUAGE java AS 'return (state == null ? 0 : state) + (value == null ? 0 : value);';

CREATE AGGREGATE probe.total(int)
  SFUNC sum_state
  STYPE int
  INITCOND 0;

INSERT INTO probe.customers (id, name, city, home) VALUES (1, 'Ada', 'Istanbul', {street: 'Bir', city: 'Istanbul', postcode: '34000'});
INSERT INTO probe.customers (id, name, city, home) VALUES (2, 'Grace', 'Ankara', {street: 'Iki', city: 'Ankara', postcode: '06000'});
INSERT INTO probe.orders (customer_id, order_id, amount) VALUES (1, 10, 25.50);
INSERT INTO probe.events (pk, ck, payload) VALUES (1, 0, 'first');

-- The `trigger` kind is real and this fixture cannot create one with cqlsh alone: a
-- trigger's body is a Java class that must already be loadable on the node, so the step
-- needs a JDK and a file copied into every node's trigger directory. MEASURED on 5.0.9,
-- the full recipe, and it is in docs/providers/cassandra.md too:
--
--   javac --release 17 -cp apache-cassandra-5.0.9.jar -d classes NoopTrigger.java
--   jar cf noop-trigger.jar -C classes .
--   docker cp noop-trigger.jar libredb-cassandra:/etc/cassandra/triggers/
--   docker exec libredb-cassandra nodetool reloadtriggers
--   docker exec libredb-cassandra cqlsh -e \
--     "CREATE TRIGGER probe_audit ON probe.customers USING 'probe.NoopTrigger';"
--
-- `nodetool reloadtriggers` is load-bearing: without it CREATE TRIGGER answers
-- "Trigger class 'probe.NoopTrigger' couldn't be loaded" (measured). The source is
-- beside this file as NoopTrigger.java; no jar is committed.
