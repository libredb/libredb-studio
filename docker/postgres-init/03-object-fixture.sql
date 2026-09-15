-- Object-browser fixture for the PostgreSQL provider (#789).
--
-- One table, and it exists to create a NAME COLLISION ACROSS CONTAINERS. The seeded
-- database already holds app.orders; this adds public.orders, so the two schemas share a
-- last path segment and the flat reading spells them differently: postgres.ts strips the
-- `public` qualifier and keeps every other one, so getSchema() answers `app.orders` for one
-- and a bare `orders` for the other.
--
-- That pair is the only thing that can tell a join that resolves an address from one that
-- merely finds a suffix. With a single schema in play a bare name is a valid suffix of
-- every address, so a provider that had dropped the `app.` qualifier still resolved and the
-- conformance guard still passed; measured, and it is why this file exists. It is also what
-- makes the preferred-container tie-breaker observable: `current_schema()` is `public` on a
-- fresh connection here, so the bare name must land on public.orders and the qualified one
-- on app.orders.
--
-- Applied by the container's own entrypoint, after 01-extensions.sql and 02-sample-data.sql,
-- against the libredb_dev database those two build.
\c libredb_dev

CREATE TABLE IF NOT EXISTS public.orders (
  id   INTEGER PRIMARY KEY,
  note TEXT
);

-- A role holding nothing at all, for the source-read privilege probe recorded in
-- docs/providers/postgres.md (#789). It is the control that makes "PostgreSQL has no
-- unreadable case for object source" a measurement rather than a belief: this role cannot
-- EXECUTE app.order_total and still reads every character of it, because the pg_get_*
-- family applies no privilege check at all.
DROP ROLE IF EXISTS src_probe;
CREATE ROLE src_probe LOGIN PASSWORD 'src_probe';

-- Phase 3 (#789). The object the READ BOUND actually bites, and its control.
--
-- Until this existed, the rule "a part carrying `truncated` is never editable" was a guard over an
-- EMPTY POPULATION on every engine in the fleet: the Phase 1 and Phase 2 conformance fixtures were
-- built short, docs/providers/postgres.md records definitions of 119 to 606 characters, and
-- SOURCE_CHARACTER_LIMIT is 1,000,000. The browser probe built one of 1,275,140 characters by hand
-- and it is the only truncation population that has ever existed for this engine.
--
-- A `DO` block that BUILDS the body rather than a 1.2 MB literal committed into an init script: the
-- file stays small and the object is the same size every time.
DO $fixture$
DECLARE
  filler text := repeat('-- padding for the object source bound, #789' || chr(10), 27000);
BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION app.over_limit_fn(n integer) RETURNS integer LANGUAGE sql AS $body$' ||
          chr(10) || filler || 'SELECT n;' || chr(10) || '$body$';
END
$fixture$;

-- The CONTROL, just UNDER the bound. Without it the truncation assertion cannot distinguish "the
-- bound bit" from "this object is large", which is the difference between a measurement and a
-- coincidence. The browser probe measured the same shape at 975,134 characters.
DO $fixture$
DECLARE
  filler text := repeat('-- padding for the object source bound, #789' || chr(10), 21000);
BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION app.huge_fn(n integer) RETURNS integer LANGUAGE sql AS $body$' ||
          chr(10) || filler || 'SELECT n;' || chr(10) || '$body$';
END
$fixture$;

-- The ownership refusal's population, and the control that makes it non-vacuous (#789 Phase 3).
--
-- MEASURED on 18.4: these grants do NOT make the apply work, because `CREATE OR REPLACE` on
-- somebody else's object is an OWNERSHIP check and not a privilege check. The refusal is
-- `must be owner of function order_total`, SQLSTATE 42501, and the shipped error mapper turns it
-- into an HTTP 500 because the message matches none of its substrings. The CONTROL is in the same
-- session: this same role creating an object OF ITS OWN in this same schema succeeds, so the
-- refusal is about ownership rather than about the schema or the role.
GRANT USAGE ON SCHEMA app TO src_probe;
GRANT CREATE ON SCHEMA app TO src_probe;
