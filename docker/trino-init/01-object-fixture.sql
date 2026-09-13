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

-- Three more functions, and none of them is padding: each one defeats a shortcut the
-- source read (#789) would otherwise take. `SHOW CREATE FUNCTION` answers ONE ROW PER
-- OVERLOAD and carries no `Argument Types` column of its own, so the row belonging to a
-- path segment has to be found by comparing the segment's argument types against the
-- parameter list rendered inside each CREATE statement, and the two renderings are NOT the
-- same text. Measured on 476, for `hard`:
--
--   SHOW FUNCTIONS ... `Argument Types`   decimal(10,2), array(varchar), row("a" bigint,"b" varchar)
--   SHOW CREATE FUNCTION ... parameters   amount decimal(10, 2), tags array(varchar), r ROW(a bigint, b varchar)
--
-- three differences in one signature: a space inside `decimal(10, 2)`, `ROW` in upper case
-- against `row`, and field names quoted on one side and bare on the other. A provider
-- comparing the two strings would miss every overload of a type more structured than a
-- scalar, and would then report a function that exists as absent.
CREATE OR REPLACE FUNCTION memory.app.hard(amount decimal(10,2), tags array(varchar), r row(a bigint, b varchar))
  RETURNS varchar
  RETURN CAST(amount AS varchar);

-- The EMPTY argument list, which is the boundary of that comparison: the segment is
-- `answer()` and the rendered parameter list is the empty string, so a matcher that split
-- on commas without a zero-length arm would answer one phantom argument.
CREATE OR REPLACE FUNCTION memory.app.answer()
  RETURNS bigint
  RETURN 42;

-- A function whose NAME carries an open parenthesis. The path segment is `we(ird(bigint)`
-- and the CREATE statement opens `CREATE FUNCTION memory.app."we(ird"(x bigint)`, so the
-- FIRST `(` in either string belongs to the name and not to the parameter list. Both scans
-- have to be quote aware, and this object is what makes that non-vacuous rather than
-- defensive: measured on 476, the name round-trips through `SHOW FUNCTIONS` as `we(ird`.
CREATE OR REPLACE FUNCTION memory.app."we(ird"(x bigint)
  RETURNS bigint
  RETURN x;

-- A ROW FIELD NAME HOLDING A CLOSE PARENTHESIS, which is the object that proves the two
-- quote-aware scans in the source read are load-bearing rather than defensive. Measured on
-- 476 on 2026-09-13, the whole battery: a top-level PARAMETER name may be quoted (`"order"`
-- for a reserved word) but may NOT hold a space, a comma or a parenthesis - all three are
-- refused at creation with a bare `Internal error` - while a ROW FIELD name may hold any of
-- them, and this one round-trips through BOTH renderings:
--
--   SHOW FUNCTIONS ... `Argument Types`   row("a)b" bigint,"c" varchar)
--   SHOW CREATE FUNCTION ... parameters   r ROW("a)b" bigint, c varchar)
--
-- so a scan for the parameter list's matching `)` that was not quote aware would stop at the
-- `)` inside the field name and read the parameter list as `r ROW("a`. Without this object in
-- the fixture, deleting that quote awareness left the whole suite green.
CREATE OR REPLACE FUNCTION memory.app.rowparen(r row("a)b" bigint, c varchar))
  RETURNS bigint
  RETURN 1;
