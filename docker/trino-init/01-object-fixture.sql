-- The Trino object-surface fixture (#789).
--
-- Applied by the `trino-init` sidecar in `database-compose.yml`, which runs the CLI that
-- ships in the same image:
--
--   docker compose -f database-compose.yml up -d trino trino-init
--
-- and re-applied by hand after the coordinator restarts:
--
--   docker exec libredb-trino trino --server localhost:8080 \
--     --file /fixtures/01-object-fixture.sql
--
-- THE MEMORY CONNECTOR KEEPS EVERYTHING IN THE COORDINATOR'S HEAP. A restart loses the
-- schema, the tables, the view and the functions together, so this file is written to be
-- re-runnable: every statement is `IF NOT EXISTS` or `OR REPLACE`.
--
-- WHAT THIS FILE COVERS, and what it deliberately does not. It seeds the `memory` half of
-- the surface: the two relation kinds this catalog can hold, and the catalog-stored
-- functions with their overloads. It seeds NO materialized view, because the compose
-- cluster configures no Iceberg catalog and a materialized view needs one. That absence is
-- recorded, with the exact commands that reproduce the Iceberg measurements, in
-- `docs/providers/trino.md`.
--
-- Every statement below was applied through this mount against trinodb/trino:476.

CREATE SCHEMA IF NOT EXISTS memory.app;

-- Two tables, so a relation count is not one row and an ordering assertion has something to
-- order. The server returns them in insertion order, `orders` before `customers`, which is
-- what makes the provider's own sort observable rather than incidental.
CREATE TABLE IF NOT EXISTS memory.app.orders (
  id bigint,
  customer_id bigint,
  total double
);

CREATE TABLE IF NOT EXISTS memory.app.customers (
  id bigint,
  name varchar
);

-- One view. `information_schema.tables` reports it as `table_type = 'VIEW'`, which is the
-- only spelling other than `BASE TABLE` this engine produces, and it is what the `view` kind
-- is counted and listed from.
CREATE OR REPLACE VIEW memory.app.customer_names AS
  SELECT id, name FROM memory.app.customers;

-- Three catalog-stored functions, two of them an OVERLOADED PAIR. Standing ruling 2 (#789)
-- wants the engine's own disambiguated identifier, and `plus_one` alone would give two
-- objects one address: this pair is the fixture that makes the argument-type segment
-- observable instead of theoretical. `label` differs in arity as well as in type, so a
-- segment carrying only the FIRST argument type would still be wrong here.
CREATE OR REPLACE FUNCTION memory.app.plus_one(x bigint)
  RETURNS bigint
  RETURN x + 1;

CREATE OR REPLACE FUNCTION memory.app.plus_one(x double)
  RETURNS double
  RETURN x + 1.0;

CREATE OR REPLACE FUNCTION memory.app.label(id bigint, prefix varchar)
  RETURNS varchar
  RETURN prefix || CAST(id AS varchar);
