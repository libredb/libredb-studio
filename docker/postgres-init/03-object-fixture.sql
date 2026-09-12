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
