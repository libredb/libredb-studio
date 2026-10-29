-- The same reads and probe under AllowAllAuthorizer: the listing is refused, and a write lands.
LIST ROLES OF 'agent_ro';
LIST ALL PERMISSIONS OF 'agent_ro';
DROP TABLE IF EXISTS "probe".libredb_agent_probe_000000000000000000000000;
INSERT INTO probe.customers (id, name) VALUES (1, 'written-by-a-select-only-role');
SELECT * FROM probe.customers;
